/**
 * Copias de seguridad desde la línea de órdenes (Bloque 10, ver docs/BACKUPS.md).
 *
 *   node scripts/backup.js create                Crea una copia manual (con el servidor en marcha o no).
 *   node scripts/backup.js list                  Lista las copias.
 *   node scripts/backup.js verify <id>           Verifica una copia completa.
 *   node scripts/backup.js prune                 Aplica la retención a las copias automáticas.
 *   node scripts/backup.js restore <id> --confirm
 *                                                Restaura una copia. Exige el servidor DETENIDO;
 *                                                antes guarda una copia del estado actual.
 *
 * Usa la misma configuración que el servidor. Sale con código 1 si falla.
 */
import { ConfigError, MEMORY_DB, loadConfig } from '../backend/config/index.js';
import { closeDatabase, openDatabase } from '../backend/database/connection.js';
import { assertSchemaCurrent } from '../backend/database/migrator.js';
import { restoreBackup } from '../backend/modules/backups/restore.js';
import { BackupError, createBackupService } from '../backend/modules/backups/service.js';
import { createLogger } from '../backend/utils/logger.js';

const USAGE = 'Uso: node scripts/backup.js <create|list|verify <id>|prune|restore <id> --confirm>';
const [command, arg, flag] = process.argv.slice(2);
const out = (line) => process.stdout.write(`${line}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function withService(fn) {
  const config = loadConfig();
  if (config.databasePath === MEMORY_DB) throw new Error('DATABASE_PATH=":memory:" no tiene sentido para esta herramienta');
  const logger = createLogger({ level: config.logLevel, includeStack: !config.isProduction });
  const db = openDatabase(config.databasePath, { create: false });
  try {
    assertSchemaCurrent(db);
    return await fn(createBackupService({ db, storageDir: config.storageDir, logger }), config);
  } finally {
    closeDatabase(db);
  }
}

const describe = (b) => (b.broken
  ? `${b.id}  [DAÑADA: manifiesto ilegible]`
  : `${b.id}  ${b.kind.padEnd(11)} ${b.createdAt}  esquema ${String(b.schemaVersion).padStart(3, '0')}  ${b.fileCount} archivos  ${b.sizeBytes} bytes${b.warnings.length ? `  ${b.warnings.length} avisos` : ''}`);

async function run() {
  switch (command) {
    case 'create': {
      const b = await withService((s) => s.create({ kind: 'manual' }));
      out(`Copia creada y verificada: ${describe(b)}`);
      for (const w of b.warnings) out(`  aviso: ${JSON.stringify(w)}`);
      return;
    }
    case 'list': {
      const list = await withService((s) => s.list());
      if (!list.length) out('No hay copias.');
      for (const b of list) out(describe(b));
      return;
    }
    case 'verify': {
      if (!arg) return fail(USAGE);
      const { ok, issues } = await withService((s) => s.verify(arg));
      out(ok ? `Copia ${arg}: correcta.` : `Copia ${arg}: NO supera la verificación.`);
      for (const i of issues) out(`  ${JSON.stringify(i)}`);
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'prune': {
      const removed = await withService((s, config) => s.prune(config.backup.keep));
      out(removed.length ? `Retiradas: ${removed.join(', ')}` : 'Nada que retirar.');
      return;
    }
    case 'restore': {
      if (!arg) return fail(USAGE);
      if (flag !== '--confirm') {
        return fail(`La restauración sustituye la base y los archivos por los de la copia ${arg}.\n`
          + 'Detenga el servidor y repita la orden con --confirm. Antes se guardará una copia del estado actual.');
      }
      const config = loadConfig();
      if (config.databasePath === MEMORY_DB) return fail('DATABASE_PATH=":memory:" no tiene sentido para esta herramienta');
      const logger = createLogger({ level: config.logLevel, includeStack: !config.isProduction });
      const r = await restoreBackup({ config, id: arg, logger });
      out(`Copia ${r.id} restaurada. Copia del estado anterior: ${r.safetyBackupId ?? '(no había base)'}.`);
      out(`Migraciones aplicadas: ${r.migrationsApplied}. Sesiones revocadas: ${r.revokedCount}.`);
      return;
    }
    default:
      return fail(USAGE);
  }
}

try {
  await run();
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  else if (err instanceof BackupError) {
    fail(`Error: ${err.message} (${err.code})`);
    for (const i of err.details?.issues ?? []) process.stderr.write(`  ${JSON.stringify(i)}\n`);
  } else fail(`Error: ${err.message}`);
}
