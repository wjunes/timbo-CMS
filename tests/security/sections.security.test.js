/**
 * Pruebas de seguridad de la administración de secciones: un section_admin no
 * escribe, solo ve sus secciones, y no puede inyectar valores fuera del catálogo.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

let app;
let api;
let editor;
let editorApi;

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
  const user = await app.createUser({ username: 'editor' });
  await api.json(`/api/users/${user.id}/sections/2`, { method: 'PUT' });
  await api.json(`/api/users/${user.id}/sections/2/permissions`, {
    method: 'PUT', body: { permissions: ['content.create', 'content.edit', 'content.publish'] },
  });
  editor = user;
  editorApi = app.as(await app.login('editor'));
});
afterEach(() => app.stop());

const WRITES = [
  ['POST', '/api/sections', { name: 'Propia', type: 'news' }],
  ['PATCH', '/api/sections/2', { workflow: 'direct' }],
  ['PATCH', '/api/sections/2', { presentation: 'grid' }],
  ['DELETE', '/api/sections/2'],
  ['POST', '/api/sections/2/archive'],
  ['POST', '/api/sections/2/deactivate'],
  ['POST', '/api/sections/1/activate'],
  ['PUT', '/api/sections/order', { parentId: null, ids: [2, 1, 3, 4, 5] }],
];

describe('seguridad de secciones', () => {
  for (const [method, path, body] of WRITES) {
    it(`un section_admin no puede ${method} ${path} (403, auditado, sin efectos)`, async () => {
      const before = JSON.stringify(app.db.prepare('SELECT * FROM sections ORDER BY id').all());
      const r = await editorApi.json(path, { method, body });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'forbidden');
      assert.equal(JSON.stringify(app.db.prepare('SELECT * FROM sections ORDER BY id').all()), before);
      const denied = app.db.prepare("SELECT actor_user_id FROM audit_logs WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1").get();
      assert.equal(denied.actor_user_id, editor.id);
    });
  }

  it('un section_admin solo ve sus secciones; las demás responden 404', async () => {
    const list = await editorApi.json('/api/sections');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.sections.map((s) => s.slug), ['noticias']);
    assert.equal((await editorApi.json('/api/sections/2')).status, 200);
    for (const id of [1, 3, 999]) assert.equal((await editorApi.json(`/api/sections/${id}`)).status, 404);
  });

  it('al retirar la asignación deja de ver la sección', async () => {
    await api.json(`/api/users/${editor.id}/sections/2`, { method: 'DELETE' });
    assert.deepEqual((await editorApi.json('/api/sections')).body.sections, []);
    assert.equal((await editorApi.json('/api/sections/2')).status, 404);
  });

  it('los catálogos son legibles con sesión y no admiten escritura', async () => {
    assert.equal((await editorApi.json('/api/section-types')).status, 200);
    assert.equal((await editorApi.json('/api/presentations')).status, 200);
    assert.equal((await api.json('/api/presentations', { method: 'POST', body: { code: 'html' } })).status, 405);
    assert.equal((await api.json('/api/section-types', { method: 'POST', body: { code: 'blog' } })).status, 405);
  });

  it('sin sesión no se accede a nada de secciones', async () => {
    for (const path of ['/api/sections', '/api/sections/2', '/api/section-types', '/api/presentations']) {
      assert.equal((await app.request(path)).status, 401);
    }
  });

  it('el general_admin no puede inyectar presentaciones, flujos, tipos ni marcas del sistema', async () => {
    const injections = [
      { presentation: '<script>alert(1)</script>' },
      { presentation: '../../templates/evil' },
      { workflow: 'none' },
      { isSystem: true },
      { is_system: 1 },
      { status: 'archived' },
      { sectionTypeId: 1 },
      { sortOrder: -1 },
      { createdBy: 1 },
      { parentId: '1 OR 1=1' },
    ];
    for (const extra of injections) {
      const r = await api.json('/api/sections', { method: 'POST', body: { name: 'Inyección', type: 'news', ...extra } });
      assert.equal(r.status, 400, JSON.stringify(extra));
    }
    // JSON en bruto: "__proto__" llega como propiedad propia y se rechaza como campo desconocido.
    const proto = await api.json('/api/sections', { method: 'POST', body: '{"name":"Ok","type":"news","__proto__":{"isSystem":true}}' });
    assert.equal(proto.status, 400);
    assert.deepEqual(Object.entries(proto.body.fields), [['__proto__', 'unknown_field']]);
    const patch = await api.json('/api/sections/1', { method: 'PATCH', body: { isSystem: false } });
    assert.equal(patch.status, 400);
    assert.equal(app.db.prepare('SELECT is_system FROM sections WHERE id = 1').get().is_system, 1);
  });

  it('un slug con caracteres de ruta o HTML se rechaza; el nombre se guarda como texto', async () => {
    for (const slug of ['../admin', 'a/b', '<b>', 'ADMIN', 'a b', '%2e%2e']) {
      const r = await api.json('/api/sections', { method: 'POST', body: { name: 'X', type: 'news', slug } });
      assert.deepEqual(r.body.fields, { slug: 'invalid_format' }, slug);
    }
    const r = await api.json('/api/sections', { method: 'POST', body: { name: '<img src=x onerror=alert(1)>', type: 'news' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.section.name, '<img src=x onerror=alert(1)>');
    assert.equal(r.body.section.slug, 'img-src-x-onerror-alert-1');
  });

  it('las escrituras exigen el token CSRF', async () => {
    const session = await app.login('admin');
    const r = await app.request('/api/sections', { method: 'POST', cookie: session.cookie, body: { name: 'Sin token', type: 'news' } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'invalid_csrf_token');
  });
});
