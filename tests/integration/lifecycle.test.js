/**
 * Prueba integral (Bloque 11): el ciclo completo entre módulos, con una base en
 * archivo y el servidor HTTP real, como en producción.
 *
 * general_admin crea un administrador de sección y le da permisos → este entra,
 * cambia su contraseña temporal, sube una imagen y crea un contenido → lo envía a
 * revisión → general_admin lo aprueba y lo publica → el sitio público lo muestra
 * con su imagen → copia de seguridad → se despublica y se cambia el nombre del
 * sitio → se restaura la copia con el servidor detenido → todo vuelve al estado
 * de la copia, las sesiones quedan cerradas y la auditoría sigue íntegra.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../../backend/app.js';
import { loadConfig } from '../../backend/config/index.js';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';
import { createPasswordHasher } from '../../backend/modules/auth/password.js';
import { restoreBackup } from '../../backend/modules/backups/restore.js';
import { createLogger } from '../../backend/utils/logger.js';
import { removeDir, tempDir } from '../helpers/db.js';
import { FAST_PARAMS } from '../helpers/http.js';
import { makePng } from '../helpers/media.js';

const ADMIN_PASSWORD = 'clave-del-administrador-general';
const TEMP_PASSWORD = 'temporal-de-la-cuenta-1';
const EDITOR_PASSWORD = 'definitiva-de-la-cuenta-2';

describe('ciclo completo del CMS', () => {
  const dir = tempDir();
  const hasher = createPasswordHasher({ params: FAST_PARAMS });
  const silent = createLogger({ level: 'error', write: () => {} });
  let config;
  let db;
  let server;
  let base;

  async function start() {
    db = openDatabase(config.databasePath, { create: false });
    server = createServer({ config, logger: silent, db, passwordHasher: hasher });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    closeDatabase(db);
  }

  /** Cliente HTTP con su propia sesión, como un navegador. */
  function client() {
    let cookie = null;
    let csrf = null;
    const send = async (p, { method = 'GET', body, raw, type, name } = {}) => {
      const headers = { origin: new URL(config.baseUrl).origin };
      if (cookie) headers.cookie = cookie;
      if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
      let payload;
      if (raw) {
        headers['content-type'] = type;
        headers['x-file-name'] = encodeURIComponent(name);
        payload = raw;
      } else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(`${base}${p}`, { method, headers, body: payload, redirect: 'manual' });
      const text = await res.text();
      const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
      return { status: res.status, body: data };
    };
    send.login = async (username, password) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(config.baseUrl).origin }, body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      cookie = res.headers.get('set-cookie').split(';')[0];
      csrf = body.csrfToken;
      return body;
    };
    return send;
  }
  const ok = (r, status = 200) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body;
  };

  before(async () => {
    config = loadConfig({
      NODE_ENV: 'test', PORT: '3000', DATABASE_PATH: path.join(dir, 'cms.db'), STORAGE_DIR: path.join(dir, 'storage'),
      BACKUP_INTERVAL_HOURS: '0',
    });
    const setup = openDatabase(config.databasePath);
    migrate(setup);
    setup.prepare("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('admin', 'admin@example.org', 'Admin', ?, 'general_admin')")
      .run(await hasher.hash(ADMIN_PASSWORD));
    closeDatabase(setup);
    await start();
  });
  after(async () => {
    if (server?.listening) await stop();
    removeDir(dir);
  });

  it('del alta de una editora a la restauración de una copia', async () => {
    const admin = client();
    await admin.login('admin', ADMIN_PASSWORD);

    // 1. Alta de la editora con permisos en Noticias (flujo con aprobación).
    const { user } = ok(await admin('/api/users', { method: 'POST', body: {
      username: 'editora', email: 'editora@example.org', displayName: 'Editora', temporaryPassword: TEMP_PASSWORD,
    } }), 201);
    ok(await admin(`/api/users/${user.id}/sections/2`, { method: 'PUT' }), 201);
    ok(await admin(`/api/users/${user.id}/sections/2/permissions`, { method: 'PUT', body: { permissions: ['content.create', 'content.submit', 'media.upload'] } }));

    // 2. La editora entra y está obligada a cambiar la contraseña temporal.
    const editor = client();
    const first = await editor.login('editora', TEMP_PASSWORD);
    assert.equal(first.user.mustChangePassword, true);
    assert.equal((await editor('/api/sections')).body.error, 'password_change_required');
    ok(await editor('/api/auth/password', { method: 'POST', body: { currentPassword: TEMP_PASSWORD, newPassword: EDITOR_PASSWORD } }));
    await editor.login('editora', EDITOR_PASSWORD);
    assert.deepEqual(ok(await editor('/api/sections')).sections.map((s) => s.id), [2]);
    // Solo su sección: en otra, ni lectura.
    assert.equal((await editor('/api/sections/3/contents')).status, 404);

    // 3. Sube una imagen y crea el contenido con ella.
    const { media } = ok(await editor('/api/sections/2/media', { method: 'POST', raw: makePng({ width: 30, height: 20 }), type: 'image/png', name: 'foto.png' }), 201);
    const doc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Abre el plazo de inscripción.' }] },
      { type: 'image', attrs: { mediaId: media.id, alt: 'Cartel' } },
    ] };
    const { content, version } = ok(await editor('/api/sections/2/contents', { method: 'POST', body: { title: 'Abre el plazo', summary: 'Inscripciones', body: doc } }), 201);
    const v = `/api/contents/${content.id}/versions/${version.id}`;

    // 4. No puede publicar directamente: la sección exige aprobación.
    assert.equal((await editor(`${v}/publish`, { method: 'POST', body: { revision: 1 } })).status, 403);
    ok(await editor(`${v}/submit`, { method: 'POST', body: { revision: 1 } }));
    assert.equal((await client()(`/noticias/${content.slug}`)).status, 404, 'aún no es público');

    // 5. El administrador general lo ve en la cola, lo aprueba y lo publica.
    const { pending } = ok(await admin('/api/reviews/pending'));
    assert.deepEqual(pending.map((p) => p.version.id), [version.id]);
    ok(await admin(`${v}/approve`, { method: 'POST', body: { comment: 'Adelante' } }));
    ok(await admin(`${v}/publish`, { method: 'POST', body: {} }));

    // 6. El sitio público lo muestra, con su imagen servida.
    const anon = client();
    const page = await anon(`/noticias/${content.slug}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('Abre el plazo de inscripción.'));
    assert.ok(page.body.includes(`/media/${media.id}`));
    assert.equal((await anon(`/media/${media.id}`)).status, 200);
    assert.ok((await anon('/sitemap.xml')).body.includes(`/noticias/${content.slug}`));

    // 7. Copia de seguridad desde la API.
    const { backup } = ok(await admin('/api/backups', { method: 'POST' }), 201);
    assert.equal(backup.mediaCount, 1);

    // 8. Cambios posteriores: se despublica y se cambia el nombre del sitio.
    ok(await admin(`/api/contents/${content.id}/unpublish`, { method: 'POST', body: {} }));
    ok(await admin('/api/settings', { method: 'PATCH', body: { siteName: 'Nombre posterior' } }));
    assert.equal((await anon(`/noticias/${content.slug}`)).status, 404);
    assert.equal((await anon(`/media/${media.id}`)).status, 404);

    // 9. Restauración con el servidor detenido.
    await stop();
    const restored = await restoreBackup({ config, id: backup.id, logger: silent, clock: () => Date.now() + 2000 });
    assert.ok(restored.revokedCount >= 2);
    await start();

    // 10. Todo vuelve al estado de la copia; las sesiones anteriores ya no valen.
    assert.equal((await anon(`/noticias/${content.slug}`)).status, 200);
    assert.equal((await anon(`/media/${media.id}`)).status, 200);
    assert.ok(!(await anon('/')).body.includes('Nombre posterior'));
    assert.equal((await admin('/api/auth/session')).status, 401);
    assert.equal((await editor('/api/sections')).status, 401);

    // 11. La auditoría cuenta la historia y sigue íntegra.
    await admin.login('admin', ADMIN_PASSWORD);
    const verify = ok(await admin('/api/audit/verify'));
    assert.equal(verify.ok, true, JSON.stringify(verify.problems));
    const actions = ok(await admin('/api/audit?limit=200')).entries.map((e) => e.action);
    for (const a of ['user.create', 'permission.set', 'user.password_change', 'media.upload', 'content.create', 'version.submit',
      'version.approve', 'version.publish', 'backup.restore']) {
      assert.ok(actions.includes(a), `falta ${a} en la auditoría`);
    }
    // Lo descartado por la restauración no está en la base, pero sí en la copia previa.
    assert.ok(!actions.includes('settings.update'));
    assert.ok(fs.existsSync(path.join(config.storageDir, 'backups', restored.safetyBackupId, 'manifest.json')));
  });
});
