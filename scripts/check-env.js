/**
 * Verificación del entorno de ejecución: versión de Node.js, APIs nativas
 * requeridas por el proyecto y validez de la configuración. Con
 * NODE_ENV=production añade las comprobaciones de despliegue (Bloque 11,
 * ver docs/DEPLOYMENT.md).
 * Sale con código 1 si alguna comprobación falla.
 */
import fs from 'node:fs';
import { ConfigError, MEMORY_DB, loadConfig } from '../backend/config/index.js';
import { ThemeError, loadThemeCatalog } from '../backend/modules/themes/catalog.js';

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

// Multimedia y panel (Bloque 08): CRC de PNG, descompresión acotada de PDF y
// recorrido recursivo del directorio del panel.
check('node:zlib y node:fs (multimedia y panel)', () => {
  const zlib = process.getBuiltinModule('node:zlib');
  if (typeof zlib.crc32 !== 'function') throw new Error('zlib.crc32 no disponible');
  if (zlib.crc32('IEND') !== 0xae426082) throw new Error('zlib.crc32 devuelve un valor inesperado');
  zlib.inflateSync(zlib.deflateSync(Buffer.alloc(8)), { maxOutputLength: 16 });
  const entry = fs.readdirSync(import.meta.dirname, { recursive: true, withFileTypes: true })[0];
  if (typeof entry?.parentPath !== 'string') throw new Error('Dirent.parentPath no disponible');
  return 'crc32, inflate con límite y readdir recursivo disponibles';
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

// Paletas (Bloque 12): las de serie y las de THEMES_FILE, con su contraste.
check('Paletas de colores', () => {
  let c;
  try {
    c = loadConfig();
  } catch {
    throw new Error('configuración inválida (ver arriba)');
  }
  try {
    const catalog = loadThemeCatalog(c.themesFile);
    const custom = catalog.list.filter((p) => p.custom).length;
    return `${catalog.list.length} paletas${custom ? ` (${custom} de ${c.themesFile})` : ''}, contraste AA comprobado`;
  } catch (err) {
    if (err instanceof ThemeError) throw new Error(err.issues.join('; '));
    throw err;
  }
});

// --- Despliegue (Bloque 11): solo en producción -------------------------------
let prod = null;
try {
  const c = loadConfig();
  if (c.isProduction) prod = c;
} catch {
  // La configuración inválida ya se ha informado.
}

if (prod) {
  check('Producción: escucha solo en local, detrás del proxy HTTPS', () => {
    if (!['127.0.0.1', '::1', 'localhost'].includes(prod.host)) {
      throw new Error(`HOST=${prod.host}: el servidor quedaría accesible por HTTP sin pasar por el proxy; use 127.0.0.1`);
    }
    return `${prod.host}:${prod.port}, URL pública ${prod.baseUrl}`;
  });

  check('Producción: IP real del cliente (TRUST_PROXY)', () => {
    // Sin ella, todas las peticiones parecen venir del proxy: los límites por IP
    // se aplicarían a todos los visitantes a la vez.
    if (!prod.trustProxy) throw new Error('TRUST_PROXY=false detrás de un proxy: active TRUST_PROXY=true');
    return 'TRUST_PROXY=true';
  });

  check('Producción: nivel de registro', () => {
    if (prod.logLevel === 'debug') throw new Error('LOG_LEVEL=debug no es adecuado en producción');
    return prod.logLevel;
  });

  check('Producción: almacenamiento escribible', () => {
    fs.mkdirSync(prod.storageDir, { recursive: true });
    const probe = `${prod.storageDir}/.check-${process.pid}`;
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return prod.storageDir;
  });

  check('Producción: administrador general', () => {
    if (!dbModules || !fs.existsSync(prod.databasePath)) throw new Error('la base de datos no existe');
    const [{ closeDatabase, openDatabase }] = dbModules;
    const db = openDatabase(prod.databasePath, { create: false });
    try {
      const row = db.prepare("SELECT count(*) AS n FROM users WHERE role = 'general_admin' AND status = 'active'").get();
      if (!row.n) throw new Error('no existe; ejecute "npm run admin:create"');
      return 'existe';
    } finally {
      closeDatabase(db);
    }
  });

  check('Producción: copias de seguridad', () => {
    const dir = `${prod.storageDir}/backups`;
    const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^d{14}$/.test(n)).sort() : [];
    const auto = prod.backup.intervalHours ? `automáticas cada ${prod.backup.intervalHours} h, se conservan ${prod.backup.keep}` : 'automáticas DESACTIVADAS (prográmelas con el sistema)';
    return `${auto}; ${ids.length ? `última: ${ids.at(-1)}` : 'todavía ninguna'}. Recuerde copiarlas fuera del servidor.`;
  });
}

for (const r of results) {
  process.stdout.write(`${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}\n`);
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(failed ? `\n${failed} comprobación(es) fallida(s).\n` : '\nEntorno correcto.\n');
process.exitCode = failed ? 1 : 0;
