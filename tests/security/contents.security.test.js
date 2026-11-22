/**
 * Seguridad del motor de contenidos: aislamiento entre secciones, permisos
 * concedidos en el backend, asignación masiva e inyección en el cuerpo.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

const NEWS = 2; // asignada al editor
const ARTICLES = 3; // no asignada

let app;
let api; // general_admin

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

/** section_admin asignado a NEWS con los permisos indicados. */
async function editorWith(permissions, username = `ed${Math.random().toString(36).slice(2, 8)}`) {
  const user = await app.createUser({ username });
  assert.equal((await api.json(`/api/users/${user.id}/sections/${NEWS}`, { method: 'PUT' })).status, 201);
  assert.equal((await api.json(`/api/users/${user.id}/sections/${NEWS}/permissions`, { method: 'PUT', body: { permissions } })).status, 200);
  return { user, client: app.as(await app.login(username)) };
}

async function adminContent(section = NEWS, title = 'Del administrador') {
  const r = await api.json(`/api/sections/${section}/contents`, { method: 'POST', body: { title } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const lastDenied = () =>
  app.db.prepare("SELECT actor_user_id, section_id, details FROM audit_logs WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1").get();

describe('seguridad de contenidos: aislamiento entre secciones', () => {
  it('un section_admin no ve ni modifica contenidos de secciones no asignadas (404, sin efectos)', async () => {
    const { client } = await editorWith(['content.create', 'content.edit', 'content.delete']);
    const { content, version } = await adminContent(ARTICLES);
    const base = `/api/contents/${content.id}`;
    const attempts = [
      ['GET', `/api/sections/${ARTICLES}/contents`],
      ['POST', `/api/sections/${ARTICLES}/contents`, { title: 'Intruso' }],
      ['GET', base],
      ['PATCH', base, { slug: 'secuestrado' }],
      ['DELETE', base],
      ['GET', `${base}/versions`],
      ['POST', `${base}/versions`, {}],
      ['GET', `${base}/versions/${version.id}`],
      ['PATCH', `${base}/versions/${version.id}`, { revision: 1, title: 'Alterado' }],
      ['DELETE', `${base}/versions/${version.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await client.json(path, { method, body });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.body.error, 'not_found');
    }
    const after = (await api.json(`${base}/versions/${version.id}`)).body.version;
    assert.equal(after.title, 'Del administrador');
    assert.equal(after.revision, 1);
    assert.equal((await api.json(base)).body.content.slug, 'del-administrador');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM contents').get().n, 1);
  });

  it('la desasignación retira el acceso de inmediato', async () => {
    const { user, client } = await editorWith(['content.create']);
    assert.equal((await client.json(`/api/sections/${NEWS}/contents`)).status, 200);
    assert.equal((await api.json(`/api/users/${user.id}/sections/${NEWS}`, { method: 'DELETE' })).status, 204);
    assert.equal((await client.json(`/api/sections/${NEWS}/contents`)).status, 404);
  });

  it('un contenido eliminado no es visible para nadie a través de la API', async () => {
    const { client } = await editorWith(['content.delete']);
    const { content } = await adminContent();
    assert.equal((await client.json(`/api/contents/${content.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await client.json(`/api/contents/${content.id}`)).status, 404);
    assert.equal((await api.json(`/api/contents/${content.id}`)).status, 404);
  });
});

describe('seguridad de contenidos: permisos', () => {
  it('ver la sección asignada no exige permisos, pero escribir sí (403 auditado, sin efectos)', async () => {
    const { user, client } = await editorWith([]);
    const { content, version } = await adminContent();
    assert.equal((await client.json(`/api/sections/${NEWS}/contents`)).status, 200);
    assert.equal((await client.json(`/api/contents/${content.id}/versions/${version.id}`)).status, 200);

    const cases = [
      ['POST', `/api/sections/${NEWS}/contents`, { title: 'X' }, 'content.create'],
      ['PATCH', `/api/contents/${content.id}`, { slug: 'x' }, 'content.edit'],
      ['DELETE', `/api/contents/${content.id}`, undefined, 'content.delete'],
      ['PATCH', `/api/contents/${content.id}/versions/${version.id}`, { revision: 1, title: 'X' }, 'content.edit'],
      ['DELETE', `/api/contents/${content.id}/versions/${version.id}`, undefined, 'content.edit'],
    ];
    for (const [method, path, body, permission] of cases) {
      const r = await client.json(path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      const denied = lastDenied();
      assert.equal(denied.actor_user_id, user.id);
      assert.equal(denied.section_id, NEWS);
      assert.deepEqual(JSON.parse(denied.details), { method, path, permission });
    }
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM contents').get().n, 1);
    assert.equal((await api.json(`/api/contents/${content.id}/versions/${version.id}`)).body.version.revision, 1);
  });

  it('con solo content.create el autor edita sus borradores, pero no los ajenos ni crea versiones', async () => {
    const { client } = await editorWith(['content.create']);
    const own = (await client.json(`/api/sections/${NEWS}/contents`, { method: 'POST', body: { title: 'Mío' } })).body;
    const r = await client.json(`/api/contents/${own.content.id}/versions/${own.version.id}`, {
      method: 'PATCH', body: { revision: 1, title: 'Mío corregido' },
    });
    assert.equal(r.status, 200);

    const other = await adminContent();
    const foreign = await client.json(`/api/contents/${other.content.id}/versions/${other.version.id}`, {
      method: 'PATCH', body: { revision: 1, title: 'Ajeno' },
    });
    assert.equal(foreign.status, 403);
    assert.equal((await client.json(`/api/contents/${own.content.id}`, { method: 'PATCH', body: { slug: 'otro' } })).status, 403);
  });

  it('con content.edit se editan borradores ajenos y se crean versiones', async () => {
    const { client } = await editorWith(['content.edit']);
    const other = await adminContent();
    const r = await client.json(`/api/contents/${other.content.id}/versions/${other.version.id}`, {
      method: 'PATCH', body: { revision: 1, title: 'Revisado por el editor' },
    });
    assert.equal(r.status, 200);
    assert.equal((await client.json(`/api/sections/${NEWS}/contents`, { method: 'POST', body: { title: 'X' } })).status, 403);
  });

  it('con la contraseña temporal pendiente no se opera con contenidos', async () => {
    const { user } = await editorWith(['content.create']);
    app.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id);
    const client = app.as(await app.login(user.username));
    assert.equal((await client.json(`/api/sections/${NEWS}/contents`)).status, 403);
  });
});

describe('seguridad de contenidos: asignación masiva', () => {
  it('no se fijan estado, autoría, sección ni punteros desde el cliente', async () => {
    const forged = [
      { title: 'X', status: 'published' },
      { title: 'X', publishedVersionId: 1 },
      { title: 'X', createdBy: 1 },
      { title: 'X', sectionId: ARTICLES },
      { title: 'X', revision: 9 },
    ];
    for (const body of forged) {
      const r = await api.json(`/api/sections/${NEWS}/contents`, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(Object.values(r.body.fields)[0], 'unknown_field');
    }
    const { content, version } = await adminContent();
    for (const body of [{ revision: 1, status: 'published' }, { revision: 1, versionNumber: 7 }, { revision: 1, createdBy: 99 }]) {
      const r = await api.json(`/api/contents/${content.id}/versions/${version.id}`, { method: 'PATCH', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const raw = await api.json(`/api/contents/${content.id}/versions/${version.id}`, {
      method: 'PATCH', body: '{"revision":1,"title":"Y","__proto__":{"status":"published"}}',
    });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.fields.__proto__, 'unknown_field');
    assert.equal(app.db.prepare('SELECT status FROM content_versions WHERE id = ?').get(version.id).status, 'draft');
  });
});

describe('seguridad de contenidos: inyección en el cuerpo', () => {
  const para = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });

  it('rechaza nodos, atributos y enlaces ejecutables', async () => {
    const { content, version } = await adminContent();
    const payloads = [
      [{ type: 'doc', content: [{ type: 'script', content: [] }] }, 'unknown_node'],
      [{ type: 'doc', content: [{ type: 'iframe', attrs: { src: 'https://evil.example' } }] }, 'unknown_node'],
      [{ type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }] }, 'unknown_attribute'],
      [{ type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'background:url(javascript:alert(1))' } }] }, 'unknown_attribute'],
      [{ type: 'doc', content: [para('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])] }, 'link_href_not_allowed'],
      [{ type: 'doc', content: [para('x', [{ type: 'link', attrs: { href: 'data:text/html,<script>alert(1)</script>' } }])] }, 'link_href_invalid'],
      [{ type: 'doc', content: [para('x', [{ type: 'link', attrs: { href: '//evil.example' } }])] }, 'link_href_not_allowed'],
      [{ type: 'doc', content: [para('x', [{ type: 'link', attrs: { href: '/ok', class: 'x" onmouseover="alert(1)' } }])] }, 'invalid_attribute_value'],
      [{ type: 'doc', content: [], html: '<img src=x onerror=alert(1)>' }, 'unknown_property'],
      ['<p onclick="alert(1)">hola</p>', 'invalid_node'],
    ];
    for (const [body, code] of payloads) {
      const r = await api.json(`/api/contents/${content.id}/versions/${version.id}`, { method: 'PATCH', body: { revision: 1, body } });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.fields.body, code, JSON.stringify(body));
    }
    assert.equal(app.db.prepare('SELECT revision, body FROM content_versions WHERE id = ?').get(version.id).body, '{"type":"doc","content":[]}');
  });

  it('el marcado dentro del texto se guarda como texto y se devuelve como JSON', async () => {
    const { content, version } = await adminContent();
    const text = '<script>alert(1)</script> & "comillas"';
    const r = await api(`/api/contents/${content.id}/versions/${version.id}`, {
      method: 'PATCH', body: { revision: 1, title: '<img src=x onerror=alert(1)>', body: { type: 'doc', content: [para(text)] } },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const saved = (await r.json()).version;
    assert.equal(saved.body.content[0].content[0].text, text);
    assert.equal(saved.title, '<img src=x onerror=alert(1)>');
  });

  it('sin X-CSRF-Token no se guarda un borrador', async () => {
    const { content, version } = await adminContent();
    const session = await app.login('admin');
    const r = await app.request(`/api/contents/${content.id}/versions/${version.id}`, {
      method: 'PATCH', cookie: session.cookie, body: { revision: 1, title: 'CSRF' },
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'invalid_csrf_token');
  });
});
