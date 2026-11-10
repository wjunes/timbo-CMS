/**
 * Pruebas de seguridad de autenticación y sesiones: fijación de sesión, secretos
 * en claro, fuerza bruta, enumeración de usuarios, revocación inmediata,
 * caducidad, actualización de hashes y errores sin filtraciones.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LOGIN_LIMITS } from '../../backend/modules/auth/index.js';
import { PasswordHasherBusyError, createPasswordHasher } from '../../backend/modules/auth/password.js';
import { generateToken } from '../../backend/modules/auth/sessions.js';
import { FAST_PARAMS, PASSWORD, startApp } from '../helpers/http.js';

let app;
afterEach(() => app?.stop());

/** Hasher real (parámetros reducidos) que cuenta las llamadas. */
function spyHasher() {
  const real = createPasswordHasher({ params: FAST_PARAMS });
  const calls = { verify: 0, verifyDummy: 0, hash: 0 };
  return {
    calls,
    hash: (...a) => (calls.hash++, real.hash(...a)),
    verify: (...a) => (calls.verify++, real.verify(...a)),
    verifyDummy: (...a) => (calls.verifyDummy++, real.verifyDummy(...a)),
    needsRehash: real.needsRehash,
  };
}

const tokenOf = (cookie) => cookie.split('=')[1];

