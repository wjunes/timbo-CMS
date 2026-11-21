/**
 * Punto de entrada del servidor.
 * Valida la configuración (falla rápido si es inválida), abre la base de datos,
 * exige que el esquema esté al día (no migra automáticamente), arranca el
 * servidor HTTP y gestiona el cierre ordenado ante SIGINT/SIGTERM.
 */
import { createServer } from './app.js';
import { ConfigError, loadConfig } from './config/index.js';
import { closeDatabase, openDatabase } from './database/connection.js';
import { assertSchemaCurrent } from './database/migrator.js';
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

let db;
try {
  db = openDatabase(config.databasePath, { create: false });
  assertSchemaCurrent(db);
} catch (err) {
  logger.error('No se pudo preparar la base de datos', { err, database: config.databasePath });
  if (db) closeDatabase(db);
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

server.on('error', (err) => {
  logger.error('No se pudo iniciar el servidor', { err, host: config.host, port: config.port });
  closeDatabase(db);
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
    closeDatabase(db);
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

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
