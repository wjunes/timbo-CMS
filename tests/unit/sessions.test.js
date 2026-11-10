import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createSessionStore,
  csrfTokenFor,
  generateToken,
  hashToken,
  isWellFormedToken,
  verifyCsrfToken,
} from '../../backend/modules/auth/sessions.js';
import { closeDatabase, insertUser, migratedMemoryDb } from '../helpers/db.js';

const HOUR = 3_600_000;
const MIN = 60_000;

describe('tokens', () => {
  it('genera tokens de 256 bits en base64url, distintos entre sí', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    assert.equal(tokens.size, 200);
    for (const t of tokens) assert.ok(isWellFormedToken(t), t);
    assert.equal(Buffer.from([...tokens][0], 'base64url').length, 32);
  });

  it('el hash es SHA-256 de 32 bytes y no contiene el token', () => {
    const t = generateToken();
    const h = hashToken(t);
    assert.equal(h.length, 32);
    assert.ok(!h.toString('utf8').includes(t));
  });

  it('rechaza tokens mal formados', () => {
    for (const bad of [undefined, '', 'corto', 'x'.repeat(43) + 'y', 'a'.repeat(42) + '=', 'a'.repeat(42) + '/']) {
      assert.equal(isWellFormedToken(bad), false, String(bad));
    }
  });

  it('el token CSRF depende de la sesión y se verifica en tiempo constante', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(csrfTokenFor(a), csrfTokenFor(b));
    assert.notEqual(csrfTokenFor(a), a);
    assert.equal(verifyCsrfToken(a, csrfTokenFor(a)), true);
    assert.equal(verifyCsrfToken(a, csrfTokenFor(b)), false);
    for (const bad of [undefined, '', 'x', csrfTokenFor(a) + 'x']) assert.equal(verifyCsrfToken(a, bad), false);
  });
});

describe('createSessionStore', () => {
  let db;
  let now;
  let store;
  let userId;
  const clock = () => now;

  beforeEach(() => {
    db = migratedMemoryDb();
    now = Date.parse('2026-01-01T10:00:00.000Z');
    store = createSessionStore(db, { ttlMs: 8 * HOUR, idleMs: 30 * MIN, clock });
    userId = insertUser(db, { role: 'section_admin' });
  });
  afterEach(() => closeDatabase(db));

  it('crea una sesión y la resuelve con los datos del usuario', () => {
    const { token, expiresAt } = store.create({ userId, ip: '127.0.0.1', userAgent: 'test' });
    assert.equal(expiresAt, '2026-01-01T18:00:00.000Z');
    const s = store.resolve(token);
    assert.equal(s.user.id, userId);
    assert.equal(s.user.role, 'section_admin');
    assert.equal(s.expiresAt, expiresAt);
  });

  it('solo almacena el hash del token', () => {
    const { token } = store.create({ userId });
    const row = db.prepare('SELECT token_hash FROM sessions').get();
    assert.deepEqual(Buffer.from(row.token_hash), hashToken(token));
    const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all(), (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
    assert.ok(!dump.includes(token));
  });

  it('caduca por inactividad y revoca la sesión', () => {
    const { token } = store.create({ userId });
    now += 29 * MIN;
    assert.ok(store.resolve(token), 'sigue activa a los 29 min');
    now += 29 * MIN; // 29 min desde el último uso (actualizado arriba)
    assert.ok(store.resolve(token), 'el uso renueva la inactividad');
    now += 31 * MIN;
    assert.equal(store.resolve(token), null);
    assert.equal(db.prepare('SELECT revoked_reason FROM sessions').get().revoked_reason, 'idle_timeout');
  });

  it('caduca a la duración máxima aunque haya actividad', () => {
    const { token } = store.create({ userId });
    for (let i = 0; i < 16; i++) {
      now += 29 * MIN;
      store.resolve(token);
    }
    // 16 × 29 min = 7 h 44 min: todavía válida.
    assert.ok(store.resolve(token));
    now += 20 * MIN; // 8 h 04 min
    assert.equal(store.resolve(token), null);
  });

  it('actualiza last_seen_at como mucho una vez por minuto', () => {
    const { token } = store.create({ userId });
    const lastSeen = () => db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at;
    const initial = lastSeen();
    now += 30_000;
    store.resolve(token);
    assert.equal(lastSeen(), initial);
    now += 31_000;
    store.resolve(token);
    assert.notEqual(lastSeen(), initial);
  });

  it('rechaza sesiones revocadas, tokens desconocidos y usuarios no activos', () => {
    const a = store.create({ userId });
    const s = store.resolve(a.token);
    assert.equal(store.revokeSession(s.id, 'logout'), true);
    assert.equal(store.resolve(a.token), null);
    assert.equal(store.resolve(generateToken()), null);

    const b = store.create({ userId });
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(userId);
    assert.equal(store.resolve(b.token), null, 'suspender invalida las sesiones de inmediato');
  });

  it('revoca todas las sesiones de un usuario', () => {
    const tokens = [store.create({ userId }), store.create({ userId })].map((s) => s.token);
    assert.equal(store.revokeAllForUser(userId, 'password_reset'), 2);
    for (const t of tokens) assert.equal(store.resolve(t), null);
    assert.equal(store.revokeAllForUser(userId, 'password_reset'), 0);
  });

  it('purga sesiones caducadas o revocadas tras 24 h de margen', () => {
    const a = store.create({ userId });
    store.create({ userId });
    store.revokeSession(store.resolve(a.token).id, 'logout');
    assert.equal(store.purgeExpired(), 0);
    now += 8 * HOUR + 24 * HOUR + 1;
    assert.equal(store.purgeExpired(), 2);
  });
});
