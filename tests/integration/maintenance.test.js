/**
 * Bloque 10: purga controlada de archivos y configuración general del sitio.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { expectSqliteError } from '../helpers/db.js';
import { startApp } from '../helpers/http.js';
import { makePng, upload } from '../helpers/media.js';

let app;
let api;
beforeEach(async () => {
  app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0' } });
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const mediaDir = () => path.join(app.config.storageDir, 'media');
const HOUR = 3_600_000;

/** Envejece un archivo y adelanta el reloj para que cuente como antiguo. */
function age(name) {
  const old = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(path.join(mediaDir(), name), old, old);
}

async function uploaded() {
  const r = await upload(api, 2, makePng());
  assert.equal(r.status, 201);
  const key = app.db.prepare('SELECT storage_key FROM media WHERE id = ?').get(r.body.media.id).storage_key;
  return { id: r.body.media.id, key };
}

const del = async (id) => assert.equal((await api.json(`/api/media/${id}`, { method: 'DELETE' })).status, 204);

describe('purga de archivos', () => {
  it('lista y purga archivos eliminados sin uso, huérfanos y temporales antiguos; lo audita', async () => {
    const gone = await uploaded();
    await del(gone.id);
    const kept = await uploaded();
    fs.writeFileSync(path.join(mediaDir(), 'd'.repeat(32)), 'huérfano');
    fs.writeFileSync(path.join(mediaDir(), '.tmp-0123456789abcdef'), 'resto');
    fs.writeFileSync(path.join(mediaDir(), 'e'.repeat(32)), 'reciente');
    fs.writeFileSync(path.join(mediaDir(), 'LEEME.txt'), 'ajeno');
    for (const n of ['d'.repeat(32), '.tmp-0123456789abcdef', 'LEEME.txt']) age(n);

    const preview = (await api.json('/api/media/purge')).body;
    assert.deepEqual(preview.deleted.map((m) => m.id), [gone.id]);
    assert.equal(preview.deleted[0].storageKey, undefined);
    assert.deepEqual(preview.orphans.map((o) => o.name), ['d'.repeat(32)]);
    assert.deepEqual(preview.temporary.map((t) => t.name), ['.tmp-0123456789abcdef']);

    const r = await api.json('/api/media/purge', {
      method: 'POST', body: { mediaIds: [gone.id], orphans: ['d'.repeat(32)], temporary: ['.tmp-0123456789abcdef'] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { purged: { media: 1, orphans: 1, temporary: 1 }, failed: [] });
    assert.deepEqual(fs.readdirSync(mediaDir()).sort(), ['LEEME.txt', 'e'.repeat(32), kept.key].sort());
    // La fila se conserva, marcada como purgada.
    assert.equal(app.db.prepare('SELECT status FROM media WHERE id = ?').get(gone.id).status, 'deleted');
    assert.ok(app.db.prepare('SELECT 1 FROM media_purges WHERE media_id = ?').get(gone.id));
    const audit = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'media.purge'").get();
    assert.deepEqual(JSON.parse(audit.details).mediaIds, [gone.id]);
    // El archivo purgado ya no se sirve ni entra en las copias.
    assert.equal((await api.json(`/api/media/${gone.id}/file`)).status, 404);
    const b = await app.server.backups.create();
    assert.equal(b.mediaCount, 1);
    assert.deepEqual(b.warnings, []);
  });

  it('no purga lo que sigue en uso, aunque sea por una versión antigua o un contenido eliminado', async () => {
    const m = await uploaded();
    const body = { type: 'doc', content: [{ type: 'image', attrs: { mediaId: m.id, alt: 'x' } }] };
    const c = await api.json('/api/sections/2/contents', { method: 'POST', body: { title: 'Con imagen', body } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await api.json(`/api/contents/${c.body.content.id}`, { method: 'DELETE' })).status, 204);
    await del(m.id);
    assert.deepEqual((await api.json('/api/media/purge')).body.deleted, []);
    const r = await api.json('/api/media/purge', { method: 'POST', body: { mediaIds: [m.id] } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'purge_candidates_changed');
    assert.ok(fs.existsSync(path.join(mediaDir(), m.key)));
    // La base lo impide también.
    const admin = app.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    expectSqliteError(assert, () => app.db.prepare('INSERT INTO media_purges (media_id, purged_by) VALUES (?, ?)').run(m.id, admin), 'media_not_purgeable');
  });

  it('rechaza un archivo activo, uno reciente o nombres fuera del directorio', async () => {
    const active = await uploaded();
    fs.writeFileSync(path.join(mediaDir(), 'c'.repeat(32)), 'reciente');
    let r = await api.json('/api/media/purge', { method: 'POST', body: { mediaIds: [active.id] } });
    assert.equal(r.status, 409);
    r = await api.json('/api/media/purge', { method: 'POST', body: { orphans: ['c'.repeat(32)] } });
    assert.equal(r.status, 409);
    r = await api.json('/api/media/purge', { method: 'POST', body: { orphans: [active.key] } });
    assert.equal(r.status, 409);
    for (const bad of [['../cms.lock'], ['..\\x'], ['LEEME.txt'], 'x', [1]]) {
      r = await api.json('/api/media/purge', { method: 'POST', body: { orphans: bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await api.json('/api/media/purge', { method: 'POST', body: {} })).status, 400);
    assert.equal((await api.json('/api/media/purge', { method: 'POST', body: { otra: 1 } })).status, 400);
    assert.ok(fs.existsSync(path.join(mediaDir(), active.key)));
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'media.purge'").get().n, 0);
  });

  it('un archivo purgado no puede volver a usarse en un borrador', async () => {
    const m = await uploaded();
    await del(m.id);
    assert.equal((await api.json('/api/media/purge', { method: 'POST', body: { mediaIds: [m.id] } })).status, 200);
    const c = await api.json('/api/sections/2/contents', { method: 'POST', body: { title: 'Sin imagen' } });
    const versionId = c.body.version.id;
    expectSqliteError(assert, () => app.db.prepare('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)').run(versionId, m.id), 'media_not_available');
  });

  it('solo el administrador general purga', async () => {
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    assert.equal((await other.json('/api/media/purge')).status, 403);
    assert.equal((await other.json('/api/media/purge', { method: 'POST', body: { orphans: [] } })).status, 403);
  });
});

describe('configuración del sitio', () => {
  it('consulta y cambia el nombre y la descripción; el sitio público los muestra escapados', async () => {
    let r = await api.json('/api/settings');
    assert.deepEqual(r.body.settings, { siteName: 'CMS-MULTISECCIÓN', siteDescription: 'Sitio institucional', sitePalette: 'azul' });

    r = await api.json('/api/settings', { method: 'PATCH', body: { siteName: '  Ayuntamiento <b>Sur</b>  ', siteDescription: '' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings, { siteName: 'Ayuntamiento <b>Sur</b>', siteDescription: '', sitePalette: 'azul' });

    const html = await (await app.request('/')).text();
    assert.ok(html.includes('Ayuntamiento &lt;b&gt;Sur&lt;/b&gt;'));
    assert.ok(!html.includes('<b>Sur</b>'));

    const audit = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'settings.update'").all();
    assert.equal(audit.length, 1);
    assert.deepEqual(JSON.parse(audit[0].details), {
      before: { siteName: 'CMS-MULTISECCIÓN', siteDescription: 'Sitio institucional' },
      after: { siteName: 'Ayuntamiento <b>Sur</b>', siteDescription: '' },
    });
    // Sin cambios reales no se audita.
    await api.json('/api/settings', { method: 'PATCH', body: { siteDescription: '' } });
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'settings.update'").get().n, 1);
  });

  it('valida los campos y rechaza los desconocidos', async () => {
    for (const body of [{}, { siteName: '' }, { siteName: 'x'.repeat(121) }, { siteDescription: 'x'.repeat(301) },
      { siteName: 3 }, { siteName: 'a\u0000b' }, { 'site.name': 'x' }, { theme: '<script>' }]) {
      const r = await api.json('/api/settings', { method: 'PATCH', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  it('solo el administrador general la consulta o la cambia', async () => {
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    assert.equal((await other.json('/api/settings')).status, 403);
    assert.equal((await other.json('/api/settings', { method: 'PATCH', body: { siteName: 'x' } })).status, 403);
  });
});
