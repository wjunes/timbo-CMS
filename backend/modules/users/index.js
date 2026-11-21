/**
 * Administración de usuarios (solo general_admin; el rol se exige en app.js).
 *
 * - Solo se crean administradores de sección, con contraseña temporal y cambio
 *   obligatorio (D-023). El general_admin no se gestiona por esta API (D-018/D-024):
 *   cualquier operación de escritura sobre él devuelve 403 `target_protected`.
 * - Estados: active ⇄ suspended; active|suspended → disabled (final). Suspender,
 *   desactivar o fijar una contraseña temporal revoca todas sus sesiones.
 * - Cada escritura y su auditoría se confirman en la misma transacción.
 */
import { isUniqueViolation } from '../../database/errors.js';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { PASSWORD_INPUT_MAX_BYTES, PasswordHasherBusyError, checkPasswordPolicy } from '../auth/password.js';
import { createPermissionRepository } from '../permissions/repository.js';
import { createUserRepository, toPublicUser } from './repository.js';

const USERNAME = /^[A-Za-z0-9._-]+$/;

/** Transiciones de estado permitidas por acción. */
const STATUS_ACTIONS = Object.freeze({
  suspend: { from: ['active'], to: 'suspended', revoke: true },
  reactivate: { from: ['suspended'], to: 'active', revoke: false },
  disable: { from: ['active', 'suspended'], to: 'disabled', revoke: true },
});

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, sessions: any, passwordHasher: any }} deps
 */
export function createUsersModule({ db, sessions, passwordHasher }) {
  const users = createUserRepository(db);
  const permissions = createPermissionRepository(db);
  const audit = createAuditLog(db);

  const withAccess = (row) => ({
    ...toPublicUser(row),
    sections: row.role === 'section_admin' ? permissions.accessForUser(row.id) : [],
  });

  /** Carga el usuario objetivo; 404 si no existe, 403 si es el general_admin (no gestionable). */
  function loadManagedUser(id) {
    const row = users.findById(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.role === 'general_admin') throw new HttpError(403, 'target_protected');
    return row;
  }

  async function hashTemporaryPassword(password, username) {
    const issues = checkPasswordPolicy(password, { username });
    if (issues.length) throw new HttpError(400, 'validation_failed', {}, { fields: { temporaryPassword: 'policy' }, policy: issues });
    try {
      return await passwordHasher.hash(password);
    } catch (err) {
      if (err instanceof PasswordHasherBusyError) throw new HttpError(503, 'service_busy', { 'Retry-After': '5' });
      throw err;
    }
  }

  const actor = (ctx) => ctx.auth.session.user.id;

  function list() {
    return { status: 200, body: { users: users.list().map(withAccess) } };
  }

  function get(ctx) {
    const row = users.findById(ctx.params.id);
    if (!row) throw new HttpError(404, 'not_found');
    return { status: 200, body: { user: withAccess(row) } };
  }

  async function create(ctx) {
    const input = validate(await readJsonBody(ctx.req), {
      username: rules.string({ min: 3, max: 64, pattern: USERNAME }),
      email: rules.email(),
      displayName: rules.string({ min: 1, max: 120 }),
      temporaryPassword: rules.string({ min: 1, max: PASSWORD_INPUT_MAX_BYTES, raw: true }),
    });
    const passwordHash = await hashTemporaryPassword(input.temporaryPassword, input.username);
    let id;
    try {
      id = withTransaction(db, () => {
        const userId = users.createSectionAdmin({ ...input, passwordHash, createdBy: actor(ctx) });
        audit.record({
          action: 'user.create', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: userId, ip: ctx.ip,
          details: { role: 'section_admin', username: input.username },
        });
        return userId;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'username_or_email_taken');
      throw err;
    }
    return { status: 201, body: { user: withAccess(users.findById(id)) } };
  }

  async function update(ctx) {
    const target = loadManagedUser(ctx.params.id);
    const input = validate(
      await readJsonBody(ctx.req),
      { displayName: rules.string({ min: 1, max: 120, optional: true }), email: rules.email({ optional: true }) },
      { requireAny: true },
    );
    const changed = Object.keys(input).filter((k) => input[k] !== (k === 'displayName' ? target.display_name : target.email));
    if (changed.length) {
      try {
        withTransaction(db, () => {
          users.updateProfile(target.id, input);
          audit.record({
            action: 'user.update', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: target.id, ip: ctx.ip,
            details: { fields: changed },
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'username_or_email_taken');
        throw err;
      }
    }
    return { status: 200, body: { user: withAccess(users.findById(target.id)) } };
  }

  function changeStatus(action) {
    const rule = STATUS_ACTIONS[action];
    return (ctx) => {
      const target = loadManagedUser(ctx.params.id);
      if (!rule.from.includes(target.status)) throw new HttpError(409, 'invalid_status_transition');
      const revokedCount = withTransaction(db, () => {
        users.setStatus(target.id, rule.to);
        const count = rule.revoke ? sessions.revokeAllForUser(target.id, `user_${rule.to}`) : 0;
        audit.record({
          action: 'user.status_change', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: target.id, ip: ctx.ip,
          details: { from: target.status, to: rule.to, revokedCount: count },
        });
        return count;
      });
      return { status: 200, body: { user: withAccess(users.findById(target.id)), revokedCount } };
    };
  }

  async function resetPassword(ctx) {
    const target = loadManagedUser(ctx.params.id);
    if (target.status === 'disabled') throw new HttpError(409, 'user_disabled');
    const { temporaryPassword } = validate(await readJsonBody(ctx.req), {
      temporaryPassword: rules.string({ min: 1, max: PASSWORD_INPUT_MAX_BYTES, raw: true }),
    });
    const passwordHash = await hashTemporaryPassword(temporaryPassword, target.username);
    const revokedCount = withTransaction(db, () => {
      users.setPassword(target.id, passwordHash, { mustChange: true });
      const count = sessions.revokeAllForUser(target.id, 'password_reset');
      audit.record({
        action: 'user.password_reset', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: target.id, ip: ctx.ip,
        details: { revokedCount: count, via: 'api' },
      });
      return count;
    });
    return { status: 200, body: { user: withAccess(users.findById(target.id)), revokedCount } };
  }

  function revokeSessions(ctx) {
    const target = loadManagedUser(ctx.params.id);
    const revokedCount = withTransaction(db, () => {
      const count = sessions.revokeAllForUser(target.id, 'admin_revoke');
      audit.record({
        action: 'user.sessions_revoke', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: target.id, ip: ctx.ip,
        details: { revokedCount: count },
      });
      return count;
    });
    return { status: 200, body: { revokedCount } };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    loadManagedUser,
    routes: [
      { method: 'GET', path: '/api/users', handler: list, ...ga },
      { method: 'POST', path: '/api/users', handler: create, ...ga },
      { method: 'GET', path: '/api/users/:id', handler: get, ...ga },
      { method: 'PATCH', path: '/api/users/:id', handler: update, ...ga },
      { method: 'POST', path: '/api/users/:id/suspend', handler: changeStatus('suspend'), ...ga },
      { method: 'POST', path: '/api/users/:id/reactivate', handler: changeStatus('reactivate'), ...ga },
      { method: 'POST', path: '/api/users/:id/disable', handler: changeStatus('disable'), ...ga },
      { method: 'POST', path: '/api/users/:id/password', handler: resetPassword, ...ga },
      { method: 'POST', path: '/api/users/:id/sessions/revoke', handler: revokeSessions, ...ga },
    ],
  });
}
