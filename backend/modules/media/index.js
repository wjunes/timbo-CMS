/**
 * Multimedia (Bloque 08): subida, biblioteca por sección y envío al panel.
 *
 * - Cada archivo pertenece a una sección. Verlo exige ver la sección (D-022);
 *   subirlo y editar su texto alternativo, `media.upload`; eliminarlo, `media.delete`.
 * - Subida en bruto (D-048): el cuerpo es el archivo, `Content-Type` su tipo y
 *   `X-File-Name` el nombre original codificado como URI. La extensión, el tipo
 *   declarado y el contenido real deben coincidir (inspect.js); se eliminan los
 *   metadatos (D-049). El nombre original es solo un dato: en disco el archivo
 *   tiene una clave aleatoria.
 * - Eliminar es lógico y no se permite mientras lo use una versión en borrador,
 *   en revisión, aprobada o publicada (D-047). El archivo físico se conserva.
 * - Envío al panel (con sesión): el MIME guardado, `nosniff`, CSP `sandbox` y
 *   descarga forzada para los documentos. El sitio público (Bloque 09) servirá
 *   solo los archivos de contenidos publicados.
 */
import { createHash } from 'node:crypto';
import { isTriggerAbort } from '../../database/errors.js';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody, readRawBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { createAuthorizer } from '../permissions/authorizer.js';
import { MEDIA_TYPES, MediaError, inspectFile } from './inspect.js';
import { BLOCKING_VERSION_STATUSES, createMediaRepository } from './repository.js';
import { createMediaStorage } from './storage.js';

export const FILE_NAME_MAX_LENGTH = 255;
export const ALT_TEXT_MAX_LENGTH = 500;
/** Subidas simultáneas: cada una se procesa en memoria (hasta MEDIA_MAX_BYTES). */
export const MAX_CONCURRENT_UPLOADS = 4;

const TRIGGER_CONFLICTS = Object.freeze(['section_archived', 'media_in_use', 'media_deleted', 'media_immutable']);

function inTransaction(db, fn) {
  try {
    return withTransaction(db, fn);
  } catch (err) {
    const code = TRIGGER_CONFLICTS.find((c) => isTriggerAbort(err, c));
    throw code ? new HttpError(409, code) : err;
  }
}

const fieldError = (field, code) => new HttpError(400, 'validation_failed', {}, { fields: { [field]: code } });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Nombre original desde `X-File-Name` (URI-encoded: las cabeceras HTTP son latin1).
 * No se corrige nada: un nombre con rutas o caracteres de control se rechaza.
 * @returns {{ name: string, extension: string }}
 */
export function parseFileName(header) {
  if (typeof header !== 'string' || header.length === 0) throw fieldError('fileName', 'required');
  if (header.length > 3 * 4 * FILE_NAME_MAX_LENGTH) throw fieldError('fileName', 'too_long');
  let name;
  try {
    name = decodeURIComponent(header).normalize('NFC').trim();
  } catch {
    throw fieldError('fileName', 'invalid_format');
  }
  if (!name.isWellFormed() || CONTROL.test(name) || /[\\/]/.test(name)) throw fieldError('fileName', 'invalid_characters');
  if ([...name].length > FILE_NAME_MAX_LENGTH) throw fieldError('fileName', 'too_long');
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,10}$/.test(extension)) throw fieldError('fileName', 'extension_required');
  return { name, extension };
}

/** Content-Disposition con el nombre original (RFC 6266/5987) y una alternativa ASCII. */
export function contentDisposition(type, name) {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toMedia(row) {
  return {
    id: row.id,
    sectionId: row.section_id,
    kind: MEDIA_TYPES[row.mime_type]?.kind ?? 'document',
    originalName: row.original_name,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    altText: row.alt_text,
    status: row.status,
    uploadedBy: { id: row.uploaded_by, displayName: row.uploaded_by_name },
    createdAt: row.created_at,
    fileUrl: `/api/media/${row.id}/file`,
  };
}

function toUsage(row) {
  return {
    content: { id: row.content_id, slug: row.slug, status: row.content_status },
    version: { id: row.version_id, versionNumber: row.version_number, status: row.version_status, title: row.title },
  };
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: { storageDir: string, media: { maxBytes: number } },
 *           logger: { error: Function, warn: Function } }} deps
 */
