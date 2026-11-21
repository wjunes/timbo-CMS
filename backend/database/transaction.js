/**
 * Ejecución transaccional sobre `node:sqlite` (que no ofrece un ayudante propio).
 *
 * - Nivel superior: `BEGIN IMMEDIATE`. Reserva el bloqueo de escritura desde el
 *   inicio y evita el SQLITE_BUSY por "promoción" de lector a escritor en WAL.
 * - Anidado: `SAVEPOINT`, para que una operación pueda componerse dentro de otra.
 * - Cualquier excepción revierte y se relanza. La función debe ser síncrona:
 *   una promesa no puede mantener la transacción abierta de forma segura.
 */

let savepointCounter = 0;

/**
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  const nested = db.isTransaction;
  const savepoint = nested ? `sp_${++savepointCounter}` : null;

  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
    if (result !== null && typeof result?.then === 'function') {
      throw new TypeError('withTransaction requiere una función síncrona');
    }
  } catch (err) {
    try {
      db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    } catch {
      // Si SQLite ya revirtió la transacción (p. ej. por un error grave), no hay nada que deshacer.
    }
    throw err;
  }
  db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
  return result;
}
