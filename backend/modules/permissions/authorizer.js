/**
 * Punto único de autorización por sección (D-022). Lo usan los Bloques 05–08.
 *
 * - Consulta siempre la base de datos: del objeto `user` solo se usa el `id`;
 *   rol y estado se leen de nuevo. Nunca se confía en datos del cliente.
 * - general_admin activo: todos los permisos por su rol.
 * - section_admin: activo, con la sección asignada y el permiso concedido en ella.
 * - Un código de permiso inexistente es un error de programación (lanza TypeError),
 *   no un "no autorizado" silencioso.
 */
import { HttpError } from '../../middleware/http.js';
import { createPermissionRepository } from './repository.js';

/** @param {import('node:sqlite').DatabaseSync} db */
export function createAuthorizer(db) {
  const permissions = createPermissionRepository(db);
  const known = new Set(permissions.codes());
  const userState = db.prepare('SELECT role, status FROM users WHERE id = ?');

  /**
   * @param {{ id: number }} user
   * @param {string} code
   * @param {number} sectionId
   */
  function can(user, code, sectionId) {
    if (!known.has(code)) throw new TypeError(`Permiso desconocido: ${code}`);
    if (!Number.isSafeInteger(user?.id) || !Number.isSafeInteger(sectionId)) return false;
    const state = userState.get(user.id);
    if (!state || state.status !== 'active') return false;
    if (state.role === 'general_admin') return true;
    return permissions.hasGrant(user.id, sectionId, code);
  }

  /** Igual que `can`, pero lanza HttpError 403 `forbidden`. */
  function require(user, code, sectionId) {
    if (!can(user, code, sectionId)) throw new HttpError(403, 'forbidden');
  }

  return Object.freeze({ can, require });
}
