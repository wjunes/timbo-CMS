/**
 * Punto de entrada del servidor.
 * Valida la configuración (falla rápido si es inválida), abre la base de datos,
 * exige que el esquema esté al día (no migra automáticamente), arranca el
 * servidor HTTP y gestiona el cierre ordenado ante SIGINT/SIGTERM.
 *
 * Mientras está en marcha mantiene el bloqueo STORAGE_DIR/cms.lock: no se puede
 * restaurar una copia con el servidor activo (D-060). También programa las
 * copias de seguridad automáticas.
 */
import { createServer } from './app.js';
import { ConfigError, loadConfig } from './config/index.js';
import { closeDatabase, openDatabase } from './database/connection.js';
import { assertSchemaCurrent } from './database/migrator.js';
import { createBackupScheduler } from './modules/backups/index.js';
import { acquireLock, serverLockFile } from './modules/backups/lock.js';
import { createLogger } from './utils/logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel, includeStack: !config.isProduction });

let releaseLock;
try {
  releaseLock = acquireLock(serverLockFile(config.storageDir), 'server');
} catch (err) {
  logger.error('No se pudo tomar el bloqueo del servidor: ¿hay otro servidor o una restauración en marcha?', { err });
  process.exit(1);
}

let db;
try {
  db = openDatabase(config.databasePath, { create: false });
  assertSchemaCurrent(db);
} catch (err) {
  logger.error('No se pudo preparar la base de datos', { err, database: config.databasePath });
  if (db) closeDatabase(db);
  releaseLock();
  process.exit(1);
}

const server = createServer({ config, logger, db });

// Purga periódica de sesiones caducadas o revocadas (tras un margen de 24 h).
const SESSION_PURGE_INTERVAL_MS = 15 * 60_000;
const purgeTimer = setInterval(() => {
  try {
    const removed = server.auth.purgeExpiredSessions();
    if (removed) logger.debug('Sesiones purgadas', { removed });
  } catch (err) {
    logger.error('Fallo al purgar sesiones', { err });
  }
}, SESSION_PURGE_INTERVAL_MS);
purgeTimer.unref();

const backupScheduler = createBackupScheduler({
  service: server.backups, intervalHours: config.backup.intervalHours, keep: config.backup.keep, logger,
});
backupScheduler.start();

server.on('error', (err) => {
  logger.error('No se pudo iniciar el servidor', { err, host: config.host, port: config.port });
  backupScheduler.stop();
  closeDatabase(db);
  releaseLock();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  logger.info('Servidor iniciado', { env: config.env, url: config.baseUrl, listen: `${config.host}:${config.port}` });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Cerrando servidor', { signal });
  const exit = () => {
    clearInterval(purgeTimer);
    backupScheduler.stop();
    closeDatabase(db);
    releaseLock();
    process.exit(0);
  };
  server.close(exit);
  server.closeIdleConnections();
  // Si quedan conexiones activas, se fuerza el cierre tras un margen razonable.
  setTimeout(() => {
    server.closeAllConnections();
    exit();
  }, 10_000).unref();
}

// Un error no capturado deja el proceso en un estado desconocido: se registra,
// se libera el bloqueo y se termina con código 1 para que el supervisor
// (systemd, ver docs/DEPLOYMENT.md) lo reinicie. La base no queda a medias:
// toda escritura es una transacción.
function fatal(kind, err) {
  logger.error('Error fatal: el proceso termina', { kind, err });
  try {
    backupScheduler.stop();
    closeDatabase(db);
  } catch {
    // Lo importante es terminar.
  }
  releaseLock();
  process.exit(1);
}
process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (err) => fatal('unhandledRejection', err));

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
