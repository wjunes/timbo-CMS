/**
 * Revisión integral de rutas (Bloque 11): inventario completo de la API con su
 * protección, comprobado también en ejecución, límites de cuerpo y límite
 * general de peticiones. Una ruta nueva obliga a revisar esta prueba.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

/** Rutas sin sesión: las únicas permitidas. */
const PUBLIC = [
  'GET /health', 'HEAD /health', 'POST /api/auth/login',
  'GET /media/:id', 'HEAD /media/:id', 'GET /sitemap.xml', 'HEAD /sitemap.xml',
  'GET /robots.txt', 'HEAD /robots.txt', 'GET /favicon.ico', 'HEAD /favicon.ico',
];

/** Rutas admitidas con contraseña temporal pendiente. */
const DURING_PASSWORD_CHANGE = ['GET /api/auth/session', 'POST /api/auth/logout', 'POST /api/auth/password'];

/**
 * Rutas con sesión pero sin rol fijo: el autorizador central decide por sección
 * y permiso (probado en authorization.security.test.js y en cada módulo).
 */
const SECTION_SCOPED = [
  'POST /api/auth/logout', 'POST /api/auth/password', 'GET /api/auth/session',
  'GET /api/sections', 'GET /api/sections/:id', 'GET /api/section-types', 'GET /api/presentations',
  'GET /api/sections/:id/contents', 'POST /api/sections/:id/contents',
  'GET /api/contents/:id', 'PATCH /api/contents/:id', 'DELETE /api/contents/:id', 'POST /api/contents/:id/preview',
  'POST /api/contents/:id/archive', 'POST /api/contents/:id/restore', 'POST /api/contents/:id/unpublish',
  'GET /api/contents/:id/versions', 'POST /api/contents/:id/versions',
  'GET /api/contents/:id/versions/:versionId', 'PATCH /api/contents/:id/versions/:versionId', 'DELETE /api/contents/:id/versions/:versionId',
  'POST /api/contents/:id/versions/:versionId/submit', 'POST /api/contents/:id/versions/:versionId/publish',
  'GET /api/contents/:id/versions/:versionId/reviews',
  'GET /api/sections/:id/media', 'POST /api/sections/:id/media',
  'GET /api/media/:id', 'PATCH /api/media/:id', 'DELETE /api/media/:id', 'GET /api/media/:id/file',
];

const key = (r) => `${r.method} ${r.path}`;
const concrete = (path) => path.replace(/:[a-zA-Z]+/g, '1');
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Declara un cuerpo de `declared` bytes pero solo envía las cabeceras, y devuelve
 * el estado de la respuesta. Ninguna ruta debe quedarse esperando un cuerpo que
 * supera su límite: o lo rechaza por el tamaño declarado, o no lo lee.
 */
function sendDeclared(base, path, { method, headers, declared }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve('espera');
    }, 5000);
    const req = http.request(`${base}${path}`, { method, headers: { ...headers, 'content-length': declared } }, (res) => {
      clearTimeout(timer);
      res.resume();
      req.destroy();
      resolve(res.statusCode);
    });
    req.on('error', () => {});
    req.flushHeaders();
  });
}

