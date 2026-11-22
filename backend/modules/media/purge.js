/**
 * Purga física controlada de archivos (Bloque 10, D-061; solo general_admin).
 *
 * En dos pasos: `GET /api/media/purge` lista los candidatos y
 * `POST /api/media/purge` purga los que se confirmen, que deben seguir siendo
 * candidatos en ese momento. Candidatos:
 *
 * - archivos eliminados (lógicamente) que no usa ninguna versión de ningún
 *   contenido: se registra la purga (`media_purges`, también comprobado por
 *   trigger) y se borra el archivo; la fila de `media` se conserva;
 * - archivos sin registro en la base (o de registros ya purgados), con más de
 *   una hora: restos de una subida interrumpida;
 * - temporales `.tmp-*` con más de una hora.
 *
 * Nunca se purga un archivo en uso, tampoco por versiones antiguas: el historial
 * sigue mostrándolo. No se purga mientras se hace una copia de seguridad (mismo
 * bloqueo), y las copias anteriores conservan los archivos purgados.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { acquireLock } from '../backups/lock.js';

const KEY = /^[0-9a-f]{32}$/;
const TEMP = /^\.tmp-[0-9a-f]{16}$/;
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;
const MAX_ITEMS = 1000;

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: { storageDir: string },
 *           logger: { warn: Function, info: Function }, clock?: () => number }} deps
 */
export function createMediaPurge({ db, config, logger, clock = Date.now }) {
  const dir = path.join(config.storageDir, 'media');
  const lockFile = path.join(config.storageDir, 'backups', '.lock');
  const audit = createAuditLog(db);

  const deletedCandidates = db.prepare(`
    SELECT m.id, m.original_name, m.size_bytes, m.deleted_at, m.section_id, m.storage_key FROM media AS m
    WHERE m.status = 'deleted'
      AND NOT EXISTS (SELECT 1 FROM content_media AS cm WHERE cm.media_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM media_purges AS p WHERE p.media_id = m.id)
    ORDER BY m.id`);
  const liveKey = db.prepare(`SELECT 1 AS ok FROM media AS m WHERE m.storage_key = ?
    AND NOT EXISTS (SELECT 1 FROM media_purges AS p WHERE p.media_id = m.id)`);
  const insertPurge = db.prepare('INSERT INTO media_purges (media_id, purged_by) VALUES (?, ?)');

  async function scanFiles() {
    const orphans = [];
    const temporary = [];
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return { orphans, temporary };
      throw err;
    }
    const now = clock();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const isKey = KEY.test(e.name);
      if (!isKey && !TEMP.test(e.name)) continue; // nada más se toca
      const { size, mtimeMs } = await fs.promises.stat(path.join(dir, e.name));
      if (now - mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      const item = { name: e.name, sizeBytes: size, modifiedAt: new Date(mtimeMs).toISOString() };
      if (!isKey) temporary.push(item);
      else if (!liveKey.get(e.name)) orphans.push(item);
    }
    return { orphans, temporary };
  }

  /** Candidatos actuales; `keys` (clave en disco de cada eliminado) no sale de este módulo. */
  async function candidates() {
    const keys = new Map();
    const deleted = deletedCandidates.all().map((m) => {
      keys.set(m.id, m.storage_key);
      return { id: m.id, originalName: m.original_name, sizeBytes: m.size_bytes, deletedAt: m.deleted_at, sectionId: m.section_id };
    });
    return { deleted, ...(await scanFiles()), keys };
  }

  async function preview() {
    const { keys: _keys, ...body } = await candidates();
    return { status: 200, body };
  }

  async function run(ctx) {
    const body = await readJsonBody(ctx.req);
    const names = (key, re) => {
      const v = body[key];
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > MAX_ITEMS || v.some((x) => typeof x !== 'string' || !re.test(x)) || new Set(v).size !== v.length) {
        throw new HttpError(400, 'validation_failed', {}, { fields: { [key]: 'invalid_value' } });
      }
      return v;
    };
    const { orphans: _o, temporary: _t, ...rest } = body;
    const { mediaIds = [] } = validate(rest, { mediaIds: rules.idList({ max: MAX_ITEMS, optional: true }) });
    const orphans = names('orphans', KEY);
    const temporary = names('temporary', TEMP);
    if (!mediaIds.length && !orphans.length && !temporary.length) {
      throw new HttpError(400, 'validation_failed', {}, { fields: { _: 'empty_update' } });
    }

    let release;
    try {
      release = acquireLock(lockFile, 'media_purge');
    } catch (err) {
      if (err.code === 'lock_held') throw new HttpError(409, 'backup_in_progress');
      throw err;
    }
    try {
      const current = await candidates();
      const byId = current.keys;
      const orphanSet = new Set(current.orphans.map((o) => o.name));
      const tempSet = new Set(current.temporary.map((t) => t.name));
      const stale = [
        ...mediaIds.filter((i) => !byId.has(i)).map((i) => ({ mediaId: i })),
        ...orphans.filter((n) => !orphanSet.has(n)).map((n) => ({ name: n })),
        ...temporary.filter((n) => !tempSet.has(n)).map((n) => ({ name: n })),
      ];
      if (stale.length) throw new HttpError(409, 'purge_candidates_changed', {}, { stale });

      const actor = ctx.auth.session.user.id;
      withTransaction(db, () => {
        for (const mediaId of mediaIds) insertPurge.run(mediaId, actor);
        audit.record({
          action: 'media.purge', outcome: 'success', actorUserId: actor, entityType: 'media', ip: ctx.ip,
          details: { mediaIds, orphans, temporary },
        });
      });
      const keys = mediaIds.map((i) => byId.get(i));

      // Los archivos se borran después de confirmar el registro: si un borrado
      // falla, el archivo queda como huérfano y aparece en la siguiente purga.
      const failed = [];
      for (const name of [...keys, ...orphans, ...temporary]) {
        try {
          await fs.promises.rm(path.join(dir, name), { force: true });
        } catch (err) {
          failed.push(name);
          logger.warn('No se pudo borrar un archivo purgado', { err, name });
        }
      }
      return { status: 200, body: { purged: { media: mediaIds.length, orphans: orphans.length, temporary: temporary.length }, failed } };
    } finally {
      release();
    }
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    candidates,
    routes: [
      { method: 'GET', path: '/api/media/purge', handler: preview, ...ga },
      { method: 'POST', path: '/api/media/purge', handler: run, ...ga },
    ],
  });
}
