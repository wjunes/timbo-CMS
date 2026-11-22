/**
 * Copias de seguridad (Bloque 10, D-060).
 *
 * Cada copia es un directorio `STORAGE_DIR/backups/<id>/` (id: AAAAMMDDhhmmss UTC):
 *
 *   manifest.json     formato, fecha, versión de la aplicación y del esquema,
 *                     tipo, autor, huella de la auditoría y SHA-256 de cada archivo
 *   database.sqlite   copia coherente hecha con la API de backup de SQLite
 *                     (nunca copiando el archivo en uso en WAL)
 *   media/<clave>     los archivos que figuran en esa copia de la base (no purgados)
 *   private/…         el directorio privado, si existe
 *
 * Se escribe en un directorio temporal, se verifica y solo entonces se renombra:
 * una copia a medias nunca aparece en la lista. Una sola copia a la vez (bloqueo
 * entre procesos). Toda operación se audita.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { PROJECT_ROOT } from '../../config/index.js';
import { createAuditLog } from '../audit/audit.js';
import { acquireLock } from './lock.js';

/** Versión de la aplicación (package.json), que se guarda en cada manifiesto. */
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

export const BACKUP_FORMAT = 'cms-multiseccion-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_ID = /^\d{14}$/;
export const BACKUP_KINDS = Object.freeze(['manual', 'automatic', 'pre_restore']);
const DB_FILE = 'database.sqlite';
const MEDIA_FILE = /^media\/[0-9a-f]{32}$/;
// Archivos privados: segmentos sin separadores, sin nombres ocultos ni "..".
const PRIVATE_FILE = /^private(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127})+$/;

export class BackupError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Formato del id: fecha UTC compacta. */
export function backupIdFor(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

const tableExists = (db, name) => db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Abre una copia de la base solo para leerla, sin confiar en su esquema. */
function openSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  db.exec('PRAGMA trusted_schema = OFF;');
  return db;
}

/** Datos de una copia de la base que el manifiesto debe reflejar. */
function describeSnapshot(db) {
  const migrations = tableExists(db, 'schema_migrations')
    ? db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all().map((m) => ({ ...m }))
    : [];
  const auditHead = tableExists(db, 'audit_chain')
    ? db.prepare('SELECT audit_id AS id, hash FROM audit_chain ORDER BY audit_id DESC LIMIT 1').get() ?? null
    : null;
  const purged = tableExists(db, 'media_purges') ? 'AND NOT EXISTS (SELECT 1 FROM media_purges AS p WHERE p.media_id = m.id)' : '';
  const media = tableExists(db, 'media')
    ? db.prepare(`SELECT m.id, m.storage_key, m.sha256 FROM media AS m WHERE 1 = 1 ${purged} ORDER BY m.id`).all()
    : [];
  return { migrations, auditHead: auditHead ? { id: auditHead.id, hash: auditHead.hash } : null, media };
}

/** Lista recursiva de archivos de un directorio (rutas relativas con "/"). Rechaza enlaces. */
async function listFiles(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (e.isFile()) out.push(r);
    else out.push({ unsupported: r });
  }
  return out;
}

function validManifestPath(p) {
  return typeof p === 'string' && (p === DB_FILE || MEDIA_FILE.test(p) || PRIVATE_FILE.test(p)) && !p.split('/').includes('..');
}

/**
 * Verifica una copia: manifiesto, huellas y tamaños de todos los archivos, que no
 * sobre ni falte ninguno, integridad de la base y coherencia con el manifiesto.
 * No modifica nada. Devuelve { ok, manifest, issues }.
 * @param {string} dir
 * @param {string} [expectedId]
 */
export async function verifyBackupDir(dir, expectedId = path.basename(dir)) {
  const issues = [];
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return { ok: false, manifest: null, issues: [{ code: err.code === 'ENOENT' ? 'manifest_missing' : 'manifest_invalid' }] };
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.id !== expectedId
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.schema?.migrations)) {
    return { ok: false, manifest: null, issues: [{ code: 'manifest_invalid' }] };
  }

  const listed = new Map();
  for (const f of manifest.files) {
    if (!validManifestPath(f?.path) || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.size) || listed.has(f.path)) {
      return { ok: false, manifest: null, issues: [{ code: 'manifest_invalid' }] };
    }
    listed.set(f.path, f);
  }
  if (!listed.has(DB_FILE)) issues.push({ code: 'file_missing', path: DB_FILE });

  const present = new Set();
  for (const entry of await listFiles(dir)) {
    if (typeof entry !== 'string') issues.push({ code: 'unexpected_file', path: entry.unsupported });
    else if (entry !== 'manifest.json') {
      present.add(entry);
      if (!listed.has(entry)) issues.push({ code: 'unexpected_file', path: entry });
    }
  }
  for (const [p, f] of listed) {
    if (!present.has(p)) {
      issues.push({ code: 'file_missing', path: p });
      continue;
    }
    const file = path.join(dir, ...p.split('/'));
    const { size } = await fs.promises.stat(file);
    if (size !== f.size || (await sha256File(file)) !== f.sha256) issues.push({ code: 'file_corrupt', path: p });
  }

  if (present.has(DB_FILE) && !issues.some((i) => i.path === DB_FILE)) {
    let db;
    try {
      db = openSnapshot(path.join(dir, DB_FILE));
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') issues.push({ code: 'database_corrupt' });
      else if (db.prepare('PRAGMA foreign_key_check').all().length) issues.push({ code: 'database_foreign_keys' });
      else {
        const snap = describeSnapshot(db);
        if (JSON.stringify(snap.migrations) !== JSON.stringify(manifest.schema.migrations)) issues.push({ code: 'schema_mismatch' });
        if (JSON.stringify(snap.auditHead) !== JSON.stringify(manifest.auditHead ?? null)) issues.push({ code: 'audit_head_mismatch' });
        const missingIds = new Set((manifest.warnings ?? []).filter((w) => w.code === 'media_file_missing').map((w) => w.mediaId));
        for (const m of snap.media) {
          if (!listed.has(`media/${m.storage_key}`) && !missingIds.has(m.id)) issues.push({ code: 'media_not_in_backup', mediaId: m.id });
        }
      }
    } catch {
      issues.push({ code: 'database_corrupt' });
    } finally {
      db?.close();
    }
  }
  return { ok: issues.length === 0, manifest, issues };
}

