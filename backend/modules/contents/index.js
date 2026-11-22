/**
 * Motor de contenidos y versionado (Bloque 06).
 *
 * - El estado del contenido (draft/published/archived/deleted) y el de sus
 *   versiones son independientes. Cada contenido tiene como máximo una versión
 *   publicada y una "en curso" (draft/pending_review/approved).
 * - Editar nunca sobrescribe la versión publicada: se trabaja sobre un borrador
 *   (nueva versión basada en otra), con control de concurrencia optimista (`revision`).
 * - Las transiciones editoriales (enviar, aprobar, publicar…) están en
 *   `modules/editorial` (Bloque 07); aquí se crean y editan borradores.
 * - Autorización en el backend con el autorizador único (D-022). Quien no puede
 *   ver la sección recibe 404; quien la ve pero no tiene el permiso, 403 (auditado).
 * - Cada escritura y su auditoría se confirman en la misma transacción.
 */
import { isTriggerAbort, isUniqueViolation } from '../../database/errors.js';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { createAuthorizer } from '../permissions/authorizer.js';
import { SLUG_PATTERN, slugify } from '../sections/slug.js';
import { BODY_LIMITS, EMPTY_BODY, validateBody } from './body.js';
import { createContentRepository } from './repository.js';

export const CONTENT_SLUG_MAX_LENGTH = 150;
/** Tamaño máximo de la petición: el documento más el resto de campos y el escapado JSON. */
const BODY_REQUEST_LIMIT = BODY_LIMITS.maxBytes + 256 * 1024;
const EMPTY_BODY_JSON = JSON.stringify(EMPTY_BODY);
const MAX_SLUG_SUFFIX = 50;

/** Códigos de trigger (migraciones 001/004) que se devuelven tal cual como 409. */
const TRIGGER_CONFLICTS = Object.freeze([
  'section_archived', 'content_not_editable', 'content_section_immutable', 'content_version_immutable',
  'version_must_start_as_draft',
]);

function translateDbError(err, uniqueCode) {
  if (isUniqueViolation(err)) return new HttpError(409, uniqueCode);
  const code = TRIGGER_CONFLICTS.find((c) => isTriggerAbort(err, c));
  return code ? new HttpError(409, code) : err;
}

function inTransaction(db, uniqueCode, fn) {
  try {
    return withTransaction(db, fn);
  } catch (err) {
    throw translateDbError(err, uniqueCode);
  }
}

const fieldError = (field, code) => new HttpError(400, 'validation_failed', {}, { fields: { [field]: code } });

/** Separa `body` (documento Tiptap, se valida aparte) del resto de campos. */
function splitBody(raw) {
  const rest = { ...raw }; // copia de propiedades propias (incluida una clave "__proto__")
  const hasBody = Object.hasOwn(rest, 'body');
  const body = rest.body;
  delete rest.body;
  return { hasBody, body, rest };
}

function bodyJson(value) {
  const result = validateBody(value);
  if (!result.ok) {
    throw new HttpError(400, 'validation_failed', {}, { fields: { body: result.code }, bodyPath: result.path });
  }
  return result.json;
}

const titleRule = (o = {}) => rules.string({ min: 1, max: 300, ...o });
const summaryRule = () => rules.string({ max: 2000, optional: true });
const slugRule = () => rules.string({ min: 1, max: CONTENT_SLUG_MAX_LENGTH, pattern: SLUG_PATTERN, optional: true });

const person = (id, displayName) => (id === null ? null : { id, displayName });

export function toVersion(row, { withBody = false } = {}) {
  const version = {
    id: row.id,
    contentId: row.content_id,
    versionNumber: row.version_number,
    basedOnVersionId: row.based_on_version_id,
    status: row.status,
    title: row.title,
    summary: row.summary,
    bodyFormat: row.body_format,
    revision: row.revision,
    createdBy: person(row.created_by, row.created_by_name),
    createdAt: row.created_at,
    updatedBy: person(row.updated_by, row.updated_by_name),
    updatedAt: row.updated_at,
    submittedBy: person(row.submitted_by, row.submitted_by_name),
    submittedAt: row.submitted_at,
    approvedBy: person(row.approved_by, row.approved_by_name),
    approvedAt: row.approved_at,
    publishedBy: person(row.published_by, row.published_by_name),
    publishedAt: row.published_at,
  };
  if (withBody) version.body = JSON.parse(row.body);
  return version;
}

