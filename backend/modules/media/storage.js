/**
 * Archivos multimedia en disco: `STORAGE_DIR/media/<clave>`.
 *
 * - La clave es aleatoria (128 bits en hexadecimal), sin extensión ni nada del
 *   nombre original: no hay rutas, separadores ni nombres elegidos por el cliente.
 * - Antes de usar una clave se comprueba su forma y que la ruta resultante queda
 *   dentro del directorio (defensa adicional al CHECK de la migración 001).
 * - Escritura atómica: archivo temporal exclusivo, `fsync` y renombrado. Un
 *   archivo nunca se ve a medio escribir.
 * - Los archivos solo se leen y se envían como datos con el MIME guardado en la
 *   base; el servidor no los interpreta ni los ejecuta.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY = /^[0-9a-f]{32}$/;

/** @param {string} storageDir */
export function createMediaStorage(storageDir) {
  const dir = path.join(storageDir, 'media');
  let ready = false;

  function filePath(key) {
    if (!KEY.test(key)) throw new TypeError('Clave de almacenamiento inválida');
    const resolved = path.join(dir, key);
    if (path.dirname(resolved) !== dir) throw new TypeError('Clave de almacenamiento inválida');
    return resolved;
  }

  async function ensureDir() {
    if (ready) return;
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    ready = true;
  }

  /** Guarda el contenido y devuelve su clave. */
  async function save(buffer) {
    await ensureDir();
    const key = randomBytes(16).toString('hex');
    const tmp = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    const handle = await fs.promises.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    try {
      await fs.promises.rename(tmp, filePath(key));
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    return key;
  }

  /** Borra un archivo recién guardado cuando su registro no llegó a la base. */
  async function discard(key) {
    await fs.promises.rm(filePath(key), { force: true });
  }

  /**
   * Abre el archivo para enviarlo.
   * @returns {Promise<{ size: number, stream: import('node:fs').ReadStream } | null>} null si no existe.
   */
  async function open(key) {
    let handle;
    try {
      handle = await fs.promises.open(filePath(key), 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      return { size, stream: handle.createReadStream() };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  return Object.freeze({ dir, save, discard, open, filePath });
}
