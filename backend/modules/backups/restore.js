/**
 * Restauración controlada de una copia (D-060). Solo desde la línea de órdenes
 * y con el servidor detenido (bloqueo `cms.lock`).
 *
 *   1. Verifica la copia completa (huellas, base, manifiesto).
 *   2. Comprueba el esquema: las migraciones de la copia deben ser las primeras
 *      del código, con el mismo checksum. Una copia más nueva que el código se rechaza.
 *   3. Copia de seguridad del estado actual (tipo `pre_restore`).
 *   4. Prepara la base y los archivos al lado y los intercambia con renombrados;
 *      si un paso falla, deshace los anteriores.
 *   5. Aplica las migraciones pendientes, revoca todas las sesiones restauradas
 *      y registra `backup.restore` en la auditoría de la base restaurada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../../database/connection.js';
import { loadMigrations, migrate } from '../../database/migrator.js';
import { createAuditLog } from '../audit/audit.js';
import { acquireLock, serverLockFile } from './lock.js';
import { BACKUP_ID, BackupError, createBackupService, verifyBackupDir } from './service.js';

async function exists(p) {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Copia los archivos de `prefix/` de la copia a un directorio nuevo. */
async function stageFiles(backupDir, manifest, prefix, target) {
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
  for (const f of manifest.files.filter((x) => x.path.startsWith(`${prefix}/`))) {
    const rel = f.path.slice(prefix.length + 1).split('/');
    const dest = path.join(target, ...rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.promises.copyFile(path.join(backupDir, ...f.path.split('/')), dest, fs.constants.COPYFILE_EXCL);
  }
}

/** Comprueba que las migraciones de la copia son un prefijo de las del código. */
export function checkSchemaCompatible(backupMigrations, codeMigrations = loadMigrations()) {
  if (backupMigrations.length > codeMigrations.length) return 'schema_newer';
  for (const [i, m] of backupMigrations.entries()) {
    const c = codeMigrations[i];
    if (m.version !== c.version || m.checksum !== c.checksum) return 'schema_mismatch';
  }
  return null;
}

/**
 * @param {{ config: { databasePath: string, storageDir: string }, id: string, appVersion?: string,
 *           logger: { info: Function, warn: Function, error: Function }, clock?: () => number,
 *           migrations?: ReturnType<typeof loadMigrations> }} options
 * @returns {Promise<{ id: string, safetyBackupId: string|null, migrationsApplied: number, revokedCount: number }>}
 */
export async function restoreBackup({ config, id, appVersion, logger, clock = Date.now, migrations = loadMigrations() }) {
  const { databasePath, storageDir } = config;
  if (!BACKUP_ID.test(String(id))) throw new BackupError('backup_not_found');
  const backupDir = path.join(storageDir, 'backups', String(id));
  if (!(await exists(path.join(backupDir, 'manifest.json')))) throw new BackupError('backup_not_found');

  let release;
  try {
    release = acquireLock(serverLockFile(storageDir), 'restore');
  } catch (err) {
    if (err.code === 'lock_held') throw new BackupError('server_running', 'El servidor está en marcha (o hay otra restauración): deténgalo antes de restaurar.');
    throw err;
  }

  const media = path.join(storageDir, 'media');
  const priv = path.join(storageDir, 'private');
  const staged = { db: `${databasePath}.restore-tmp`, media: `${media}.restore-tmp`, private: `${priv}.restore-tmp` };
  const old = { db: `${databasePath}.before-restore`, media: `${media}.before-restore`, private: `${priv}.before-restore` };
  try {
    const check = await verifyBackupDir(backupDir, String(id));
    if (!check.ok) throw new BackupError('backup_invalid', 'La copia no supera la verificación', { issues: check.issues });
    const { manifest } = check;
    const incompatible = checkSchemaCompatible(manifest.schema.migrations, migrations);
    if (incompatible) throw new BackupError(incompatible, 'El esquema de la copia no es compatible con este código');

    // 3. Copia del estado actual.
    let safetyBackupId = null;
    if (await exists(databasePath)) {
      const current = openDatabase(databasePath, { create: false });
      try {
        const service = createBackupService({ db: current, storageDir, appVersion, logger, clock });
        safetyBackupId = (await service.create({ kind: 'pre_restore' })).id;
      } finally {
        closeDatabase(current);
      }
    }

    // 4. Preparación al lado de los originales (mismo disco: los renombrados son atómicos).
    for (const p of Object.values(staged)) await fs.promises.rm(p, { recursive: true, force: true });
    await fs.promises.copyFile(path.join(backupDir, 'database.sqlite'), staged.db);
    await stageFiles(backupDir, manifest, 'media', staged.media);
    await stageFiles(backupDir, manifest, 'private', staged.private);

    for (const p of Object.values(old)) await fs.promises.rm(p, { recursive: true, force: true });
    for (const suffix of ['-wal', '-shm']) await fs.promises.rm(`${databasePath}${suffix}`, { force: true });
    const done = [];
    try {
      for (const key of ['db', 'media', 'private']) {
        const live = key === 'db' ? databasePath : key === 'media' ? media : priv;
        if (await exists(live)) {
          await fs.promises.rename(live, old[key]);
          done.push(() => fs.promises.rename(old[key], live));
        }
        await fs.promises.rename(staged[key], live);
        done.push(() => fs.promises.rm(live, { recursive: true, force: true }));
      }
    } catch (err) {
      for (const undo of done.reverse()) await undo().catch(() => {});
      throw err;
    }

    // 5. Migraciones, sesiones y auditoría en la base restaurada.
    const db = openDatabase(databasePath, { create: false });
    let migrationsApplied;
    let revokedCount;
    try {
      ({ applied: { length: migrationsApplied } } = migrate(db, { migrations, logger }));
      revokedCount = Number(db.prepare(`UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revoked_reason = 'backup_restore' WHERE revoked_at IS NULL`).run().changes);
      createAuditLog(db).record({
        action: 'backup.restore', outcome: 'success', entityType: 'backup',
        details: { backupId: String(id), safetyBackupId, migrationsApplied, revokedCount, via: 'cli' },
      });
    } finally {
      closeDatabase(db);
    }
    for (const p of Object.values(old)) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    logger.info('Copia restaurada', { id: String(id), safetyBackupId, migrationsApplied, revokedCount });
    return { id: String(id), safetyBackupId, migrationsApplied, revokedCount };
  } catch (err) {
    for (const p of Object.values(staged)) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    // El fallo queda en la auditoría de la base que esté en su sitio (la original si no se llegó a cambiar).
    try {
      if (await exists(databasePath)) {
        const db = openDatabase(databasePath, { create: false });
        try {
          createAuditLog(db).record({
            action: 'backup.restore', outcome: 'failure', entityType: 'backup',
            details: { backupId: String(id), error: err instanceof BackupError ? err.code : 'internal_error', via: 'cli' },
          });
        } finally {
          closeDatabase(db);
        }
      }
    } catch {
      // Si la base no se puede abrir, el error original es el que importa.
    }
    throw err;
  } finally {
    release();
  }
}
