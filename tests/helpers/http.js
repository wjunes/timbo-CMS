/**
 * Arranque de la aplicación completa para pruebas HTTP (BD en memoria migrada,
 * Argon2id con parámetros reducidos, reloj controlable, logger capturado).
 */
import { createServer } from '../../backend/app.js';
import { loadConfig } from '../../backend/config/index.js';
import { createPasswordHasher } from '../../backend/modules/auth/password.js';
import { createLogger } from '../../backend/utils/logger.js';
import { closeDatabase, migratedMemoryDb } from './db.js';

export const FAST_PARAMS = Object.freeze({ memory: 1024, passes: 1, parallelism: 1 });
export const PASSWORD = 'contraseña-de-prueba-segura';

let seq = 0;

/**
 * @param {{ env?: Record<string,string>, hasher?: any }} [options]
 */
export async function startApp({ env = {}, hasher = createPasswordHasher({ params: FAST_PARAMS }) } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '3000', ...env });
  const db = migratedMemoryDb();
  const logs = [];
  const logger = createLogger({ level: 'debug', write: (_stream, line) => logs.push(line) });
  const clock = { now: Date.now() };
  const server = createServer({ config, logger, db, clock: () => clock.now, passwordHasher: hasher });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = new URL(config.baseUrl).origin;

  async function createUser({ role = 'section_admin', status = 'active', password = PASSWORD, username } = {}) {
    const name = username ?? `usuario${++seq}`;
    const hash = await hasher.hash(password);
    const id = Number(
      db
        .prepare('INSERT INTO users (username, email, display_name, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, `${name}@example.org`, `Usuario ${name}`, hash, role, status).lastInsertRowid,
    );
    return { id, username: name, password };
  }

  /** fetch con Origin del sitio por defecto. */
  function request(path, { method = 'GET', body, headers = {}, cookie, origin: o = origin } = {}) {
    const h = { ...headers };
    if (o !== null) h.origin = o;
    if (cookie) h.cookie = cookie;
    if (body !== undefined) {
      h['content-type'] ??= 'application/json';
      body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(`${base}${path}`, { method, headers: h, body, redirect: 'manual' });
  }

  /** Login correcto: devuelve { res, cookie, csrfToken, body }. */
  async function login(username, password = PASSWORD, opts = {}) {
    const res = await request('/api/auth/login', { method: 'POST', body: { username, password }, ...opts });
    const body = await res.json();
    const setCookie = res.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(';')[0] : undefined;
    return { res, body, cookie, setCookie, csrfToken: body.csrfToken };
  }

  /** Cliente autenticado: añade cookie y X-CSRF-Token; `json` devuelve { status, body }. */
  function as(session) {
    const send = (path, opts = {}) =>
      request(path, { ...opts, cookie: session.cookie, headers: { 'x-csrf-token': session.csrfToken, ...opts.headers } });
    send.json = async (path, opts) => {
      const res = await send(path, opts);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
    };
    return send;
  }

  /** Crea el general_admin e inicia sesión con él. */
  async function loginAsAdmin() {
    const admin = await createUser({ role: 'general_admin', username: 'admin' });
    const session = await login('admin');
    return { admin, session, api: as(session) };
  }

  async function stop() {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    closeDatabase(db);
  }

  return { config, db, server, base, origin, logs, clock, request, login, createUser, as, loginAsAdmin, stop };
}
