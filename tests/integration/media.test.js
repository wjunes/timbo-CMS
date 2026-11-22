/**
 * Multimedia (Bloque 08): subida, biblioteca, envío al panel, referencias desde
 * el cuerpo, protección de los archivos en uso y vista previa.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';
import { makeJpeg, makePdf, makePng, upload } from '../helpers/media.js';

let app;
let api; // general_admin

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const NEWS = 2; // flujo 'approval'

async function call(path, { method = 'POST', body, client = api, expected = 200, headers } = {}) {
  const r = await client.json(path, { method, body, headers });
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function uploadOk(sectionId = NEWS, buffer = makePng(), opts = {}) {
  const r = await upload(api, sectionId, buffer, opts);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.media;
}

const doc = (...content) => ({ type: 'doc', content });
const p = (...content) => ({ type: 'paragraph', content });
const img = (mediaId, alt = '') => ({ type: 'image', attrs: { mediaId, alt } });
const docLink = (mediaId) => p({ type: 'text', text: 'documento', marks: [{ type: 'link', attrs: { href: `/media/${mediaId}` } }] });
const refs = (versionId) => app.db.prepare('SELECT media_id FROM content_media WHERE content_version_id = ? ORDER BY media_id').all(versionId).map((r) => r.media_id);
const v = (c, ver, action = '') => `/api/contents/${c}/versions/${ver}${action ? `/${action}` : ''}`;

async function directSection(name = 'Avisos') {
  return (await call('/api/sections', { body: { name, type: 'news', workflow: 'direct' }, expected: 201 })).section.id;
}

describe('multimedia: subida', () => {
  it('guarda el archivo con clave aleatoria fuera de lo público, sin metadatos, y lo audita', async () => {
    const png = makePng({ width: 3, height: 2, text: 'GPS 40.41N' });
    const media = await uploadOk(NEWS, png, { name: 'Fachada.png' });
    assert.equal(media.originalName, 'Fachada.png');
    assert.deepEqual([media.kind, media.mimeType, media.extension, media.width, media.height], ['image', 'image/png', 'png', 3, 2]);
    assert.equal(media.fileUrl, `/api/media/${media.id}/file`);
    assert.equal(media.storageKey, undefined, 'la clave de almacenamiento no se expone');

    const row = app.db.prepare('SELECT * FROM media WHERE id = ?').get(media.id);
    assert.match(row.storage_key, /^[0-9a-f]{32}$/);
    const file = path.join(app.config.storageDir, 'media', row.storage_key);
    const stored = fs.readFileSync(file);
    assert.equal(stored.includes(Buffer.from('GPS')), false, 'sin metadatos');
    assert.equal(row.sha256, createHash('sha256').update(stored).digest('hex'));
    assert.equal(row.size_bytes, stored.length);
    assert.equal(media.sizeBytes, stored.length);
    assert.equal(fs.readdirSync(path.join(app.config.storageDir, 'media')).length, 1, 'sin temporales');

    const audit = app.db.prepare("SELECT entity_id, section_id, details FROM audit_logs WHERE action = 'media.upload'").get();
    assert.equal(audit.entity_id, media.id);
    assert.equal(audit.section_id, NEWS);
    assert.deepEqual(JSON.parse(audit.details), { mimeType: 'image/png', sizeBytes: stored.length, metadataRemoved: true });
  });

  it('acepta JPEG (con .jpg y .jpeg) y PDF', async () => {
    assert.equal((await uploadOk(NEWS, makeJpeg(), { type: 'image/jpeg', name: 'a.jpg' })).kind, 'image');
    assert.equal((await uploadOk(NEWS, makeJpeg(), { type: 'image/jpeg', name: 'b.JPEG' })).extension, 'jpeg');
    const pdf = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'Bases 2027.pdf' });
    assert.deepEqual([pdf.kind, pdf.width, pdf.height], ['document', null, null]);
  });

  it('rechaza tipos no admitidos, extensiones que no coinciden y archivos vacíos', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    let r = await upload(api, NEWS, svg, { type: 'image/svg+xml', name: 'logo.svg' });
    assert.equal(r.status, 415);
    assert.deepEqual(r.body.allowed, ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
    assert.equal((await upload(api, NEWS, makePng(), { type: 'image/gif', name: 'a.gif' })).status, 415);
    r = await upload(api, NEWS, makePng(), { type: 'image/png', name: 'foto.jpg' });
    assert.deepEqual([r.status, r.body.fields], [400, { fileName: 'extension_mismatch' }]);
    r = await upload(api, NEWS, makePng(), { type: 'image/png', name: 'foto.php' });
    assert.deepEqual([r.status, r.body.fields], [400, { fileName: 'extension_mismatch' }]);
    r = await upload(api, NEWS, Buffer.alloc(0), { type: 'image/png', name: 'vacia.png' });
    assert.deepEqual([r.status, r.body.fields], [400, { file: 'empty' }]);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM media').get().n, 0);
  });

  it('rechaza (422) un archivo cuyo contenido real no es el declarado, y lo audita como fallo', async () => {
    const r = await upload(api, NEWS, Buffer.from('<?php system($_GET["c"]); ?>'), { type: 'image/png', name: 'shell.png' });
    assert.deepEqual([r.status, r.body], [422, { error: 'file_rejected', reason: 'content_mismatch' }]);
    const a = app.db.prepare("SELECT outcome, details FROM audit_logs WHERE action = 'media.upload'").get();
    assert.equal(a.outcome, 'failure');
    assert.equal(JSON.parse(a.details).reason, 'content_mismatch');
    assert.equal(fs.existsSync(path.join(app.config.storageDir, 'media')) ? fs.readdirSync(path.join(app.config.storageDir, 'media')).length : 0, 0);
  });

  it('no admite subidas en una sección archivada', async () => {
    const id = await directSection();
    await call(`/api/sections/${id}/archive`, {});
    assert.equal((await upload(api, id, makePng())).body.error, 'section_archived');
  });
});

describe('multimedia: biblioteca', () => {
  it('lista los archivos activos de la sección, del más reciente al más antiguo', async () => {
    const a = await uploadOk(NEWS, makePng(), { name: 'a.png' });
    const b = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'b.pdf' });
    const other = await directSection();
    await uploadOk(other, makePng(), { name: 'otra.png' });
    const { media } = await call(`/api/sections/${NEWS}/media`, { method: 'GET' });
    assert.deepEqual(media.map((m) => m.id), [b.id, a.id]);
  });

  it('edita el texto alternativo (auditado) y valida su longitud', async () => {
    const m = await uploadOk();
    const { media } = await call(`/api/media/${m.id}`, { method: 'PATCH', body: { altText: '  Fachada principal  ' } });
    assert.equal(media.altText, 'Fachada principal');
    const audit = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'media.update'").get();
    assert.deepEqual(JSON.parse(audit.details), { fields: ['altText'] });
    const r = await api.json(`/api/media/${m.id}`, { method: 'PATCH', body: { altText: 'x'.repeat(501) } });
    assert.deepEqual([r.status, r.body.fields], [400, { altText: 'too_long' }]);
    assert.equal((await api.json(`/api/media/${m.id}`, { method: 'PATCH', body: { storageKey: 'x', altText: 'a' } })).body.fields.storageKey, 'unknown_field');
  });

  it('sirve el archivo con su tipo, sin interpretación y en un sandbox', async () => {
    const m = await uploadOk(NEWS, makePng(), { name: 'Año "nuevo".png' });
    const res = await api(`/api/media/${m.id}/file`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('content-disposition'), `inline; filename="A_o _nuevo_.png"; filename*=UTF-8''A%C3%B1o%20%22nuevo%22.png`);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, m.sizeBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), m.sha256);

    const pdf = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'bases.pdf' });
    const res2 = await api(`/api/media/${pdf.id}/file`);
    assert.equal(res2.headers.get('content-type'), 'application/pdf');
    assert.match(res2.headers.get('content-disposition'), /^attachment;/);
  });

  it('un registro sin su archivo en disco responde 404 y queda registrado en el log', async () => {
    const m = await uploadOk();
    const key = app.db.prepare('SELECT storage_key FROM media WHERE id = ?').get(m.id).storage_key;
    fs.rmSync(path.join(app.config.storageDir, 'media', key));
    assert.equal((await api(`/api/media/${m.id}/file`)).status, 404);
    assert.ok(app.logs.some((l) => l.includes('Falta el archivo de un registro multimedia')));
  });
});

describe('multimedia: referencias desde el cuerpo', () => {
  it('al crear y guardar un borrador registra sus imágenes y documentos en content_media', async () => {
    const a = await uploadOk();
    const b = await uploadOk();
    const pdf = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'x.pdf' });
    const { content, version } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Con imagen', body: doc(img(a.id, 'A'), img(a.id)) }, expected: 201 });
    assert.deepEqual(refs(version.id), [a.id]);
    await call(v(content.id, version.id), { method: 'PATCH', body: { revision: 1, body: doc(img(b.id), docLink(pdf.id)) } });
    assert.deepEqual(refs(version.id), [b.id, pdf.id]);
    await call(v(content.id, version.id), { method: 'PATCH', body: { revision: 2, title: 'Solo título' } });
    assert.deepEqual(refs(version.id), [b.id, pdf.id], 'sin cuerpo nuevo, las referencias no cambian');
  });

  it('rechaza archivos inexistentes, eliminados, de otra sección o que no son imágenes, indicando dónde', async () => {
    const other = await directSection();
    const foreign = await uploadOk(other);
    const pdf = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'x.pdf' });
    const gone = await uploadOk();
    await call(`/api/media/${gone.id}`, { method: 'DELETE', expected: 204 });
    const cases = [
      [doc(p(), img(999_999)), 'media_not_available', '/content/1/attrs/mediaId', 999_999],
      [doc(img(foreign.id)), 'media_not_available', '/content/0/attrs/mediaId', foreign.id],
      [doc(img(gone.id)), 'media_not_available', '/content/0/attrs/mediaId', gone.id],
      [doc(docLink(foreign.id)), 'media_not_available', '/content/0/content/0/marks/0/attrs/href', foreign.id],
      [doc(img(pdf.id)), 'media_not_image', '/content/0/attrs/mediaId', pdf.id],
    ];
    for (const [body, code, bodyPath, mediaId] of cases) {
      const r = await api.json(`/api/sections/${NEWS}/contents`, { method: 'POST', body: { title: 'x', body } });
      assert.deepEqual([r.status, r.body.fields, r.body.bodyPath, r.body.mediaId], [400, { body: code }, bodyPath, mediaId], code);
    }
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM contents').get().n, 0);
  });

  it('una versión nueva hereda las referencias de la versión de origen', async () => {
    const id = await directSection();
    const m = await uploadOk(id);
    const { content, version } = await call(`/api/sections/${id}/contents`, { body: { title: 'x', body: doc(img(m.id)) }, expected: 201 });
    await call(v(content.id, version.id, 'publish'), { body: { revision: 1 } });
    const { version: v2 } = await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 });
    assert.deepEqual(refs(v2.id), [m.id]);
  });
});

describe('multimedia: eliminar archivos en uso', () => {
  it('no se elimina un archivo que usa una versión publicada, en borrador, en revisión o aprobada', async () => {
    const m = await uploadOk();
    const { content, version } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Noticia', body: doc(img(m.id)) }, expected: 201 });
    const tryDelete = async (status) => {
      const r = await api.json(`/api/media/${m.id}`, { method: 'DELETE' });
      assert.deepEqual([r.status, r.body.error], [409, 'media_in_use'], status);
      assert.deepEqual(r.body.usage.map((u) => u.version.status), [status]);
      assert.equal(r.body.usage[0].content.id, content.id);
    };
    await tryDelete('draft');
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    await tryDelete('pending_review');
    await call(v(content.id, version.id, 'approve'), { body: {} });
    await tryDelete('approved');
    await call(v(content.id, version.id, 'publish'), { body: {} });
    await tryDelete('published');
    const { usage } = await call(`/api/media/${m.id}`, { method: 'GET' });
    assert.equal(usage[0].version.title, 'Noticia');
    assert.equal(app.db.prepare('SELECT status FROM media WHERE id = ?').get(m.id).status, 'active');
  });

  it('cuando solo lo usan versiones archivadas se elimina (lógicamente); el archivo físico se conserva', async () => {
    const id = await directSection();
    const m = await uploadOk(id);
    const { content, version } = await call(`/api/sections/${id}/contents`, { body: { title: 'x', body: doc(img(m.id)) }, expected: 201 });
    await call(v(content.id, version.id, 'publish'), { body: { revision: 1 } });
    await call(`/api/contents/${content.id}/unpublish`, {});
    await call(`/api/media/${m.id}`, { method: 'DELETE', expected: 204 });
    const row = app.db.prepare('SELECT status, deleted_by, storage_key FROM media WHERE id = ?').get(m.id);
    assert.equal(row.status, 'deleted');
    assert.ok(fs.existsSync(path.join(app.config.storageDir, 'media', row.storage_key)));
    assert.equal((await api(`/api/media/${m.id}`)).status, 404);
    assert.equal((await api(`/api/media/${m.id}/file`)).status, 404);
    assert.ok(app.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'media.delete' AND entity_id = ?").get(m.id));

    // Un borrador nuevo desde la versión archivada no puede publicarse con el archivo eliminado.
    const { version: v2 } = await call(`/api/contents/${content.id}/versions`, { body: { basedOnVersionId: version.id }, expected: 201 });
    const r = await api.json(v(content.id, v2.id, 'publish'), { method: 'POST', body: { revision: 1 } });
    assert.deepEqual([r.status, r.body.error, r.body.mediaId, r.body.bodyPath], [409, 'media_not_available', m.id, '/content/0/attrs/mediaId']);
  });

  it('el contenido eliminado no impide eliminar sus archivos', async () => {
    const m = await uploadOk();
    const { content } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'x', body: doc(img(m.id)) }, expected: 201 });
    await call(`/api/contents/${content.id}`, { method: 'DELETE', expected: 204 });
    await call(`/api/media/${m.id}`, { method: 'DELETE', expected: 204 });
  });

  it('enviar a revisión vuelve a comprobar los archivos', async () => {
    const m = await uploadOk();
    const { content, version } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'x', body: doc(img(m.id)) }, expected: 201 });
    // Simula un archivo eliminado por otra vía tras guardar (la base no lo permitiría con la referencia: se quita antes).
    app.db.prepare('DELETE FROM content_media WHERE content_version_id = ?').run(version.id);
    app.db.prepare("UPDATE media SET status = 'deleted', deleted_by = 1, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(m.id);
    const r = await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    assert.deepEqual([r.status, r.body.error], [409, 'media_not_available']);
    assert.equal(app.db.prepare('SELECT status FROM content_versions WHERE id = ?').get(version.id).status, 'draft');
  });
});

describe('vista previa', () => {
  it('devuelve el HTML seguro del cuerpo sin guardar nada, con las URL del panel', async () => {
    const m = await uploadOk(NEWS, makePng({ width: 8, height: 6 }));
    const { content, version } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'x' }, expected: 201 });
    const body = doc({ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: '<b>Hola</b>' }] }, img(m.id, 'Foto'), docLink(m.id));
    const { html } = await call(`/api/contents/${content.id}/preview`, { body: { body } });
    assert.equal(html, `<h2 class="align-center">&lt;b&gt;Hola&lt;/b&gt;</h2><img src="/api/media/${m.id}/file" alt="Foto" width="8" height="6" loading="lazy" decoding="async"><p><a href="/api/media/${m.id}/file">documento</a></p>`);
    assert.equal(app.db.prepare('SELECT revision FROM content_versions WHERE id = ?').get(version.id).revision, 1);
  });

  it('valida el cuerpo igual que al guardar', async () => {
    const { content } = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'x' }, expected: 201 });
    let r = await api.json(`/api/contents/${content.id}/preview`, { method: 'POST', body: { body: doc({ type: 'iframe' }) } });
    assert.deepEqual([r.status, r.body.fields], [400, { body: 'unknown_node' }]);
    r = await api.json(`/api/contents/${content.id}/preview`, { method: 'POST', body: { body: doc(img(424242)) } });
    assert.deepEqual([r.status, r.body.fields], [400, { body: 'media_not_available' }]);
    r = await api.json(`/api/contents/${content.id}/preview`, { method: 'POST', body: { body: doc(), extra: 1 } });
    assert.deepEqual(r.body.fields, { extra: 'unknown_field' });
  });
});
