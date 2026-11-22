/**
 * Escritura en el registro de auditoría (tabla de solo inserción, ver docs/DATABASE.md).
 *
 * Los detalles pasan por la misma redacción que el logger: nunca se registran
 * contraseñas, tokens, cookies ni hashes.
 *
 * Cada entrada se encadena (huella SHA-256) en la misma transacción en que se
 * inserta (Bloque 10, D-059). La consulta y la verificación están en index.js.
 */
import { withTransaction } from '../../database/transaction.js';
import { redact } from '../../utils/logger.js';
import { createAuditChain } from './chain.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createAuditLog(db) {
  const insert = db.prepare(`
    INSERT INTO audit_logs (actor_user_id, action, outcome, entity_type, entity_id, section_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const chain = createAuditChain(db);

  /**
   * @param {{ action: string, outcome: 'success'|'failure'|'denied', actorUserId?: number|null,
   *           entityType?: string|null, entityId?: number|null, sectionId?: number|null,
   *           ip?: string|null, details?: Record<string, unknown> }} entry
   */
  function record({ action, outcome, actorUserId = null, entityType = null, entityId = null, sectionId = null, ip = null, details = {} }) {
    withTransaction(db, () => {
      insert.run(actorUserId, action, outcome, entityType, entityId, sectionId, ip?.slice(0, 45) ?? null, JSON.stringify(redact(details)));
      chain.seal();
    });
  }

  return Object.freeze({ record });
}