describe('seguridad: sesiones', () => {
  it('fijación de sesión: el login siempre emite un token nuevo y revoca la sesión previa presentada', async () => {
    app = await startApp();
    await app.createUser({ username: 'victima' });
    await app.createUser({ username: 'atacante' });

    // Un token inventado por el atacante nunca se adopta.
    const planted = `cms_session=${generateToken()}`;
    const a = await app.login('victima', PASSWORD, { cookie: planted });
    assert.notEqual(a.cookie, planted);

    // Una sesión válida del atacante presentada en el login de la víctima queda revocada.
    const attacker = await app.login('atacante');
    const b = await app.login('victima', PASSWORD, { cookie: attacker.cookie });
    assert.notEqual(b.cookie, attacker.cookie);
    assert.equal((await app.request('/api/auth/session', { cookie: attacker.cookie })).status, 401);
    const me = await (await app.request('/api/auth/session', { cookie: b.cookie })).json();
    assert.equal(me.user.username, 'victima');
  });

  it('ni el token ni la contraseña aparecen en claro en la base de datos ni en los registros', async () => {
    app = await startApp();
    await app.createUser({ username: 'admin', role: 'general_admin' });
    const { cookie } = await app.login('admin');
    await app.login('admin', 'contraseña-equivocada-123');
    const token = tokenOf(cookie);

    const blobAware = (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
    for (const table of ['users', 'sessions', 'audit_logs']) {
      const dump = JSON.stringify(app.db.prepare(`SELECT * FROM ${table}`).all(), blobAware);
      assert.ok(!dump.includes(token), `token en ${table}`);
      assert.ok(!dump.includes(PASSWORD), `contraseña en ${table}`);
      assert.ok(!dump.includes('contraseña-equivocada-123'), `contraseña fallida en ${table}`);
    }
    const logs = app.logs.join('\n');
    assert.ok(!logs.includes(token));
    assert.ok(!logs.includes(PASSWORD));
  });

  it('suspender a un usuario invalida sus sesiones de inmediato', async () => {
    app = await startApp();
    const user = await app.createUser();
    const { cookie } = await app.login(user.username);
    app.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    assert.equal((await app.request('/api/auth/session', { cookie })).status, 401);
  });

  it('caducidad por inactividad y por duración máxima', async () => {
    app = await startApp({ env: { SESSION_TTL_HOURS: '1', SESSION_IDLE_MINUTES: '10' } });
    const user = await app.createUser();

    const idle = await app.login(user.username);
    app.clock.now += 11 * 60_000;
    assert.equal((await app.request('/api/auth/session', { cookie: idle.cookie })).status, 401);

    const active = await app.login(user.username);
    for (let i = 0; i < 6; i++) {
      app.clock.now += 9 * 60_000;
      assert.equal((await app.request('/api/auth/session', { cookie: active.cookie })).status, 200, `iteración ${i}`);
    }
    app.clock.now += 7 * 60_000; // 61 minutos desde el login
    assert.equal((await app.request('/api/auth/session', { cookie: active.cookie })).status, 401);
  });
});

describe('seguridad: fuerza bruta', () => {
  it(`bloquea tras ${LOGIN_LIMITS.perUserAndIp} fallos por usuario e IP (también la contraseña correcta) hasta que expira la ventana`, async () => {
    const hasher = spyHasher();
    app = await startApp({ hasher });
    await app.createUser({ username: 'objetivo' });
    for (let i = 0; i < LOGIN_LIMITS.perUserAndIp; i++) {
      assert.equal((await app.login('objetivo', `mala-contraseña-${i}`)).res.status, 401);
    }
    const verifies = hasher.calls.verify;
    const blocked = await app.login('objetivo', PASSWORD);
    assert.equal(blocked.res.status, 429);
    assert.deepEqual(blocked.body, { error: 'too_many_attempts' });
    assert.ok(Number(blocked.res.headers.get('retry-after')) > 0);
    assert.equal(hasher.calls.verify, verifies, 'un intento bloqueado no ejecuta Argon2');

    app.clock.now += 15 * 60_000;
    assert.equal((await app.login('objetivo')).res.status, 200);
  });

  it('un login correcto restablece el contador del usuario', async () => {
    app = await startApp();
    await app.createUser({ username: 'objetivo' });
    for (let i = 0; i < LOGIN_LIMITS.perUserAndIp - 1; i++) await app.login('objetivo', 'mala-contraseña-x');
    assert.equal((await app.login('objetivo')).res.status, 200);
    for (let i = 0; i < LOGIN_LIMITS.perUserAndIp - 1; i++) await app.login('objetivo', 'mala-contraseña-x');
    assert.equal((await app.login('objetivo')).res.status, 200);
  });

  it(`limita por IP (${LOGIN_LIMITS.perIp} fallos) aunque se prueben usuarios distintos`, async () => {
    app = await startApp();
    for (let i = 0; i < LOGIN_LIMITS.perIp; i++) await app.login(`usuario-${i}`, 'mala-contraseña-x');
    assert.equal((await app.login('otro-usuario', 'mala-contraseña-x')).res.status, 429);
  });

  it('sin proxy de confianza, falsificar X-Forwarded-For no evita el límite', async () => {
    app = await startApp();
    await app.createUser({ username: 'objetivo' });
    for (let i = 0; i < LOGIN_LIMITS.perUserAndIp; i++) {
      await app.login('objetivo', 'mala-contraseña-x', { headers: { 'x-forwarded-for': `10.0.0.${i}` } });
    }
    const res = (await app.login('objetivo', PASSWORD, { headers: { 'x-forwarded-for': '10.9.9.9' } })).res;
    assert.equal(res.status, 429);
  });

  it(`con proxy de confianza, limita un usuario atacado desde muchas IP (${LOGIN_LIMITS.perUser} fallos)`, async () => {
    app = await startApp({ env: { TRUST_PROXY: 'true' } });
    await app.createUser({ username: 'objetivo' });
    for (let i = 0; i < LOGIN_LIMITS.perUser; i++) {
      const r = await app.login('objetivo', 'mala-contraseña-x', { headers: { 'x-forwarded-for': `10.1.${Math.floor(i / 200)}.${i % 200}` } });
      assert.equal(r.res.status, 401, `intento ${i}`);
    }
    const res = (await app.login('objetivo', PASSWORD, { headers: { 'x-forwarded-for': '10.2.0.1' } })).res;
    assert.equal(res.status, 429);
  });
});

describe('seguridad: enumeración de usuarios', () => {
  it('los usuarios inexistentes o inactivos también ejecutan Argon2 (sin atajo temporal)', async () => {
    const hasher = spyHasher();
    app = await startApp({ hasher });
    const suspended = await app.createUser({ status: 'suspended' });
    await app.createUser({ username: 'activo' });

    await app.login('no-existe', PASSWORD);
    assert.deepEqual([hasher.calls.verify, hasher.calls.verifyDummy], [0, 1]);
    await app.login(suspended.username, PASSWORD);
    assert.deepEqual([hasher.calls.verify, hasher.calls.verifyDummy], [0, 2]);
    await app.login('activo', 'mala-contraseña-x');
    assert.deepEqual([hasher.calls.verify, hasher.calls.verifyDummy], [1, 2]);
  });
});

describe('seguridad: hashes y errores', () => {
  it('un hash con parámetros antiguos se actualiza al iniciar sesión', async () => {
    app = await startApp();
    const weak = createPasswordHasher({ params: { memory: 512, passes: 1, parallelism: 1 } });
    const user = await app.createUser();
    app.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await weak.hash(PASSWORD), user.id);
    assert.equal((await app.login(user.username)).res.status, 200);
    const { password_hash: stored } = app.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    assert.match(stored, /\$m=1024,t=1,p=1\$/);
    assert.equal((await app.login(user.username)).res.status, 200);
  });

  it('un fallo interno devuelve 500 genérico sin detalles', async () => {
    const broken = { ...spyHasher(), verify: async () => { throw new Error('detalle interno secreto'); } };
    app = await startApp({ hasher: broken });
    await app.createUser({ username: 'u-error' });
    const { res, body } = await app.login('u-error');
    assert.equal(res.status, 500);
    assert.deepEqual(body, { error: 'internal_error' });
  });

  it('saturación del hasher devuelve 503 con Retry-After', async () => {
    const busy = { ...spyHasher(), verify: async () => { throw new PasswordHasherBusyError(); } };
    app = await startApp({ hasher: busy });
    await app.createUser({ username: 'u-busy' });
    const { res, body } = await app.login('u-busy');
    assert.equal(res.status, 503);
    assert.deepEqual(body, { error: 'service_busy' });
    assert.equal(res.headers.get('retry-after'), '5');
  });
});
