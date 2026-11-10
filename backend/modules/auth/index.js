/**
 * Módulo de autenticación: login, logout, sesión actual y resolución de la sesión
 * a partir de la cookie. Las comprobaciones de origen y CSRF genéricas se aplican
 * en app.js antes de llegar a estos manejadores.
 */
import { withTransaction } from '../../database/transaction.js';
import { createAuditLog } from '../audit/audit.js';
import { createPermissionRepository } from '../permissions/repository.js';
import { createUserRepository } from '../users/repository.js';
import { rules, validate } from '../../utils/validation.js';
import { HttpError, parseCookies, readJsonBody, serializeCookie } from '../../middleware/http.js';
import { PASSWORD_INPUT_MAX_BYTES, PasswordHasherBusyError, checkPasswordPolicy, createPasswordHasher } from './password.js';
import { createRateLimiter } from './rate-limiter.js';
import { createSessionStore, csrfTokenFor } from './sessions.js';

const WINDOW_MS = 15 * 60_000;
/** Límites de intentos FALLIDOS por ventana de 15 minutos (D-019). */
export const LOGIN_LIMITS = Object.freeze({ perIp: 30, perUserAndIp: 5, perUser: 50 });

export function sessionCookieName(config) {
  // __Host- exige Secure, Path=/ y sin Domain: impide que un subdominio la sobrescriba.
  return config.baseUrl.startsWith('https:') ? '__Host-cms_session' : 'cms_session';
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: any, logger: any,
 *           clock?: () => number, passwordHasher?: ReturnType<typeof createPasswordHasher> }} deps
 */
