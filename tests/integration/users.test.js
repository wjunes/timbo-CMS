import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

const TEMP = 'temporal-inicial-123';

let app;
let api;
let admin;

beforeEach(async () => {
  app = await startApp();
  ({ admin, api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const lastAudit = (action) =>
  app.db.prepare('SELECT actor_user_id, entity_id, section_id, outcome, details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

async function createEditor(username = 'editora') {
  const r = await api.json('/api/users', {
    method: 'POST',
    body: { username, email: `${username}@example.org`, displayName: 'Editora', temporaryPassword: TEMP },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user;
}

describe('API de usuarios', () => {
  it('crea un section_admin con contraseña temporal y lo audita', async () => {
    const user = await createEditor();
    assert.equal(user.role, 'section_admin');
    assert.equal(user.status, 'active');
    assert.equal(user.mustChangePassword, true);
    assert.deepEqual(user.sections, []);
    assert.equal(user.passwordHash, undefined);
    assert.ok(!JSON.stringify(user).includes('argon2'));
    const row = lastAudit('user.create');
    assert.equal(row.actor_user_id, admin.id);
    assert.deepEqual(JSON.parse(row.details), { role: 'section_admin', username: 'editora' });
    assert.ok(!row.details.includes(TEMP));
  });

  it('valida la entrada y rechaza campos no permitidos', async () => {
    const bad = await api.json('/api/users', {
      method: 'POST',
      body: { username: 'x', email: 'no', displayName: '', temporaryPassword: TEMP, role: 'general_admin' },
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.fields, { role: 'unknown_field', username: 'too_short', email: 'invalid_format', displayName: 'too_short' });

    const weak = await api.json('/api/users', {
      method: 'POST',
      body: { username: 'debil', email: 'debil@example.org', displayName: 'D', temporaryPassword: 'corta' },
    });
    assert.equal(weak.status, 400);
    assert.deepEqual(weak.body.fields, { temporaryPassword: 'policy' });
  });

  it('rechaza usuario o email duplicados (sin distinguir mayúsculas)', async () => {
    await createEditor('editora');
    for (const body of [
      { username: 'EDITORA', email: 'otro@example.org', displayName: 'X', temporaryPassword: TEMP },
      { username: 'otra', email: 'Editora@Example.org', displayName: 'X', temporaryPassword: TEMP },
    ]) {
      const r = await api.json('/api/users', { method: 'POST', body });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'username_or_email_taken');
    }
  });

  it('lista y detalla usuarios con sus secciones', async () => {
    const user = await createEditor();
    const list = await api.json('/api/users');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.users.map((u) => u.username).sort(), ['admin', 'editora']);
    const one = await api.json(`/api/users/${user.id}`);
    assert.equal(one.body.user.email, 'editora@example.org');
    assert.equal((await api.json('/api/users/9999')).status, 404);
    assert.equal((await api.json('/api/users/abc')).status, 404);
  });

  it('PATCH cambia nombre y email, no el usuario ni el rol', async () => {
    const user = await createEditor();
    const ok = await api.json(`/api/users/${user.id}`, { method: 'PATCH', body: { displayName: 'Nueva', email: 'nueva@example.org' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.displayName, 'Nueva');
    assert.deepEqual(JSON.parse(lastAudit('user.update').details), { fields: ['displayName', 'email'] });

    for (const body of [{ username: 'otro' }, { role: 'general_admin' }, { status: 'active' }, {}]) {
      const r = await api.json(`/api/users/${user.id}`, { method: 'PATCH', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  it('suspender, reactivar y desactivar siguen las transiciones válidas y revocan sesiones', async () => {
    const user = await createEditor();
    const suspended = await api.json(`/api/users/${user.id}/suspend`, { method: 'POST' });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.user.status, 'suspended');
    assert.equal((await api.json(`/api/users/${user.id}/suspend`, { method: 'POST' })).status, 409);
    assert.equal((await api.json(`/api/users/${user.id}/reactivate`, { method: 'POST' })).body.user.status, 'active');
    const disabled = await api.json(`/api/users/${user.id}/disable`, { method: 'POST' });
    assert.equal(disabled.body.user.status, 'disabled');
    for (const action of ['reactivate', 'suspend', 'disable']) {
      const r = await api.json(`/api/users/${user.id}/${action}`, { method: 'POST' });
      assert.equal(r.status, 409, action);
      assert.equal(r.body.error, 'invalid_status_transition');
    }
    assert.deepEqual(JSON.parse(lastAudit('user.status_change').details), { from: 'active', to: 'disabled', revokedCount: 0 });
  });

  it('el general_admin no se gestiona por la API', async () => {
    const id = admin.id;
    const attempts = [
      [`/api/users/${id}`, 'PATCH', { displayName: 'X' }],
      [`/api/users/${id}/suspend`, 'POST'],
      [`/api/users/${id}/disable`, 'POST'],
      [`/api/users/${id}/password`, 'POST', { temporaryPassword: TEMP }],
      [`/api/users/${id}/sessions/revoke`, 'POST'],
      [`/api/users/${id}/sections/2`, 'PUT'],
    ];
    for (const [path, method, body] of attempts) {
      const r = await api.json(path, { method, body });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error, 'target_protected');
    }
    assert.equal((await api.json(`/api/users/${id}`)).status, 200, 'la lectura sí está permitida');
  });

  it('fijar una contraseña temporal obliga a cambiarla y revoca las sesiones', async () => {
    const user = await createEditor();
    const r = await api.json(`/api/users/${user.id}/password`, { method: 'POST', body: { temporaryPassword: 'otra-temporal-456' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.mustChangePassword, true);
    assert.equal((await app.login('editora', TEMP)).res.status, 401);
    assert.equal((await app.login('editora', 'otra-temporal-456')).res.status, 200);
    assert.ok(!lastAudit('user.password_reset').details.includes('otra-temporal-456'));
  });

  it('revoca todas las sesiones de un usuario', async () => {
    const user = await createEditor();
    const s = await app.login('editora', TEMP);
    const r = await api.json(`/api/users/${user.id}/sessions/revoke`, { method: 'POST' });
    assert.deepEqual(r.body, { revokedCount: 1 });
    assert.equal((await app.request('/api/auth/session', { cookie: s.cookie })).status, 401);
  });
});

describe('API de permisos', () => {
  it('expone el catálogo de 9 permisos', async () => {
    const r = await api.json('/api/permissions');
    assert.deepEqual(
      r.body.permissions.map((p) => p.code),
      ['content.archive', 'content.create', 'content.delete', 'content.edit', 'content.publish', 'content.submit', 'content.unpublish', 'media.delete', 'media.upload'],
    );
  });

  it('asigna una sección (idempotente), fija permisos y retira la sección', async () => {
    const user = await createEditor();
    const base = `/api/users/${user.id}/sections/2`;
    assert.equal((await api.json(base, { method: 'PUT' })).status, 201);
    assert.equal((await api.json(base, { method: 'PUT' })).status, 200);
    assert.equal(lastAudit('permission.section_assign').section_id, 2);

    const set = await api.json(`${base}/permissions`, { method: 'PUT', body: { permissions: ['content.edit', 'content.create'] } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body, { permissions: ['content.create', 'content.edit'], changed: true });

    const again = await api.json(`${base}/permissions`, { method: 'PUT', body: { permissions: ['content.create'] } });
    assert.deepEqual(again.body.permissions, ['content.create']);
    assert.deepEqual(JSON.parse(lastAudit('permission.set').details), {
      before: ['content.create', 'content.edit'], after: ['content.create'], added: [], removed: ['content.edit'],
    });

    const detail = await api.json(`/api/users/${user.id}`);
    assert.deepEqual(detail.body.user.sections.map((s) => [s.slug, s.permissions]), [['noticias', ['content.create']]]);

    assert.equal((await api.json(base, { method: 'DELETE' })).status, 204);
    assert.deepEqual(JSON.parse(lastAudit('permission.section_revoke').details), { before: ['content.create'] });
    assert.equal((await api.json(base, { method: 'DELETE' })).status, 404);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_section_permissions').get().n, 0);
  });

  it('valida permisos, sección y estado del usuario', async () => {
    const user = await createEditor();
    const base = `/api/users/${user.id}/sections/2`;
    assert.equal((await api.json(`${base}/permissions`, { method: 'PUT', body: { permissions: ['content.create'] } })).body.error, 'section_not_assigned');
    await api.json(base, { method: 'PUT' });
    const bad = await api.json(`${base}/permissions`, { method: 'PUT', body: { permissions: ['admin.all'] } });
    assert.equal(bad.status, 400);
    assert.equal((await api.json(`/api/users/${user.id}/sections/999`, { method: 'PUT' })).body.error, 'section_not_found');

    app.db.prepare("UPDATE sections SET status = 'archived' WHERE id = 3").run();
    assert.equal((await api.json(`/api/users/${user.id}/sections/3`, { method: 'PUT' })).body.error, 'section_archived');

    await api.json(`/api/users/${user.id}/disable`, { method: 'POST' });
    assert.equal((await api.json(`/api/users/${user.id}/sections/4`, { method: 'PUT' })).body.error, 'user_disabled');
  });
});
