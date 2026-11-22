/**
 * Bloqueos entre procesos con un archivo (creación exclusiva `wx`).
 *
 * - `cms.lock` en STORAGE_DIR: lo mantiene el servidor mientras está en marcha
 *   y lo toma la restauración, así que nunca se restaura con el servidor activo
 *   ni arranca un servidor a mitad de una restauración (D-060).
 * - `.lock` en backups/: una sola copia de seguridad a la vez, también entre el
 *   servidor y la herramienta de línea de órdenes.
 *
 * El archivo guarda el PID. Si ese proceso ya no existe (cierre brusco), el
 * bloqueo se considera abandonado y se reemplaza.
 */
import fs from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  constructor(file, holder) {
    super(`Bloqueo ocupado: ${file}${holder?.pid ? ` (proceso ${holder.pid}, ${holder.purpose ?? 'desconocido'})` : ''}`);
    this.name = 'LockError';
    this.code = 'lock_held';
    this.holder = holder;
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Toma el bloqueo o lanza LockError. Devuelve la función que lo libera.
 * @param {string} file
 * @param {string} purpose
 */
export function acquireLock(file, purpose) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readHolder(file)?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      // Un archivo a medio escribir (holder null) por otro proceso se trata como ocupado.
      if (holder === null || (isAlive(holder.pid) && holder.pid !== process.pid) || attempt > 0) throw new LockError(file, holder);
      if (holder.pid === process.pid) throw new LockError(file, holder);
      fs.rmSync(file, { force: true }); // abandonado
    }
  }
  throw new LockError(file, readHolder(file));
}

export const serverLockFile = (storageDir) => path.join(storageDir, 'cms.lock');
