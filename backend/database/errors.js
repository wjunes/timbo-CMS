/**
 * Clasificación de errores de SQLite (`node:sqlite`) por código extendido.
 * https://www.sqlite.org/rescode.html
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export function isUniqueViolation(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && (err.errcode === SQLITE_CONSTRAINT_UNIQUE || err.errcode === SQLITE_CONSTRAINT_PRIMARYKEY);
}

/** Restricción de un trigger: RAISE(ABORT, '<código>'). */
export function isTriggerAbort(err, code) {
  return err?.code === 'ERR_SQLITE_ERROR' && typeof err.message === 'string' && err.message.includes(code);
}
