/**
 * Apertura de la conexión SQLite (`node:sqlite`) con una configuración segura y
 * coherente. Toda conexión del proyecto debe abrirse mediante `openDatabase`.
 *
 * - WAL para lecturas concurrentes con un único escritor (solo en archivo).
 * - Claves foráneas activas (no se confía en el valor por defecto).
 * - `busy_timeout` para esperar al escritor en lugar de fallar de inmediato.
 * - `trusted_schema=OFF` y modo defensivo: el esquema no puede invocar funciones
 *   con efectos ni corromperse mediante `writable_schema`.
 * - Carga de extensiones deshabilitada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_DB } from '../config/index.js';

export const BUSY_TIMEOUT_MS = 5_000;

/**
 * @param {string} location Ruta absoluta del archivo o ':memory:'.
 * @param {{ create?: boolean }} [options] create=false falla si el archivo no existe.
 * @returns {DatabaseSync}
 */
export function openDatabase(location, { create = true } = {}) {
  const inMemory = location === MEMORY_DB;
  if (!inMemory) {
    if (!path.isAbsolute(location)) throw new TypeError('La ruta de la base de datos debe ser absoluta');
    if (!create && !fs.existsSync(location)) {
      throw new Error(`La base de datos no existe: ${location}. Ejecute "npm run db:migrate".`);
    }
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
    timeout: BUSY_TIMEOUT_MS,
  });

  try {
    db.enableDefensive(true);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    `);
    if (!inMemory) {
      const { journal_mode: mode } = db.prepare('PRAGMA journal_mode = WAL').get();
      if (String(mode).toLowerCase() !== 'wal') throw new Error(`No se pudo activar WAL (modo actual: ${mode})`);
      // NORMAL es seguro frente a corrupción en WAL; solo puede perder la última transacción ante un corte de energía.
      db.exec('PRAGMA synchronous = NORMAL;');
    }
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
      throw new Error('No se pudieron activar las claves foráneas');
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Cierra la conexión intentando antes un checkpoint del WAL (no crítico).
 * @param {DatabaseSync} db
 */
export function closeDatabase(db) {
  if (!db.isOpen) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // Un lector activo puede impedir el checkpoint; SQLite lo hará más adelante.
  }
  db.close();
}