export function createAuth({ db, config, logger, clock = Date.now, passwordHasher = createPasswordHasher() }) {
  const users = createUserRepository(db);
  const sessions = createSessionStore(db, { ...config.session, clock });
  const audit = createAuditLog(db);
  const permissions = createPermissionRepository(db);
  // Intentos fallidos de la contraseña actual al cambiarla (por usuario).
  const passwordChangeLimiter = createRateLimiter({ windowMs: WINDOW_MS, max: LOGIN_LIMITS.perUserAndIp, clock });
  const limiters = {
    ip: createRateLimiter({ windowMs: WINDOW_MS, max: LOGIN_LIMITS.perIp, clock }),
    userIp: createRateLimiter({ windowMs: WINDOW_MS, max: LOGIN_LIMITS.perUserAndIp, clock }),
    user: createRateLimiter({ windowMs: WINDOW_MS, max: LOGIN_LIMITS.perUser, clock }),
  };

  const cookieName = sessionCookieName(config);
  const secureCookie = config.baseUrl.startsWith('https:');

  const sessionCookie = (token) =>
    serializeCookie(cookieName, token, { maxAge: config.session.ttlMs / 1000, secure: secureCookie });
  const clearCookie = () => serializeCookie(cookieName, '', { maxAge: 0, secure: secureCookie });

  function tokenFromRequest(req) {
    return parseCookies(req.headers.cookie).get(cookieName);
  }

  /** @returns {{ token: string, session: NonNullable<ReturnType<typeof sessions.resolve>> } | null} */
  function sessionFromRequest(req) {
    const token = tokenFromRequest(req);
    if (token === undefined) return null;
    const session = sessions.resolve(token);
    return session ? { token, session } : null;
  }

  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? u.display_name,
    role: u.role,
    mustChangePassword: u.mustChangePassword ?? u.must_change_password === 1,
  });

  /**
   * Alcance del usuario, informativo para la interfaz. El backend vuelve a
   * verificar cada permiso con el autorizador; esto no concede nada.
   */
  const accessOf = (u) => (u.role === 'general_admin' ? { scope: 'all' } : { scope: 'sections', sections: permissions.accessForUser(u.id) });

  async function runHasher(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PasswordHasherBusyError) throw new HttpError(503, 'service_busy', { 'Retry-After': '5' });
      throw err;
    }
  }

  async function login(ctx) {
    const body = await readJsonBody(ctx.req, { limit: 4096 });
    const { username, password } = body;
    if (
      typeof username !== 'string' || username.length < 1 || username.length > 64 ||
      typeof password !== 'string' || password.length < 1 || Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES
    ) {
      throw new HttpError(400, 'invalid_request');
    }

    const userKey = username.toLowerCase();
    const keys = { ip: ctx.ip ?? 'unknown', userIp: `${userKey}|${ctx.ip}`, user: userKey };
    for (const [name, limiter] of Object.entries(limiters)) {
      const { limited, retryAfterSeconds } = limiter.check(keys[name]);
      if (limited) {
        logger.warn('Login limitado por exceso de intentos', { limiter: name, ip: ctx.ip });
        throw new HttpError(429, 'too_many_attempts', { 'Retry-After': String(retryAfterSeconds) });
      }
    }

    const user = users.findByUsername(username);
    const ok = await runHasher(() =>
      user && user.status === 'active' ? passwordHasher.verify(password, user.password_hash) : passwordHasher.verifyDummy(password),
    );

    if (!ok) {
      for (const [name, limiter] of Object.entries(limiters)) limiter.hit(keys[name]);
      const reason = !user ? 'unknown_user' : user.status !== 'active' ? 'inactive_user' : 'bad_password';
      // No se registra el nombre de usuario probado si no existe (podría ser una contraseña tecleada por error).
      audit.record({ action: 'auth.login', outcome: 'failure', actorUserId: user?.id ?? null, ip: ctx.ip, details: { reason } });
      throw new HttpError(401, 'invalid_credentials');
    }

    limiters.userIp.reset(keys.userIp);
    limiters.user.reset(keys.user);

    if (passwordHasher.needsRehash(user.password_hash)) {
      users.updatePasswordHash(user.id, await passwordHasher.hash(password));
      logger.info('Hash de contraseña actualizado a los parámetros vigentes', { userId: user.id });
    }

    // Fijación de sesión: una sesión previa presentada por el cliente se revoca; siempre se emite un token nuevo.
    const previous = sessionFromRequest(ctx.req);
    if (previous) sessions.revokeSession(previous.session.id, 'relogin');

    const { token, expiresAt } = sessions.create({ userId: user.id, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] ?? null });
    audit.record({ action: 'auth.login', outcome: 'success', actorUserId: user.id, entityType: 'user', entityId: user.id, ip: ctx.ip });

    return {
      status: 200,
      cookies: [sessionCookie(token)],
      body: { user: publicUser(user), access: accessOf(user), csrfToken: csrfTokenFor(token), expiresAt },
    };
  }

  /** Requiere sesión y token CSRF (verificados en app.js). */
  function logout(ctx) {
    sessions.revokeSession(ctx.auth.session.id, 'logout');
    audit.record({ action: 'auth.logout', outcome: 'success', actorUserId: ctx.auth.session.user.id, entityType: 'user', entityId: ctx.auth.session.user.id, ip: ctx.ip });
    return { status: 204, cookies: [clearCookie()] };
  }

  /** Requiere sesión (verificada en app.js). */
  function current(ctx) {
    const { token, session } = ctx.auth;
    return {
      status: 200,
      body: { user: publicUser(session.user), access: accessOf(session.user), csrfToken: csrfTokenFor(token), expiresAt: session.expiresAt },
    };
  }

  /**
   * Cambio de la propia contraseña. Exige la actual, aplica la política y revoca
   * las demás sesiones del usuario (la actual se conserva). Disponible también
   * con contraseña temporal pendiente de cambio.
   */
  async function changePassword(ctx) {
    const { currentPassword, newPassword } = validate(await readJsonBody(ctx.req, { limit: 4096 }), {
      currentPassword: rules.string({ min: 1, max: PASSWORD_INPUT_MAX_BYTES, raw: true }),
      newPassword: rules.string({ min: 1, max: PASSWORD_INPUT_MAX_BYTES, raw: true }),
    });
    const { user, id: sessionId } = ctx.auth.session;
    const key = String(user.id);

    const limit = passwordChangeLimiter.check(key);
    if (limit.limited) throw new HttpError(429, 'too_many_attempts', { 'Retry-After': String(limit.retryAfterSeconds) });

    const ok = await runHasher(() => passwordHasher.verify(currentPassword, users.passwordHashOf(user.id)));
    if (!ok) {
      passwordChangeLimiter.hit(key);
      audit.record({ action: 'user.password_change', outcome: 'failure', actorUserId: user.id, entityType: 'user', entityId: user.id, ip: ctx.ip, details: { reason: 'bad_current' } });
      throw new HttpError(403, 'invalid_current_password');
    }
    const issues = checkPasswordPolicy(newPassword, { username: user.username });
    if (newPassword === currentPassword) issues.push('Debe ser distinta de la actual');
    if (issues.length) throw new HttpError(400, 'validation_failed', {}, { fields: { newPassword: 'policy' }, policy: issues });

    const newHash = await runHasher(() => passwordHasher.hash(newPassword));
    const revokedCount = withTransaction(db, () => {
      users.setPassword(user.id, newHash, { mustChange: false });
      const count = sessions.revokeOthersForUser(user.id, sessionId, 'password_change');
      audit.record({ action: 'user.password_change', outcome: 'success', actorUserId: user.id, entityType: 'user', entityId: user.id, ip: ctx.ip, details: { revokedCount: count } });
      return count;
    });
    passwordChangeLimiter.reset(key);
    return { status: 200, body: { status: 'password_changed', revokedCount } };
  }

  return Object.freeze({
    sessionFromRequest,
    hasSessionCookie: (req) => tokenFromRequest(req) !== undefined,
    clearCookie,
    sessions,
    passwordHasher,
    purgeExpiredSessions: () => sessions.purgeExpired(),
    routes: [
      { method: 'POST', path: '/api/auth/login', handler: login },
      { method: 'POST', path: '/api/auth/logout', handler: logout, auth: true, allowDuringPasswordChange: true },
      { method: 'GET', path: '/api/auth/session', handler: current, auth: true, allowDuringPasswordChange: true },
      { method: 'POST', path: '/api/auth/password', handler: changePassword, auth: true, allowDuringPasswordChange: true },
    ],
  });
}
