/**
 * Sesiones opacas.
 *
 * - Token: 32 bytes de `crypto.randomBytes` (256 bits), en base64url (43 caracteres).
 *   Solo viaja en la cookie; en la base de datos se guarda su SHA-256 (32 bytes).
 * - Validez: no revocada, no caducada (duración máxima), no inactiva (tiempo sin
 *   uso) y usuario `active`. El estado del usuario se comprueba en cada petición,
 *   así que suspender a un usuario invalida sus sesiones de inmediato.
 * - `last_seen_at` se actualiza como mucho una vez por minuto.
 * - Token CSRF: HMAC-SHA256 con el token de sesión como clave. Solo puede
 *   calcularlo quien conoce el token (cookie HttpOnly) o el servidor; no requiere
 *   secreto de servidor ni estado adicional.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;
/** Las sesiones caducadas o revocadas se conservan este tiempo antes de purgarse (diagnóstico). */
const PURGE_GRACE_MS = 24 * 3_600_000;

export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/** @returns {Buffer} SHA-256 del token (32 bytes). */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function csrfTokenFor(sessionToken) {
  return createHmac('sha256', sessionToken).update('cms-csrf-v1').digest('base64url');
}

export function verifyCsrfToken(sessionToken, provided) {
  if (typeof provided !== 'string' || provided.length !== 43) return false;
  return timingSafeEqual(Buffer.from(csrfTokenFor(sessionToken)), Buffer.from(provided));
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ttlMs: number, idleMs: number, clock?: () => number }} options
 */
export function createSessionStore(db, { ttlMs, idleMs, clock = Date.now }) {
  const insert = db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const selectByHash = db.prepare(`
    SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
           u.username, u.display_name, u.role, u.status, u.must_change_password
    FROM sessions AS s JOIN users AS u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL');
  const revoke = db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
  const revokeAll = db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL');
  const revokeOthers = db.prepare(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
  );
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at <= ?');

  /** Crea una sesión nueva. Devuelve el token en claro (solo para la cookie). */
  function create({ userId, ip = null, userAgent = null }) {
    const token = generateToken();
    const now = clock();
    const expiresAt = iso(now + ttlMs);
    insert.run(hashToken(token), userId, iso(now), iso(now), expiresAt, ip?.slice(0, 45) ?? null, userAgent?.slice(0, 512) ?? null);
    return { token, expiresAt };
  }

  /**
   * Resuelve un token a una sesión válida o null. Las sesiones inactivas se revocan.
   * @returns {{ id: number, expiresAt: string, user: { id: number, username: string, displayName: string, role: string, mustChangePassword: boolean } } | null}
   */
  function resolve(token) {
    if (!isWellFormedToken(token)) return null;
    const row = selectByHash.get(hashToken(token));
    if (!row || row.revoked_at !== null) return null;
    const now = clock();
    if (Date.parse(row.expires_at) <= now) return null;
    if (Date.parse(row.last_seen_at) + idleMs <= now) {
      revoke.run(iso(now), 'idle_timeout', row.id);
      return null;
    }
    if (row.status !== 'active') return null;
    if (now - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) touch.run(iso(now), row.id);
    return {
      id: row.id,
      expiresAt: row.expires_at,
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        mustChangePassword: row.must_change_password === 1,
      },
    };
  }

  function revokeSession(sessionId, reason) {
    return revoke.run(iso(clock()), reason, sessionId).changes > 0;
  }

  /** Revoca todas las sesiones activas de un usuario. Devuelve cuántas. */
  function revokeAllForUser(userId, reason) {
    return Number(revokeAll.run(iso(clock()), reason, userId).changes);
  }

  /** Revoca las demás sesiones del usuario, conservando la actual (cambio de contraseña). */
  function revokeOthersForUser(userId, keepSessionId, reason) {
    return Number(revokeOthers.run(iso(clock()), reason, userId, keepSessionId).changes);
  }

  function purgeExpired() {
    const limit = iso(clock() - PURGE_GRACE_MS);
    return Number(purge.run(limit, limit).changes);
  }

  return Object.freeze({ create, resolve, revokeSession, revokeAllForUser, revokeOthersForUser, purgeExpired });
}
