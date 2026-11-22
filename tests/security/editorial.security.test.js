/**
 * Seguridad del flujo editorial: solo el general_admin aprueba, nadie publica
 * sin aprobación en secciones 'approval', permisos por sección en el backend,
 * aislamiento entre secciones y sin asignación masiva de estados ni autoría.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

const NEWS = 2; // asignada al editor, flujo 'approval'
const ARTICLES = 3; // no asignada

let app;
let api; // general_admin

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const ALL = ['content.create', 'content.edit', 'content.submit', 'content.publish', 'content.unpublish', 'content.archive', 'content.delete'];

async function editorWith(permissions, section = NEWS) {
  const username = `ed${Math.random().toString(36).slice(2, 8)}`;
  const user = await app.createUser({ username });
  assert.equal((await api.json(`/api/users/${user.id}/sections/${section}`, { method: 'PUT' })).status, 201);
  assert.equal((await api.json(`/api/users/${user.id}/sections/${section}/permissions`, { method: 'PUT', body: { permissions } })).status, 200);
  return { user, client: app.as(await app.login(username)) };
}

async function adminContent(section = NEWS, title = 'Del administrador') {
  const r = await api.json(`/api/sections/${section}/contents`, { method: 'POST', body: { title } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const v = (c, ver, action) => `/api/contents/${c}/versions/${ver}/${action}`;
const lastDenied = () => {
  const row = app.db.prepare("SELECT actor_user_id, section_id, details FROM audit_logs WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1").get();
  return row && { ...row, details: JSON.parse(row.details) };
};
const statusOf = (id) => app.db.prepare('SELECT status FROM content_versions WHERE id = ?').get(id).status;
const reviewCount = () => app.db.prepare('SELECT count(*) AS n FROM publication_reviews').get().n;

describe('seguridad editorial: aprobación reservada al general_admin', () => {
  it('un section_admin con todos los permisos no aprueba, no solicita cambios ni ve la cola (403 auditado)', async () => {
    const { user, client } = await editorWith(ALL);
    const { content, version } = await adminContent();
    assert.equal((await client.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } })).status, 200);

    for (const [action, b] of [['approve', {}], ['request-changes', { comment: 'x' }]]) {
      const r = await client.json(v(content.id, version.id, action), { method: 'POST', body: b });
      assert.equal(r.status, 403, action);
      const denied = lastDenied();
      assert.equal(denied.actor_user_id, user.id);
      assert.equal(denied.details.requiredRole, 'general_admin');
    }
    assert.equal((await client.json('/api/reviews/pending')).status, 403);
    assert.equal(statusOf(version.id), 'pending_review');
    assert.equal(reviewCount(), 0);
  });

  it('con content.publish no publica un borrador ni una versión pendiente en secciones approval', async () => {
    const { client } = await editorWith(ALL);
    const { content, version } = await client.json(`/api/sections/${NEWS}/contents`, { method: 'POST', body: { title: 'Propio' } })
      .then((r) => r.body);
    const draft = await client.json(v(content.id, version.id, 'publish'), { method: 'POST', body: { revision: 1 } });
    assert.equal(draft.body.error, 'approval_required');
    await client.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    const pending = await client.json(v(content.id, version.id, 'publish'), { method: 'POST', body: {} });
    assert.equal(pending.body.error, 'invalid_transition');
    assert.equal(statusOf(version.id), 'pending_review');

    // Tras la aprobación del general_admin, sí puede publicarla (D-040).
    assert.equal((await api.json(v(content.id, version.id, 'approve'), { method: 'POST', body: {} })).status, 200);
    assert.equal((await client.json(v(content.id, version.id, 'publish'), { method: 'POST', body: {} })).status, 200);
  });
});

describe('seguridad editorial: permisos por sección', () => {
  it('cada transición exige su permiso (403 auditado con el permiso que faltaba, sin efectos)', async () => {
    const { client } = await editorWith(['content.create', 'content.edit']);
    const { content, version } = await adminContent();
    const submit = await client.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    assert.equal(submit.status, 403);
    assert.equal(lastDenied().details.permission, 'content.submit');
    assert.equal(lastDenied().section_id, NEWS);

    await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    await api.json(v(content.id, version.id, 'approve'), { method: 'POST', body: {} });
    assert.equal((await client.json(v(content.id, version.id, 'publish'), { method: 'POST', body: {} })).status, 403);
    assert.equal(lastDenied().details.permission, 'content.publish');
    assert.equal(statusOf(version.id), 'approved');

    await api.json(v(content.id, version.id, 'publish'), { method: 'POST', body: {} });
    for (const [path, permission] of [
      [`/api/contents/${content.id}/unpublish`, 'content.unpublish'],
      [`/api/contents/${content.id}/archive`, 'content.archive'],
    ]) {
      assert.equal((await client.json(path, { method: 'POST' })).status, 403, path);
      assert.equal(lastDenied().details.permission, permission);
    }
    await api.json(`/api/contents/${content.id}/archive`, { method: 'POST' });
    assert.equal((await client.json(`/api/contents/${content.id}/restore`, { method: 'POST' })).status, 403);
    assert.equal(lastDenied().details.permission, 'content.archive');
    assert.equal(app.db.prepare('SELECT status FROM contents WHERE id = ?').get(content.id).status, 'archived');
  });

  it('un section_admin no actúa sobre contenidos de secciones no asignadas (404, sin efectos)', async () => {
    const { client } = await editorWith(ALL);
    const { content, version } = await adminContent(ARTICLES);
    await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    const attempts = [
      ['POST', v(content.id, version.id, 'submit'), { revision: 1 }],
      ['POST', v(content.id, version.id, 'publish'), {}],
      ['GET', v(content.id, version.id, 'reviews')],
      ['POST', `/api/contents/${content.id}/unpublish`],
      ['POST', `/api/contents/${content.id}/archive`],
      ['POST', `/api/contents/${content.id}/restore`],
    ];
    for (const [method, path, b] of attempts) {
      assert.equal((await client.json(path, { method, body: b })).status, 404, `${method} ${path}`);
    }
    assert.equal(statusOf(version.id), 'pending_review');
  });

  it('un section_admin asignado ve las revisiones de su sección (para corregir)', async () => {
    const { client } = await editorWith(['content.create']);
    const { content, version } = await adminContent();
    await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    await api.json(v(content.id, version.id, 'request-changes'), { method: 'POST', body: { comment: 'Revisar el título' } });
    const r = await client.json(v(content.id, version.id, 'reviews'));
    assert.equal(r.status, 200);
    assert.equal(r.body.reviews[0].comment, 'Revisar el título');
  });

  it('una versión de otro contenido no se alcanza cambiando el identificador de la ruta', async () => {
    const a = await adminContent(NEWS, 'A');
    const b = await adminContent(NEWS, 'B');
    const r = await api.json(v(a.content.id, b.version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    assert.equal(r.status, 404);
    assert.equal(statusOf(b.version.id), 'draft');
  });
});

describe('seguridad editorial: entradas', () => {
  it('no se asignan estados, autoría ni decisiones desde el cuerpo', async () => {
    const { content, version } = await adminContent();
    const sub = await api.json(v(content.id, version.id, 'submit'), {
      method: 'POST', body: { revision: 1, status: 'published', submittedBy: 99 },
    });
    assert.equal(sub.status, 400);
    assert.equal(statusOf(version.id), 'draft');
    await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    const appr = await api.json(v(content.id, version.id, 'approve'), {
      method: 'POST', body: { comment: 'ok', decision: 'changes_requested', reviewerId: 5 },
    });
    assert.equal(appr.status, 400);
    const proto = await api.json(v(content.id, version.id, 'approve'), { method: 'POST', body: JSON.parse('{"__proto__": {"x": 1}}') });
    assert.equal(proto.status, 400);
    assert.equal(statusOf(version.id), 'pending_review');
  });

  it('el comentario se valida (longitud y caracteres de control) y se guarda como texto', async () => {
    const { content, version } = await adminContent();
    await api.json(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 } });
    const path = v(content.id, version.id, 'request-changes');
    assert.equal((await api.json(path, { method: 'POST', body: { comment: 'x'.repeat(5001) } })).body.fields.comment, 'too_long');
    assert.equal((await api.json(path, { method: 'POST', body: { comment: 'a\u0000b' } })).body.fields.comment, 'invalid_characters');
    const html = '<script>alert(1)</script>';
    assert.equal((await api.json(path, { method: 'POST', body: { comment: html } })).status, 200);
    const r = await api.json(v(content.id, version.id, 'reviews'));
    assert.equal(r.body.reviews[0].comment, html);
    assert.match(r.res.headers.get('content-type'), /^application\/json/);
  });

  it('las transiciones exigen el token CSRF', async () => {
    const { content, version } = await adminContent();
    const session = await app.login('admin');
    const r = await app.request(v(content.id, version.id, 'submit'), { method: 'POST', body: { revision: 1 }, cookie: session.cookie });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'invalid_csrf_token');
    assert.equal(statusOf(version.id), 'draft');
  });
});
