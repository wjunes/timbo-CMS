import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PASSWORD, startApp } from '../helpers/http.js';

describe('autenticación HTTP', () => {
  let app;
  let admin;
  let editor;

  before(async () => {
    app = await startApp();
    admin = await app.createUser({ role: 'general_admin', username: 'admin' });
    editor = await app.createUser({ username: 'editor' });
  });
  after(() => app.stop());

  const audit = (action) =>
    app.db.prepare('SELECT actor_user_id, outcome, details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

  describe('POST /api/auth/login', () => {
    it('con credenciales correctas emite una cookie de sesión segura y devuelve el usuario y el token CSRF', async () => {
      const { res, body, setCookie } = await app.login('admin');
      assert.equal(res.status, 200);
      assert.deepEqual(body.user, { id: admin.id, username: 'admin', displayName: 'Usuario admin', role: 'general_admin', mustChangePassword: false });
      assert.deepEqual(body.access, { scope: 'all' });
      assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
      assert.match(setCookie, /^cms_session=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict; Max-Age=28800; HttpOnly$/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(body).includes(setCookie.split(';')[0].split('=')[1]), 'el token no viaja en el cuerpo');
    });

    it('el usuario no distingue mayúsculas', async () => {
      assert.equal((await app.login('ADMIN')).res.status, 200);
    });

    it('registra el login correcto en la auditoría', async () => {
      await app.login('editor');
      const row = audit('auth.login');
      assert.equal(row.actor_user_id, editor.id);
      assert.equal(row.outcome, 'success');
    });

    it('contraseña incorrecta, usuario inexistente y usuario suspendido devuelven el mismo 401 genérico', async () => {
      const suspended = await app.createUser({ status: 'suspended' });
      const responses = [
        await app.login('editor', 'otra-contraseña-mala'),
        await app.login('no-existe', PASSWORD),
        await app.login(suspended.username, PASSWORD),
      ];
      for (const { res, body, setCookie } of responses) {
        assert.equal(res.status, 401);
        assert.deepEqual(body, { error: 'invalid_credentials' });
        assert.equal(setCookie, null);
      }
    });

    it('registra los fallos sin guardar el usuario probado si no existe', async () => {
      await app.login('usuario-fantasma', 'una-contraseña-cualquiera');
      const row = audit('auth.login');
      assert.equal(row.outcome, 'failure');
      assert.equal(row.actor_user_id, null);
      assert.deepEqual(JSON.parse(row.details), { reason: 'unknown_user' });
    });

    it('valida el cuerpo: tipo, JSON, campos y tamaño', async () => {
      const cases = [
        [{ body: 'username=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415, 'unsupported_media_type'],
        [{ body: '{mal json' }, 400, 'invalid_json'],
        [{ body: { username: 'admin' } }, 400, 'invalid_request'],
        [{ body: { username: ['admin'], password: PASSWORD } }, 400, 'invalid_request'],
        [{ body: { username: 'a'.repeat(65), password: PASSWORD } }, 400, 'invalid_request'],
        [{ body: { username: 'admin', password: 'x'.repeat(5000) } }, 413, 'payload_too_large'],
      ];
      for (const [opts, status, error] of cases) {
        const res = await app.request('/api/auth/login', { method: 'POST', ...opts });
        assert.equal(res.status, status, JSON.stringify(opts).slice(0, 80));
        assert.deepEqual(await res.json(), { error });
      }
    });

    it('exige que la petición provenga del propio sitio (login CSRF)', async () => {
      for (const origin of ['https://evil.example', 'null', null]) {
        const res = await app.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, origin });
        assert.equal(res.status, 403, String(origin));
        assert.deepEqual(await res.json(), { error: 'forbidden_origin' });
      }
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: PASSWORD },
        origin: null,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(res.status, 200);
    });

    it('GET en una ruta POST devuelve 405 con Allow', async () => {
      const res = await app.request('/api/auth/login');
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    });
  });

  describe('GET /api/auth/session', () => {
    it('devuelve el usuario y el mismo token CSRF que el login', async () => {
      const { cookie, csrfToken } = await app.login('editor');
      const res = await app.request('/api/auth/session', { cookie });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.user.username, 'editor');
      assert.equal(body.csrfToken, csrfToken);
    });

    it('sin cookie responde 401; con cookie inválida además la borra', async () => {
      let res = await app.request('/api/auth/session');
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('set-cookie'), null);
      res = await app.request('/api/auth/session', { cookie: `cms_session=${'a'.repeat(43)}` });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('set-cookie'), /^cms_session=; .*Max-Age=0/);
    });
  });

  describe('POST /api/auth/logout', () => {
    let session;
    beforeEach(async () => (session = await app.login('editor')));

    it('exige el token CSRF de la sesión', async () => {
      const other = await app.login('admin');
      for (const headers of [{}, { 'x-csrf-token': 'x' }, { 'x-csrf-token': other.csrfToken }]) {
        const res = await app.request('/api/auth/logout', { method: 'POST', cookie: session.cookie, headers });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: 'invalid_csrf_token' });
      }
      assert.equal((await app.request('/api/auth/session', { cookie: session.cookie })).status, 200, 'la sesión sigue activa');
    });

    it('revoca la sesión, borra la cookie y lo audita', async () => {
      const res = await app.request('/api/auth/logout', { method: 'POST', cookie: session.cookie, headers: { 'x-csrf-token': session.csrfToken } });
      assert.equal(res.status, 204);
      assert.match(res.headers.get('set-cookie'), /^cms_session=; .*Max-Age=0/);
      assert.equal((await app.request('/api/auth/session', { cookie: session.cookie })).status, 401);
      assert.equal(audit('auth.logout').actor_user_id, editor.id);
    });

    it('sin sesión responde 401', async () => {
      const res = await app.request('/api/auth/logout', { method: 'POST' });
      assert.equal(res.status, 401);
    });
  });
});

describe('cookie en producción', () => {
  it('usa el prefijo __Host- y Secure', async () => {
    const app = await startApp({ env: { NODE_ENV: 'production', APP_BASE_URL: 'https://cms.example.org' } });
    try {
      await app.createUser({ username: 'prod' });
      const { res, setCookie } = await app.login('prod');
      assert.equal(res.status, 200);
      assert.match(setCookie, /^__Host-cms_session=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict; Max-Age=28800; HttpOnly; Secure$/);
      assert.ok(!/Domain=/i.test(setCookie));
    } finally {
      await app.stop();
    }
  });
});
