/**
 * Escritura en el registro de auditoría (tabla de solo inserción, ver docs/DATABASE.md).
 *
 * Los detalles pasan por la misma redacción que el logger: nunca se registran
 * contraseñas, tokens, cookies ni hashes. La consulta y la verificación de
 * integridad del registro se incorporan en el Bloque 10.
 */
import { redact } from '../../utils/logger.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createAuditLog(db) {
  const insert = db.prepare(`
    INSERT INTO audit_logs (actor_user_id, action, outcome, entity_type, entity_id, section_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  /**
   * @param {{ action: string, outcome: 'success'|'failure'|'denied', actorUserId?: number|null,
   *           entityType?: string|null, entityId?: number|null, sectionId?: number|null,
   *           ip?: string|null, details?: Record<string, unknown> }} entry
   */
  function record({ action, outcome, actorUserId = null, entityType = null, entityId = null, sectionId = null, ip = null, details = {} }) {
    insert.run(actorUserId, action, outcome, entityType, entityId, sectionId, ip?.slice(0, 45) ?? null, JSON.stringify(redact(details)));
  }

  return Object.freeze({ record });
}
