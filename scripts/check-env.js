/**
 * Verificación del entorno de ejecución: versión de Node.js, APIs nativas
 * requeridas por el proyecto y validez de la configuración.
 * Sale con código 1 si alguna comprobación falla.
 */
import fs from 'node:fs';
import { ConfigError, MEMORY_DB, loadConfig } from '../backend/config/index.js';

// Importación dinámica: si node:sqlite no existe, la comprobación correspondiente lo
// informa en lugar de que el script falle al cargar.
const dbModules = await Promise.all([
  import('../backend/database/connection.js'),
  import('../backend/database/migrator.js'),
]).catch(() => null);

// crypto.argon2 se incorporó en Node.js 24.7.0 (D-007).
const REQUIRED_NODE = [24, 7];
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
  } catch (err) {
    results.push({ ok: false, name, detail: err.message });
  }
}

check('Versión de Node.js', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < REQUIRED_NODE[0] || (major === REQUIRED_NODE[0] && minor < REQUIRED_NODE[1])) {
    throw new Error(`se requiere >= ${REQUIRED_NODE.join('.')}.0, instalada ${process.version}`);
  }
  return process.version;
});

check('node:sqlite', () => {
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite?.DatabaseSync) throw new Error('DatabaseSync no disponible');
  if (typeof sqlite.backup !== 'function') throw new Error('backup() no disponible');
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    return `SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`;
  } finally {
    db.close();
  }
});

check('node:crypto (Argon2 y aleatoriedad)', () => {
  const crypto = process.getBuiltinModule('node:crypto');
  if (typeof crypto.randomBytes !== 'function') throw new Error('randomBytes no disponible');
  // Argon2id es obligatorio para las contraseñas (Bloque 03): su ausencia es un fallo.
  if (typeof crypto.argon2 !== 'function') throw new Error('crypto.argon2 no disponible');
  return 'argon2 nativo disponible';
});

check('Configuración', () => {
  try {
    const c = loadConfig();
    return `env=${c.env} listen=${c.host}:${c.port} baseUrl=${c.baseUrl}`;
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(err.issues.join('; '));
    throw err;
  }
});

check('Base de datos', () => {
  let c;
  try {
    c = loadConfig();
  } catch {
    throw new Error('configuración inválida (ver arriba)');
  }
  if (c.databasePath === MEMORY_DB) return 'en memoria (:memory:)';
  if (!dbModules) throw new Error('no se pudieron cargar los módulos de base de datos');
  const [{ closeDatabase, openDatabase }, { getMigrationStatus, loadMigrations }] = dbModules;
  if (!fs.existsSync(c.databasePath)) return `${c.databasePath} (no existe; ejecute "npm run db:migrate")`;
  const db = openDatabase(c.databasePath, { create: false });
  try {
    const { pending, issues } = getMigrationStatus(db, loadMigrations());
    if (issues.length) throw new Error(issues.join('; '));
    if (pending.length) throw new Error(`${pending.length} migración(es) pendiente(s); ejecute "npm run db:migrate"`);
    return `${c.databasePath} (esquema al día)`;
  } finally {
    closeDatabase(db);
  }
});

for (const r of results) {
  process.stdout.write(`${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}\n`);
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(failed ? `\n${failed} comprobación(es) fallida(s).\n` : '\nEntorno correcto.\n');
process.exitCode = failed ? 1 : 0;
