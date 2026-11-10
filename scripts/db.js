/**
 * Herramienta de línea de órdenes para la base de datos.
 *
 *   node scripts/db.js migrate   Aplica las migraciones pendientes.
 *   node scripts/db.js status    Muestra migraciones aplicadas y pendientes (no modifica nada).
 *
 * Usa la misma configuración que el servidor (DATABASE_PATH). Sale con código 1 si falla.
 */
import fs from 'node:fs';
import { ConfigError, MEMORY_DB, loadConfig } from '../backend/config/index.js';
import { closeDatabase, openDatabase } from '../backend/database/connection.js';
import { getMigrationStatus, loadMigrations, migrate } from '../backend/database/migrator.js';
import { createLogger } from '../backend/utils/logger.js';

const COMMANDS = ['migrate', 'status'];
const command = process.argv[2];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function run() {
  if (!COMMANDS.includes(command)) return fail(`Uso: node scripts/db.js <${COMMANDS.join('|')}>`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message);
    throw err;
  }
  if (config.databasePath === MEMORY_DB) return fail('DATABASE_PATH=":memory:" no tiene sentido para esta herramienta');

  const logger = createLogger({ level: config.logLevel, includeStack: !config.isProduction });
  const migrations = loadMigrations();

  if (command === 'status') {
    if (!fs.existsSync(config.databasePath)) {
      process.stdout.write(`Base de datos: ${config.databasePath} (no existe)\nPendientes: ${migrations.length}\n`);
      return;
    }
    const db = openDatabase(config.databasePath, { create: false });
    try {
      const { applied, pending, issues } = getMigrationStatus(db, migrations);
      process.stdout.write(`Base de datos: ${config.databasePath}\n`);
      for (const a of applied) process.stdout.write(`  [aplicada]  ${String(a.version).padStart(3, '0')}_${a.name}  ${a.applied_at}\n`);
      for (const p of pending) process.stdout.write(`  [pendiente] ${p.file}\n`);
      for (const i of issues) process.stdout.write(`  [ERROR]     ${i}\n`);
      if (issues.length) process.exitCode = 1;
    } finally {
      closeDatabase(db);
    }
    return;
  }

  const db = openDatabase(config.databasePath);
  try {
    const { applied } = migrate(db, { migrations, logger });
    logger.info(applied.length ? 'Migraciones completadas' : 'El esquema ya estaba al día', {
      database: config.databasePath,
      applied: applied.length,
    });
  } finally {
    closeDatabase(db);
  }
}

try {
  run();
} catch (err) {
  fail(`Error: ${err.message}`);
}