/** Resumen de un manifiesto para listados (sin rutas de archivos). */
function summarize(manifest) {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    createdBy: manifest.createdBy ?? null,
    appVersion: manifest.app?.version ?? null,
    schemaVersion: manifest.schema.migrations.at(-1)?.version ?? 0,
    fileCount: manifest.files.length,
    mediaCount: manifest.files.filter((f) => f.path.startsWith('media/')).length,
    sizeBytes: manifest.files.reduce((n, f) => n + f.size, 0),
    auditHead: manifest.auditHead ?? null,
    warnings: manifest.warnings ?? [],
  };
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, storageDir: string, appVersion?: string,
 *           logger: { info: Function, warn: Function, error: Function }, clock?: () => number }} deps
 */
export function createBackupService({ db, storageDir, appVersion = APP_VERSION, logger, clock = Date.now }) {
  const dir = path.join(storageDir, 'backups');
  const mediaDir = path.join(storageDir, 'media');
  const privateDir = path.join(storageDir, 'private');
  const audit = createAuditLog(db);
  let running = false;

  const backupDir = (id) => {
    if (!BACKUP_ID.test(String(id))) throw new BackupError('backup_not_found');
    return path.join(dir, String(id));
  };

  function exists(id) {
    try {
      return fs.statSync(backupDir(id)).isDirectory();
    } catch {
      return false;
    }
  }

  function nextId() {
    let id = Number(backupIdFor(clock()));
    // Dos copias en el mismo segundo: el id avanza (la fecha real va en el manifiesto).
    while (exists(String(id))) id += 1;
    return String(id);
  }

  async function copyPrivate(target, files, warnings) {
    for (const entry of await listFiles(privateDir)) {
      const rel = typeof entry === 'string' ? `private/${entry}` : `private/${entry.unsupported}`;
      if (typeof entry !== 'string' || !PRIVATE_FILE.test(rel)) {
        warnings.push({ code: 'private_file_skipped', path: rel });
        continue;
      }
      const dest = path.join(target, ...rel.split('/'));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(path.join(privateDir, ...entry.split('/')), dest, fs.constants.COPYFILE_EXCL);
      const { size } = await fs.promises.stat(dest);
      files.push({ path: rel, size, sha256: await sha256File(dest) });
    }
  }

  /**
   * Crea y verifica una copia.
   * @param {{ kind?: 'manual'|'automatic'|'pre_restore', actorUserId?: number|null, ip?: string|null }} [options]
   */
  async function create({ kind = 'manual', actorUserId = null, ip = null } = {}) {
    if (!BACKUP_KINDS.includes(kind)) throw new TypeError(`Tipo de copia inválido: ${kind}`);
    if (running) throw new BackupError('backup_in_progress');
    running = true;
    let release;
    let tmp;
    const startedAt = clock();
    try {
      try {
        release = acquireLock(path.join(dir, '.lock'), 'backup');
      } catch (err) {
        if (err.code === 'lock_held') throw new BackupError('backup_in_progress');
        throw err;
      }
      // Con el bloqueo tomado nadie más está escribiendo: se retiran restos de copias interrumpidas.
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith('.tmp-')) await fs.promises.rm(path.join(dir, e.name), { recursive: true, force: true });
      }
      const id = nextId();
      tmp = path.join(dir, `.tmp-${id}-${randomBytes(4).toString('hex')}`);
      await fs.promises.mkdir(tmp, { recursive: true, mode: 0o700 });

      const dbFile = path.join(tmp, DB_FILE);
      await sqliteBackup(db, dbFile);
      // La copia queda en modo rollback: un solo archivo, legible sin -wal ni -shm.
      const copy = new DatabaseSync(dbFile, { allowExtension: false });
      let snap;
      try {
        copy.exec('PRAGMA trusted_schema = OFF;');
        copy.prepare('PRAGMA journal_mode = DELETE').get();
        snap = describeSnapshot(copy);
      } finally {
        copy.close();
      }

      const files = [{ path: DB_FILE, size: (await fs.promises.stat(dbFile)).size, sha256: await sha256File(dbFile) }];
      const warnings = [];
      if (snap.media.length) await fs.promises.mkdir(path.join(tmp, 'media'), { mode: 0o700 });
      for (const m of snap.media) {
        const dest = path.join(tmp, 'media', m.storage_key);
        try {
          await fs.promises.copyFile(path.join(mediaDir, m.storage_key), dest, fs.constants.COPYFILE_EXCL);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          warnings.push({ code: 'media_file_missing', mediaId: m.id });
          continue;
        }
        const sha256 = await sha256File(dest);
        if (sha256 !== m.sha256) warnings.push({ code: 'media_hash_mismatch', mediaId: m.id });
        files.push({ path: `media/${m.storage_key}`, size: (await fs.promises.stat(dest)).size, sha256 });
      }
      await copyPrivate(tmp, files, warnings);

      const manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        id,
        createdAt: new Date(startedAt).toISOString(),
        kind,
        createdBy: actorUserId,
        app: { name: 'cms-multiseccion', version: appVersion },
        schema: { migrations: snap.migrations },
        auditHead: snap.auditHead,
        files,
        warnings,
      };
      await fs.promises.writeFile(path.join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

      const check = await verifyBackupDir(tmp, id);
      if (!check.ok) throw new BackupError('backup_verification_failed', 'La copia recién creada no supera la verificación', { issues: check.issues });
      await fs.promises.rename(tmp, backupDir(id));
      tmp = null;

      const summary = summarize(manifest);
      audit.record({
        action: 'backup.create', outcome: 'success', actorUserId, entityType: 'backup', ip,
        details: { id, kind, files: summary.fileCount, bytes: summary.sizeBytes, warnings: warnings.length, durationMs: clock() - startedAt },
      });
      logger.info('Copia de seguridad creada', { id, kind, files: summary.fileCount, bytes: summary.sizeBytes, warnings: warnings.length });
      return summary;
    } catch (err) {
      if (!(err instanceof BackupError && err.code === 'backup_in_progress')) {
        audit.record({
          action: 'backup.create', outcome: 'failure', actorUserId, entityType: 'backup', ip,
          details: { kind, error: err instanceof BackupError ? err.code : 'internal_error' },
        });
        logger.error('Fallo al crear la copia de seguridad', { err, kind });
      }
      throw err;
    } finally {
      if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      release?.();
      running = false;
    }
  }

  /** Copias completas (las que tienen un manifiesto legible), de la más reciente a la más antigua. */
  async function list() {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !BACKUP_ID.test(e.name)) continue;
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, e.name, 'manifest.json'), 'utf8'));
        if (manifest?.format !== BACKUP_FORMAT || manifest.id !== e.name || !Array.isArray(manifest.files)
          || !Array.isArray(manifest.schema?.migrations)) throw new Error('manifest');
        out.push(summarize(manifest));
      } catch {
        out.push({ id: e.name, broken: true });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async function get(id) {
    const found = (await list()).find((b) => b.id === String(id));
    if (!found) throw new BackupError('backup_not_found');
    return found;
  }

  async function verify(id, { actorUserId = null, ip = null } = {}) {
    if (!exists(id)) throw new BackupError('backup_not_found');
    const { ok, issues } = await verifyBackupDir(backupDir(id), String(id));
    audit.record({
      action: 'backup.verify', outcome: ok ? 'success' : 'failure', actorUserId, entityType: 'backup', ip,
      details: { id: String(id), issues: issues.slice(0, 20) },
    });
    return { ok, issues };
  }

  async function remove(id, { actorUserId = null, ip = null, action = 'backup.delete' } = {}) {
    if (!exists(id)) throw new BackupError('backup_not_found');
    await fs.promises.rm(backupDir(id), { recursive: true, force: true });
    audit.record({ action, outcome: 'success', actorUserId, entityType: 'backup', ip, details: { id: String(id) } });
  }

  /** Retención: conserva las `keep` copias automáticas más recientes. Las demás no se tocan. */
  async function prune(keep) {
    const automatic = (await list()).filter((b) => b.kind === 'automatic');
    const removed = [];
    for (const b of automatic.slice(keep)) {
      await fs.promises.rm(backupDir(b.id), { recursive: true, force: true });
      removed.push(b.id);
    }
    if (removed.length) {
      audit.record({ action: 'backup.prune', outcome: 'success', entityType: 'backup', details: { keep, removed } });
      logger.info('Copias automáticas retiradas por la política de retención', { keep, removed });
    }
    return removed;
  }

  /** Huellas de auditoría guardadas en las copias: anclas para verificar la cadena. */
  async function anchors() {
    return (await list()).filter((b) => !b.broken && b.auditHead).map((b) => ({ source: b.id, id: b.auditHead.id, hash: b.auditHead.hash }));
  }

  return Object.freeze({ dir, create, list, get, verify, remove, prune, anchors, isRunning: () => running, backupDir });
}
