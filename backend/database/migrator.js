/**
 * Migraciones versionadas, solo hacia delante.
 *
 * - Archivos `NNN_nombre.sql` en `migrations/`, numerados de forma contigua desde 001.
 * - Cada migración se aplica en su propia transacción (`BEGIN IMMEDIATE`) junto con
 *   su registro en `schema_migrations`; si falla, no queda nada aplicado a medias.
 * - Se guarda el SHA-256 de cada archivo: una migración ya aplicada no puede
 *   modificarse. Si cambia, se detiene todo (los cambios van en una migración nueva).
 * - Tras cada migración se ejecuta `foreign_key_check`; al final, `integrity_check`.
 * - No hay migraciones "down": la vuelta atrás se hace restaurando un backup.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './transaction.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;
// Una migración no debe gestionar su propia transacción: lo hace el migrador.
const TRANSACTION_CONTROL = /^\s*(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?\s*;|COMMIT\b|END\s+TRANSACTION\b|ROLLBACK\b|SAVEPOINT\b|RELEASE\b)/im;

export class MigrationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'MigrationError';
  }
}

/** Normaliza finales de línea para que el checksum no dependa del sistema operativo. */
function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Lee y valida los archivos de migración.
 * @param {string} [dir]
 * @returns {{ version: number, name: string, file: string, sql: string, checksum: string }[]}
 */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.sql'));
  const migrations = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry.name);
    if (!match) throw new MigrationError(`Nombre de migración inválido: ${entry.name} (formato NNN_nombre.sql)`);
    const sql = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    if (sql.trim() === '') throw new MigrationError(`Migración vacía: ${entry.name}`);
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new MigrationError(`La migración ${entry.name} no debe contener control de transacciones`);
    }
    migrations.push({ version: Number(match[1]), name: match[2], file: entry.name, sql, checksum: checksum(sql) });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(`Secuencia de migraciones no contigua o duplicada en ${m.file} (se esperaba ${String(i + 1).padStart(3, '0')})`);
    }
  });
  return migrations;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY CHECK (version >= 1),
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
}

function hasMigrationsTable(db) {
  return db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get() !== undefined;
}

/**
 * Compara las migraciones disponibles con las aplicadas. No modifica la base de datos.
 * @returns {{ applied: object[], pending: object[], issues: string[] }}
 */
export function getMigrationStatus(db, migrations = loadMigrations()) {
  const appliedRows = hasMigrationsTable(db)
    ? db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all()
    : [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const issues = [];

  for (const row of appliedRows) {
    const m = byVersion.get(row.version);
    if (!m) issues.push(`La migración aplicada ${row.version} (${row.name}) no existe en el código`);
    else if (m.checksum !== row.checksum) issues.push(`La migración ${m.file} fue modificada después de aplicarse (checksum distinto)`);
  }
  const appliedVersions = new Set(appliedRows.map((r) => r.version));
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  const maxApplied = appliedRows.length ? appliedRows[appliedRows.length - 1].version : 0;
  if (pending.some((m) => m.version < maxApplied)) issues.push('Hay migraciones pendientes anteriores a la última aplicada');

  return { applied: appliedRows, pending, issues };
}

/**
 * Aplica las migraciones pendientes.
 * @returns {{ applied: { version: number, name: string }[] }}
 */
export function migrate(db, { migrations = loadMigrations(), logger } = {}) {
  ensureMigrationsTable(db);
  const status = getMigrationStatus(db, migrations);
  if (status.issues.length) throw new MigrationError(`Estado de migraciones inconsistente:\n  - ${status.issues.join('\n  - ')}`);

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  const applied = [];
  for (const m of status.pending) {
    try {
      withTransaction(db, () => {
        db.exec(m.sql);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new MigrationError(`Violaciones de claves foráneas: ${JSON.stringify(violations)}`);
        insert.run(m.version, m.name, m.checksum);
      });
    } catch (err) {
      throw new MigrationError(`Falló la migración ${m.file}: ${err.message}`, { cause: err });
    }
    applied.push({ version: m.version, name: m.name });
    logger?.info('Migración aplicada', { version: m.version, name: m.name });
  }

  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
  if (integrity.length !== 1 || integrity[0] !== 'ok') {
    throw new MigrationError(`integrity_check falló: ${integrity.join('; ')}`);
  }
  return { applied };
}

/**
 * Verifica que el esquema esté al día. Lo usa el servidor al arrancar: no migra
 * automáticamente (las migraciones se ejecutan de forma explícita con `db:migrate`).
 */
export function assertSchemaCurrent(db, migrations = loadMigrations()) {
  const { pending, issues } = getMigrationStatus(db, migrations);
  if (issues.length) throw new MigrationError(`Estado de migraciones inconsistente:\n  - ${issues.join('\n  - ')}`);
  if (pending.length) {
    throw new MigrationError(`Hay ${pending.length} migración(es) pendiente(s): ${pending.map((m) => m.file).join(', ')}. Ejecute "npm run db:migrate".`);
  }
}