export function createMediaModule({ db, config, logger }) {
  const media = createMediaRepository(db);
  const storage = createMediaStorage(config.storageDir);
  const authorizer = createAuthorizer(db);
  const audit = createAuditLog(db);
  const sectionById = db.prepare('SELECT id, status FROM sections WHERE id = ?');
  let uploadsInProgress = 0;

  const user = (ctx) => ctx.auth.session.user;
  const actor = (ctx) => user(ctx).id;
  const pathOf = (ctx) => new URL(ctx.req.url, 'http://localhost').pathname;

  function requirePermission(ctx, code, sectionId) {
    if (authorizer.can(user(ctx), code, sectionId)) return;
    audit.record({
      action: 'access.denied', outcome: 'denied', actorUserId: actor(ctx), sectionId, ip: ctx.ip,
      details: { method: ctx.req.method, path: pathOf(ctx), permission: code },
    });
    throw new HttpError(403, 'forbidden');
  }

  function loadSection(ctx, id) {
    const section = sectionById.get(id);
    if (!section || !authorizer.canView(user(ctx), section.id)) throw new HttpError(404, 'not_found');
    return section;
  }

  /** Archivo activo de una sección visible; si no, 404. */
  function loadMedia(ctx) {
    const row = media.findById(ctx.params.id);
    if (!row || row.status !== 'active' || row.section_id === null || !authorizer.canView(user(ctx), row.section_id)) {
      throw new HttpError(404, 'not_found');
    }
    return { row, section: sectionById.get(row.section_id) };
  }

  function assertWritable(section) {
    if (section.status === 'archived') throw new HttpError(409, 'section_archived');
  }

  function record(ctx, action, row, details) {
    audit.record({
      action, outcome: 'success', actorUserId: actor(ctx), entityType: 'media', entityId: row.id,
      sectionId: row.section_id, ip: ctx.ip, details,
    });
  }

  // ---------------------------------------------------------------------------

  function list(ctx) {
    const section = loadSection(ctx, ctx.params.id);
    return { status: 200, body: { media: media.listBySection(section.id).map(toMedia) } };
  }

  async function upload(ctx) {
    const section = loadSection(ctx, ctx.params.id);
    requirePermission(ctx, 'media.upload', section.id);
    assertWritable(section);

    const mimeType = (ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const type = Object.hasOwn(MEDIA_TYPES, mimeType) ? MEDIA_TYPES[mimeType] : null;
    if (!type) throw new HttpError(415, 'unsupported_media_type', {}, { allowed: Object.keys(MEDIA_TYPES) });
    const { name, extension } = parseFileName(ctx.req.headers['x-file-name']);
    if (!type.extensions.includes(extension)) throw fieldError('fileName', 'extension_mismatch');

    if (uploadsInProgress >= MAX_CONCURRENT_UPLOADS) throw new HttpError(503, 'uploads_busy', { 'Retry-After': '5' });
    uploadsInProgress++;
    try {
      const raw = await readRawBody(ctx.req, { limit: config.media.maxBytes });
      if (raw.length === 0) throw fieldError('file', 'empty');
      let file;
      try {
        file = inspectFile(raw, mimeType);
      } catch (err) {
        if (!(err instanceof MediaError)) throw err;
        audit.record({
          action: 'media.upload', outcome: 'failure', actorUserId: actor(ctx), sectionId: section.id, ip: ctx.ip,
          details: { reason: err.code, mimeType, sizeBytes: raw.length },
        });
        throw new HttpError(422, 'file_rejected', {}, { reason: err.code });
      }

      const sha256 = createHash('sha256').update(file.buffer).digest('hex');
      const storageKey = await storage.save(file.buffer);
      let id;
      try {
        id = inTransaction(db, () => {
          const newId = media.insert({
            storageKey, originalName: name, mimeType, extension, sizeBytes: file.buffer.length, sha256,
            width: file.width, height: file.height, altText: '', sectionId: section.id, uploadedBy: actor(ctx),
          });
          audit.record({
            action: 'media.upload', outcome: 'success', actorUserId: actor(ctx), entityType: 'media', entityId: newId,
            sectionId: section.id, ip: ctx.ip,
            details: { mimeType, sizeBytes: file.buffer.length, metadataRemoved: file.metadataRemoved },
          });
          return newId;
        });
      } catch (err) {
        await storage.discard(storageKey).catch((e) => logger.error('No se pudo borrar un archivo sin registro', { err: e }));
        throw err;
      }
      return { status: 201, body: { media: toMedia(media.findById(id)) } };
    } finally {
      uploadsInProgress--;
    }
  }

  function get(ctx) {
    const { row } = loadMedia(ctx);
    return { status: 200, body: { media: toMedia(row), usage: media.usage(row.id).map(toUsage) } };
  }

  async function update(ctx) {
    const { row, section } = loadMedia(ctx);
    requirePermission(ctx, 'media.upload', section.id);
    assertWritable(section);
    const input = validate(await readJsonBody(ctx.req, { limit: 8192 }), {
      altText: rules.string({ max: ALT_TEXT_MAX_LENGTH }),
    });
    if (input.altText !== row.alt_text) {
      inTransaction(db, () => {
        if (!media.updateAlt(row.id, input.altText)) throw new HttpError(409, 'media_deleted');
        record(ctx, 'media.update', row, { fields: ['altText'] });
      });
    }
    return { status: 200, body: { media: toMedia(media.findById(row.id)) } };
  }

  function remove(ctx) {
    const { row, section } = loadMedia(ctx);
    requirePermission(ctx, 'media.delete', section.id);
    assertWritable(section);
    inTransaction(db, () => {
      const blocking = media.usage(row.id).filter((u) => BLOCKING_VERSION_STATUSES.includes(u.version_status));
      if (blocking.length) throw new HttpError(409, 'media_in_use', {}, { usage: blocking.map(toUsage) });
      if (!media.softDelete(row.id, actor(ctx))) throw new HttpError(409, 'media_deleted');
      record(ctx, 'media.delete', row, { originalName: row.original_name, sha256: row.sha256 });
    });
    return { status: 204 };
  }

  async function file(ctx) {
    const { row } = loadMedia(ctx);
    const opened = await storage.open(row.storage_key);
    if (!opened) {
      // El registro existe y el archivo no: es un problema de integridad, no del cliente.
      logger.error('Falta el archivo de un registro multimedia', { mediaId: row.id });
      throw new HttpError(404, 'not_found');
    }
    const isImage = MEDIA_TYPES[row.mime_type]?.kind === 'image';
    return {
      status: 200,
      stream: opened.stream,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Length': String(opened.size),
        'Content-Disposition': contentDisposition(isImage ? 'inline' : 'attachment', row.original_name),
        // Aunque un navegador lo abriera como documento, no ejecuta nada ni accede al origen.
        'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
        'Cache-Control': 'private, no-store',
      },
    };
  }

  const session = { auth: true };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/sections/:id/media', handler: list, ...session },
      { method: 'POST', path: '/api/sections/:id/media', handler: upload, ...session },
      { method: 'GET', path: '/api/media/:id', handler: get, ...session },
      { method: 'PATCH', path: '/api/media/:id', handler: update, ...session },
      { method: 'DELETE', path: '/api/media/:id', handler: remove, ...session },
      { method: 'GET', path: '/api/media/:id/file', handler: file, ...session },
    ],
  });
}
