/**
 * Asignación de secciones y permisos a administradores de sección (solo general_admin).
 *
 * - Asignar es idempotente (200 si ya estaba asignada, 201 si es nueva).
 * - Retirar una sección elimina en cascada sus permisos (FK compuesta).
 * - Los permisos de una asignación se reemplazan como conjunto; la auditoría
 *   guarda el antes y el después.
 * - No se asigna a usuarios desactivados ni a secciones archivadas.
 */
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { createPermissionRepository } from './repository.js';

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, loadManagedUser: (id: number) => any }} deps
 */
export function createPermissionsModule({ db, loadManagedUser }) {
  const permissions = createPermissionRepository(db);
  const audit = createAuditLog(db);
  const sectionById = db.prepare('SELECT id, slug, status FROM sections WHERE id = ?');
  const allCodes = permissions.codes();

  const actor = (ctx) => ctx.auth.session.user.id;

  function loadSection(id) {
    const section = sectionById.get(id);
    if (!section) throw new HttpError(404, 'section_not_found');
    return section;
  }

  function loadAssignable(ctx) {
    const user = loadManagedUser(ctx.params.id);
    const section = loadSection(ctx.params.sectionId);
    return { user, section };
  }

  function catalog() {
    return { status: 200, body: { permissions: permissions.catalog() } };
  }

  function assign(ctx) {
    const { user, section } = loadAssignable(ctx);
    if (user.status === 'disabled') throw new HttpError(409, 'user_disabled');
    if (section.status === 'archived') throw new HttpError(409, 'section_archived');
    if (permissions.isAssigned(user.id, section.id)) {
      return { status: 200, body: { assigned: true, permissions: permissions.permissionsOf(user.id, section.id) } };
    }
    withTransaction(db, () => {
      permissions.assign(user.id, section.id, actor(ctx));
      audit.record({
        action: 'permission.section_assign', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: user.id,
        sectionId: section.id, ip: ctx.ip,
      });
    });
    return { status: 201, body: { assigned: true, permissions: [] } };
  }

  function revoke(ctx) {
    const { user, section } = loadAssignable(ctx);
    if (!permissions.isAssigned(user.id, section.id)) throw new HttpError(404, 'assignment_not_found');
    withTransaction(db, () => {
      const before = permissions.permissionsOf(user.id, section.id);
      permissions.revoke(user.id, section.id);
      audit.record({
        action: 'permission.section_revoke', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: user.id,
        sectionId: section.id, ip: ctx.ip, details: { before },
      });
    });
    return { status: 204 };
  }

  async function setPermissions(ctx) {
    const { user, section } = loadAssignable(ctx);
    const { permissions: wanted } = validate(await readJsonBody(ctx.req), { permissions: rules.enumList(allCodes) });
    if (user.status === 'disabled') throw new HttpError(409, 'user_disabled');
    if (!permissions.isAssigned(user.id, section.id)) throw new HttpError(409, 'section_not_assigned');

    const result = withTransaction(db, () => {
      const before = permissions.permissionsOf(user.id, section.id);
      const toAdd = wanted.filter((c) => !before.includes(c));
      const toRemove = before.filter((c) => !wanted.includes(c));
      for (const code of toRemove) permissions.ungrant(user.id, section.id, code);
      for (const code of toAdd) permissions.grant(user.id, section.id, code, actor(ctx));
      if (toAdd.length || toRemove.length) {
        audit.record({
          action: 'permission.set', outcome: 'success', actorUserId: actor(ctx), entityType: 'user', entityId: user.id,
          sectionId: section.id, ip: ctx.ip, details: { before, after: wanted, added: toAdd, removed: toRemove },
        });
      }
      return { permissions: permissions.permissionsOf(user.id, section.id), changed: toAdd.length + toRemove.length > 0 };
    });
    return { status: 200, body: result };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/permissions', handler: catalog, ...ga },
      { method: 'PUT', path: '/api/users/:id/sections/:sectionId', handler: assign, ...ga },
      { method: 'DELETE', path: '/api/users/:id/sections/:sectionId', handler: revoke, ...ga },
      { method: 'PUT', path: '/api/users/:id/sections/:sectionId/permissions', handler: setPermissions, ...ga },
    ],
  });
}
