/**
 * Pruebas de seguridad de autorización: escalada de privilegios, acceso a la
 * administración, contraseña temporal, cambio de contraseña y revocación.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

const TEMP = 'temporal-inicial-123';
const FINAL = 'mi-contraseña-definitiva';

let app;
let api;

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

/** Crea un editor, cambia su contraseña temporal y devuelve su cliente. */
async function activeEditor(username = 'editor') {
  const created = await api.json('/api/users', {
    method: 'POST',
    body: { username, email: `${username}@example.org`, displayName: 'E', temporaryPassword: TEMP },
  });
  const first = await app.login(username, TEMP);
  const change = await app.as(first).json('/api/auth/password', { method: 'POST', body: { currentPassword: TEMP, newPassword: FINAL } });
  assert.equal(change.status, 200);
  return { id: created.body.user.id, session: first, client: app.as(first) };
}

describe('seguridad: administración solo para general_admin', () => {
  it('un section_admin recibe 403 en toda la API de administración, y queda auditado', async () => {
    const { client, id } = await activeEditor();
    const attempts = [
      ['/api/users', 'GET'],
      ['/api/users', 'POST', { username: 'nuevo', email: 'n@example.org', displayName: 'N', temporaryPassword: TEMP }],
      [`/api/users/${id}`, 'GET'],
      [`/api/users/${id}`, 'PATCH', { displayName: 'yo' }],
      [`/api/users/${id}/sections/2`, 'PUT'],
      [`/api/users/${id}/sections/2/permissions`, 'PUT', { permissions: ['content.publish'] }],
      ['/api/permissions', 'GET'],
    ];
    for (const [path, method, body] of attempts) {
      const r = await client.json(path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error, 'forbidden');
    }
    const denied = app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'access.denied' AND actor_user_id = ?").get(id).n;
    assert.equal(denied, attempts.length);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_sections').get().n, 0, 'no se concedió nada');
  });

  it('sin sesión, la administración responde 401', async () => {
    assert.equal((await app.request('/api/users')).status, 401);
  });

  it('el CSRF también protege la administración', async () => {
    const r = await app.request('/api/users', {
      method: 'POST',
      cookie: (await app.login('admin')).cookie,
      body: { username: 'x-csrf', email: 'x@example.org', displayName: 'X', temporaryPassword: TEMP },
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'invalid_csrf_token');
  });
});

describe('seguridad: contraseña temporal', () => {
  it('con contraseña temporal solo puede ver su sesión, cambiarla o salir', async () => {
    await api.json('/api/users', { method: 'POST', body: { username: 'novata', email: 'n@example.org', displayName: 'N', temporaryPassword: TEMP } });
    const s = await app.login('novata', TEMP);
    assert.equal(s.body.user.mustChangePassword, true);
    const client = app.as(s);

    assert.equal((await client.json('/api/auth/session')).status, 200);
    const blocked = await client.json('/api/users');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'password_change_required');

    const change = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: TEMP, newPassword: FINAL } });
    assert.equal(change.status, 200);
    const me = await client.json('/api/auth/session');
    assert.equal(me.body.user.mustChangePassword, false);
    assert.equal((await client.json('/api/users')).body.error, 'forbidden', 'sigue sin ser general_admin');
  });
});

describe('seguridad: cambio de la propia contraseña', () => {
  it('exige la contraseña actual, aplica la política y no admite repetirla', async () => {
    const { client } = await activeEditor();
    const wrong = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: 'no-es-la-mia-123', newPassword: 'otra-contraseña-larga' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'invalid_current_password');
    const weak = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: FINAL, newPassword: 'corta' } });
    assert.equal(weak.status, 400);
    const same = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: FINAL, newPassword: FINAL } });
    assert.equal(same.status, 400);
    assert.match(same.body.policy.join(), /distinta/);
  });

  it('limita los intentos con contraseña actual incorrecta', async () => {
    const { client } = await activeEditor();
    for (let i = 0; i < 5; i++) {
      await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: `mala-${i}-contraseña`, newPassword: 'otra-contraseña-larga' } });
    }
    const r = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: FINAL, newPassword: 'otra-contraseña-larga' } });
    assert.equal(r.status, 429);
  });

  it('revoca las demás sesiones y conserva la actual', async () => {
    const { client, session } = await activeEditor();
    const other = await app.login('editor', FINAL);
    const r = await client.json('/api/auth/password', { method: 'POST', body: { currentPassword: FINAL, newPassword: 'nueva-contraseña-larga' } });
    assert.equal(r.body.revokedCount, 1);
    assert.equal((await app.request('/api/auth/session', { cookie: other.cookie })).status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: session.cookie })).status, 200);
    const audit = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'user.password_change' AND outcome = 'success'").all();
    for (const row of audit) assert.ok(!row.details.includes(FINAL) && !row.details.includes('nueva-contraseña-larga'));
  });
});

describe('seguridad: suspensión y alcance', () => {
  it('suspender a un editor corta sus sesiones activas al instante', async () => {
    const { id, session } = await activeEditor();
    assert.equal((await app.request('/api/auth/session', { cookie: session.cookie })).status, 200);
    const r = await api.json(`/api/users/${id}/suspend`, { method: 'POST' });
    assert.equal(r.body.revokedCount, 1);
    assert.equal((await app.request('/api/auth/session', { cookie: session.cookie })).status, 401);
    assert.equal((await app.login('editor', FINAL)).res.status, 401);
  });

  it('la sesión informa solo las secciones y permisos realmente concedidos', async () => {
    const { id, client } = await activeEditor();
    await api.json(`/api/users/${id}/sections/2`, { method: 'PUT' });
    await api.json(`/api/users/${id}/sections/2/permissions`, { method: 'PUT', body: { permissions: ['content.create', 'media.upload'] } });
    const me = await client.json('/api/auth/session');
    assert.deepEqual(me.body.access.scope, 'sections');
    assert.deepEqual(
      me.body.access.sections.map(({ id: sid, slug, permissions }) => ({ sid, slug, permissions })),
      [{ sid: 2, slug: 'noticias', permissions: ['content.create', 'media.upload'] }],
    );
  });
});