export function toContent(row) {
  return {
    id: row.id,
    sectionId: row.section_id,
    slug: row.slug,
    status: row.status,
    sortOrder: row.sort_order,
    title: row.latest_title,
    versionCount: row.version_count,
    latestVersionNumber: row.latest_number,
    openVersion: row.open_id === null
      ? null
      : { id: row.open_id, versionNumber: row.open_number, status: row.open_status, revision: row.open_revision },
    publishedVersion: row.published_version_id === null
      ? null
      : { id: row.published_version_id, versionNumber: row.published_number },
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** @param {{ db: import('node:sqlite').DatabaseSync }} deps */
export function createContentsModule({ db }) {
  const contents = createContentRepository(db);
  const authorizer = createAuthorizer(db);
  const audit = createAuditLog(db);
  const sectionById = db.prepare('SELECT id, status FROM sections WHERE id = ?');

  const user = (ctx) => ctx.auth.session.user;
  const actor = (ctx) => user(ctx).id;
  const pathOf = (ctx) => new URL(ctx.req.url, 'http://localhost').pathname;

  function deny(ctx, permission, sectionId) {
    audit.record({
      action: 'access.denied', outcome: 'denied', actorUserId: actor(ctx), sectionId, ip: ctx.ip,
      details: { method: ctx.req.method, path: pathOf(ctx), permission },
    });
    throw new HttpError(403, 'forbidden');
  }

  function requirePermission(ctx, code, sectionId) {
    if (!authorizer.can(user(ctx), code, sectionId)) deny(ctx, code, sectionId);
  }

  /**
   * Editar o descartar un borrador: `content.edit`, o `content.create` si el
   * borrador lo creó el propio usuario (D-036).
   */
  function requireDraftAccess(ctx, sectionId, version) {
    if (authorizer.can(user(ctx), 'content.edit', sectionId)) return;
    if (version.created_by === actor(ctx) && authorizer.can(user(ctx), 'content.create', sectionId)) return;
    deny(ctx, 'content.edit', sectionId);
  }

  /** Sección visible para el usuario; si no existe o no puede verla, 404. */
  function loadSection(ctx, id) {
    const section = sectionById.get(id);
    if (!section || !authorizer.canView(user(ctx), section.id)) throw new HttpError(404, 'not_found');
    return section;
  }

  /** Contenido visible (no eliminado) y su sección; si no, 404. */
  function loadContent(ctx) {
    const row = contents.findById(ctx.params.id);
    if (!row || row.status === 'deleted' || !authorizer.canView(user(ctx), row.section_id)) {
      throw new HttpError(404, 'not_found');
    }
    return { row, section: sectionById.get(row.section_id) };
  }

  function loadVersion(ctx, contentRow) {
    const version = contents.version(contentRow.id, ctx.params.versionId);
    if (!version) throw new HttpError(404, 'not_found');
    return version;
  }

  /** Sección archivada: solo lectura. Contenido archivado: sin edición hasta restaurarlo (Bloque 07). */
  function assertWritable(section, contentRow = null) {
    if (section.status === 'archived') throw new HttpError(409, 'section_archived');
    if (contentRow?.status === 'archived') throw new HttpError(409, 'content_not_editable');
  }

  /** Slug a partir del título, con sufijo numérico si ya está en uso. */
  function generateSlug(sectionId, title) {
    const base = slugify(title);
    if (!base) throw fieldError('slug', 'required');
    for (let i = 1; i <= MAX_SLUG_SUFFIX; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (!contents.isSlugTaken(sectionId, candidate)) return candidate;
    }
    throw new HttpError(409, 'slug_taken');
  }

  const contentResponse = (id) => toContent(contents.findById(id));

  // --- Contenidos -------------------------------------------------------------

  function list(ctx) {
    const section = loadSection(ctx, ctx.params.id);
    return { status: 200, body: { contents: contents.listBySection(section.id).map(toContent) } };
  }

  async function create(ctx) {
    const section = loadSection(ctx, ctx.params.id);
    requirePermission(ctx, 'content.create', section.id);
    assertWritable(section);
    const { hasBody, body, rest } = splitBody(await readJsonBody(ctx.req, { limit: BODY_REQUEST_LIMIT }));
    const input = validate(rest, { title: titleRule(), summary: summaryRule(), slug: slugRule() });
    const json = hasBody ? bodyJson(body) : EMPTY_BODY_JSON;

    const { contentId, versionId } = inTransaction(db, 'slug_taken', () => {
      let slug = input.slug;
      if (slug === undefined) slug = generateSlug(section.id, input.title);
      else if (contents.isSlugTaken(section.id, slug)) throw new HttpError(409, 'slug_taken');
      const ids = contents.create({
        sectionId: section.id, slug, title: input.title, summary: input.summary ?? '', body: json, userId: actor(ctx),
      });
      audit.record({
        action: 'content.create', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: ids.contentId,
        sectionId: section.id, ip: ctx.ip, details: { slug, versionId: ids.versionId, versionNumber: 1 },
      });
      return ids;
    });
    return {
      status: 201,
      body: { content: contentResponse(contentId), version: toVersion(contents.version(contentId, versionId), { withBody: true }) },
    };
  }

  function get(ctx) {
    const { row } = loadContent(ctx);
    return { status: 200, body: { content: toContent(row) } };
  }

  async function update(ctx) {
    const { row, section } = loadContent(ctx);
    requirePermission(ctx, 'content.edit', section.id);
    assertWritable(section, row);
    const input = validate(
      await readJsonBody(ctx.req),
      { slug: slugRule(), sortOrder: rules.integer({ min: 0, max: 1_000_000_000, optional: true }) },
      { requireAny: true },
    );
    const current = { slug: row.slug, sortOrder: row.sort_order };
    const changes = {};
    for (const [key, value] of Object.entries(input)) if (value !== current[key]) changes[key] = value;

    if (Object.keys(changes).length) {
      inTransaction(db, 'slug_taken', () => {
        if ('slug' in changes && contents.isSlugTaken(section.id, changes.slug, row.id)) throw new HttpError(409, 'slug_taken');
        contents.update(row.id, changes);
        const diff = Object.fromEntries(Object.keys(changes).map((k) => [k, { from: current[k], to: changes[k] }]));
        audit.record({
          action: 'content.update', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
          sectionId: section.id, ip: ctx.ip, details: { changes: diff },
        });
      });
    }
    return { status: 200, body: { content: contentResponse(row.id) } };
  }

  function remove(ctx) {
    const { row, section } = loadContent(ctx);
    requirePermission(ctx, 'content.delete', section.id);
    assertWritable(section);
    // Un contenido publicado se despublica antes (Bloque 07); uno en revisión no se elimina (D-037).
    if (row.status === 'published') throw new HttpError(409, 'content_published');
    if (contents.blockingVersionCount(row.id) > 0) throw new HttpError(409, 'content_in_review');
    inTransaction(db, 'slug_taken', () => {
      contents.softDelete(row.id, actor(ctx));
      audit.record({
        action: 'content.delete', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
        sectionId: section.id, ip: ctx.ip, details: { slug: row.slug, from: row.status, versionCount: row.version_count },
      });
    });
    return { status: 204 };
  }

  // --- Versiones --------------------------------------------------------------

  function listVersions(ctx) {
    const { row } = loadContent(ctx);
    return { status: 200, body: { content: toContent(row), versions: contents.versions(row.id).map((v) => toVersion(v)) } };
  }

  function getVersion(ctx) {
    const { row } = loadContent(ctx);
    return { status: 200, body: { version: toVersion(loadVersion(ctx, row), { withBody: true }) } };
  }

  async function createVersion(ctx) {
    const { row, section } = loadContent(ctx);
    requirePermission(ctx, 'content.edit', section.id);
    assertWritable(section, row);
    const input = validate(await readJsonBody(ctx.req), { basedOnVersionId: rules.integer({ min: 1, optional: true }) });
    if (row.open_id !== null) throw new HttpError(409, 'open_version_exists', {}, { openVersionId: row.open_id });

    // Por defecto se parte de la versión publicada o, si no la hay, de la última.
    let sourceId = input.basedOnVersionId;
    if (sourceId === undefined) sourceId = row.published_version_id ?? contents.versions(row.id)[0].id;
    else if (!contents.version(row.id, sourceId)) throw fieldError('basedOnVersionId', 'not_found');

    const created = inTransaction(db, 'open_version_exists', () => {
      const v = contents.createVersionFrom({ contentId: row.id, sourceId, userId: actor(ctx) });
      contents.touch(row.id);
      audit.record({
        action: 'version.create', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
        sectionId: section.id, ip: ctx.ip, details: { versionId: v.id, versionNumber: v.number, basedOnVersionId: sourceId },
      });
      return v;
    });
    return {
      status: 201,
      body: { content: contentResponse(row.id), version: toVersion(contents.version(row.id, created.id), { withBody: true }) },
    };
  }

  async function saveVersion(ctx) {
    const { row, section } = loadContent(ctx);
    const version = loadVersion(ctx, row);
    requireDraftAccess(ctx, section.id, version);
    assertWritable(section, row);
    if (version.status !== 'draft') throw new HttpError(409, 'version_not_editable');

    const { hasBody, body, rest } = splitBody(await readJsonBody(ctx.req, { limit: BODY_REQUEST_LIMIT }));
    const input = validate(rest, { revision: rules.integer({ min: 1 }), title: titleRule({ optional: true }), summary: summaryRule() });
    if (!hasBody && input.title === undefined && input.summary === undefined) throw fieldError('_', 'empty_update');

    const proposed = { title: input.title, summary: input.summary, body: hasBody ? bodyJson(body) : undefined };
    const changes = {};
    for (const [key, value] of Object.entries(proposed)) if (value !== undefined && value !== version[key]) changes[key] = value;

    const conflict = () => {
      const latest = contents.version(row.id, version.id);
      if (!latest || latest.status !== 'draft') return new HttpError(409, 'version_not_editable');
      return new HttpError(409, 'revision_conflict', {}, { currentRevision: latest.revision });
    };

    if (!Object.keys(changes).length) {
      // Nada que guardar, pero la revisión del cliente debe estar al día.
      if (input.revision !== version.revision) throw conflict();
    } else {
      inTransaction(db, 'revision_conflict', () => {
        if (!contents.saveDraft(version.id, input.revision, changes, actor(ctx))) throw conflict();
        contents.touch(row.id);
        audit.record({
          action: 'version.update', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
          sectionId: section.id, ip: ctx.ip,
          details: { versionId: version.id, versionNumber: version.version_number, revision: input.revision + 1, fields: Object.keys(changes) },
        });
      });
    }
    return { status: 200, body: { version: toVersion(contents.version(row.id, version.id), { withBody: true }) } };
  }

  function discardVersion(ctx) {
    const { row, section } = loadContent(ctx);
    const version = loadVersion(ctx, row);
    requireDraftAccess(ctx, section.id, version);
    assertWritable(section, row);
    if (version.status !== 'draft') throw new HttpError(409, 'version_not_editable');
    // La única versión no se descarta: se elimina el contenido (D-038).
    if (row.version_count === 1) throw new HttpError(409, 'only_version');
    inTransaction(db, 'version_not_editable', () => {
      if (!contents.discardDraft(version.id)) throw new HttpError(409, 'version_not_editable');
      contents.touch(row.id);
      audit.record({
        action: 'version.discard', outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
        sectionId: section.id, ip: ctx.ip, details: { versionId: version.id, versionNumber: version.version_number },
      });
    });
    return { status: 204 };
  }

  const session = { auth: true };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/sections/:id/contents', handler: list, ...session },
      { method: 'POST', path: '/api/sections/:id/contents', handler: create, ...session },
      { method: 'GET', path: '/api/contents/:id', handler: get, ...session },
      { method: 'PATCH', path: '/api/contents/:id', handler: update, ...session },
      { method: 'DELETE', path: '/api/contents/:id', handler: remove, ...session },
      { method: 'GET', path: '/api/contents/:id/versions', handler: listVersions, ...session },
      { method: 'POST', path: '/api/contents/:id/versions', handler: createVersion, ...session },
      { method: 'GET', path: '/api/contents/:id/versions/:versionId', handler: getVersion, ...session },
      { method: 'PATCH', path: '/api/contents/:id/versions/:versionId', handler: saveVersion, ...session },
      { method: 'DELETE', path: '/api/contents/:id/versions/:versionId', handler: discardVersion, ...session },
    ],
  });
}