describe('inventario de rutas', () => {
  let app;
  beforeEach(async () => {
    // Estas pruebas recorren todas las rutas: el límite general se sube para que no interfiera.
    app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0', RATE_LIMIT_REQUESTS_PER_MINUTE: '100000', RATE_LIMIT_WRITES_PER_MINUTE: '10000' } });
  });
  afterEach(() => app.stop());

  it('solo las rutas de la lista pública prescinden de sesión', () => {
    const open = app.server.routes.filter((r) => !r.auth).map(key).sort();
    assert.deepEqual(open, [...PUBLIC].sort());
  });

  it('toda ruta con sesión tiene rol general_admin o está en la lista revisada de rutas por sección', () => {
    const authed = app.server.routes.filter((r) => r.auth);
    const unreviewed = authed.filter((r) => r.role !== 'general_admin' && !SECTION_SCOPED.includes(key(r))).map(key);
    assert.deepEqual(unreviewed, [], 'rutas nuevas sin rol: revisar su autorización y añadirlas a la lista');
    for (const r of authed) if (r.role) assert.equal(r.role, 'general_admin', key(r));
    // La lista no contiene rutas que ya no existen.
    const all = new Set(app.server.routes.map(key));
    assert.deepEqual(SECTION_SCOPED.filter((k) => !all.has(k)), []);
  });

  it('solo cambiar la contraseña, consultar la sesión y salir se admiten con contraseña temporal', () => {
    assert.deepEqual(app.server.routes.filter((r) => r.allowDuringPasswordChange).map(key).sort(), [...DURING_PASSWORD_CHANGE].sort());
  });

  it('en ejecución: sin sesión 401, sin token CSRF 403 y de otro origen 403, en todas las rutas protegidas', async () => {
    const { session } = await app.loginAsAdmin();
    for (const r of app.server.routes.filter((x) => x.auth)) {
      const path = concrete(r.path);
      const anon = await app.request(path, { method: r.method, body: UNSAFE.has(r.method) ? {} : undefined });
      assert.equal(anon.status, 401, `${key(r)} sin sesión`);
      if (!UNSAFE.has(r.method)) continue;
      const noCsrf = await app.request(path, { method: r.method, cookie: session.cookie, body: {} });
      assert.equal(noCsrf.status, 403, `${key(r)} sin CSRF`);
      assert.equal((await noCsrf.json()).error, 'invalid_csrf_token', key(r));
      const foreign = await app.request(path, { method: r.method, cookie: session.cookie, headers: { 'x-csrf-token': session.csrfToken }, origin: 'https://evil.example', body: {} });
      assert.equal(foreign.status, 403, `${key(r)} otro origen`);
    }
  });

  it('en ejecución: un administrador de sección recibe 403 en todas las rutas de administración general', async () => {
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    for (const r of app.server.routes.filter((x) => x.role === 'general_admin')) {
      const res = await other(concrete(r.path), { method: r.method, body: UNSAFE.has(r.method) ? {} : undefined });
      assert.equal(res.status, 403, key(r));
    }
  });

  it('ningún cuerpo enorme provoca un error interno; los que se leen responden 413', async () => {
    const { session } = await app.loginAsAdmin();
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrfToken, origin: app.origin, 'content-type': 'application/json' };
    const statuses = new Map();
    // Salir cerraría la sesión con la que se recorre el resto.
    for (const r of app.server.routes.filter((x) => x.auth && UNSAFE.has(x.method) && key(x) !== 'POST /api/auth/logout')) {
      // 4 MiB: mayor que el límite más alto (contenidos: 2 MiB de documento + 256 KiB).
      const status = await sendDeclared(app.base, concrete(r.path), { method: r.method, headers, declared: 4 * 1024 * 1024 });
      assert.ok(typeof status === 'number' && status < 500, `${key(r)}: ${status}`);
      statuses.set(key(r), status);
    }
    for (const k of ['POST /api/auth/password', 'PATCH /api/settings', 'POST /api/users', 'POST /api/sections/:id/contents', 'POST /api/media/purge']) {
      assert.equal(statuses.get(k), 413, k);
    }
    assert.equal((await app.request('/health')).status, 200);
  });
});

describe('límite general de peticiones', () => {
  let app;
  afterEach(() => app.stop());

  it('responde 429 con Retry-After al superar el límite por IP, y se recupera al minuto', async () => {
    app = await startApp({ env: { RATE_LIMIT_REQUESTS_PER_MINUTE: '60' } });
    for (let i = 0; i < 60; i += 1) assert.equal((await app.request('/health')).status, 200);
    const limited = await app.request('/health');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'too_many_requests');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await app.request('/')).status, 429, 'también el sitio público');
    assert.equal(app.logs.filter((l) => l.includes('Límite de peticiones alcanzado')).length, 1, 'se registra una vez por ventana');
    app.clock.now += 61_000;
    assert.equal((await app.request('/health')).status, 200);
  });

  it('las escrituras tienen un límite propio, más bajo', async () => {
    app = await startApp({ env: { RATE_LIMIT_WRITES_PER_MINUTE: '10' } });
    for (let i = 0; i < 10; i += 1) await app.request('/api/auth/logout', { method: 'POST' });
    assert.equal((await app.request('/api/auth/logout', { method: 'POST' })).status, 429);
    assert.equal((await app.request('/health')).status, 200, 'las lecturas siguen permitidas');
  });

  it('con TRUST_PROXY cuenta por la IP del cliente que indica el proxy', async () => {
    app = await startApp({ env: { RATE_LIMIT_REQUESTS_PER_MINUTE: '60', TRUST_PROXY: 'true' } });
    const from = (ip) => app.request('/health', { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 60; i += 1) await from('203.0.113.7');
    assert.equal((await from('203.0.113.7')).status, 429);
    assert.equal((await from('203.0.113.8')).status, 200);
  });
});
