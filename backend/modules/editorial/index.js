/**
 * Flujos editoriales y aprobaciones (Bloque 07).
 *
 * Transiciones de una versión (la base las garantiza también, migración 005):
 *
 *   draft ──submit──> pending_review ──approve──────────> approved ──publish──> published ──> archived
 *     │                     └──request-changes──> changes_requested            (al reemplazarla o despublicar)
 *     └──publish (solo secciones 'direct')──────────────────────────────────────┘
 *
 * - Flujo de la sección: 'direct' publica borradores con `content.publish`;
 *   'approval' exige enviar (`content.submit`), la revisión del general_admin y
 *   publicar la versión aprobada exacta (`content.publish`, D-040). El
 *   general_admin sigue el mismo camino, sin atajos (D-041).
 * - Despublicar y archivar retiran contenido y no requieren aprobación (D-042).
 * - Publicar nunca sobrescribe: la versión publicada anterior pasa a 'archived'
 *   en la misma transacción. El cuerpo se vuelve a validar antes de enviar y
 *   de publicar.
 * - Autorización y visibilidad como en contenidos: 404 si no se ve la sección,
 *   403 auditado si falta el permiso. Cada transición se audita en su transacción.
 */
import { isTriggerAbort, isUniqueViolation } from '../../database/errors.js';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { validateBody } from '../contents/body.js';
import { toContent, toVersion } from '../contents/index.js';
import { createContentRepository } from '../contents/repository.js';
import { createAuthorizer } from '../permissions/authorizer.js';
import { createEditorialRepository } from './repository.js';

export const REVIEW_COMMENT_MAX_LENGTH = 5000;

/** Códigos de trigger (migraciones 001/004/005) que se devuelven tal cual como 409. */
const TRIGGER_CONFLICTS = Object.freeze([
  'version_invalid_transition', 'review_required', 'approval_required', 'reviewer_must_be_general_admin',
  'version_not_pending_review', 'version_is_published', 'published_version_not_published', 'content_version_immutable',
  'section_archived', 'content_not_editable',
]);

/** Estado cambiado entre la comprobación y la escritura (o restricción única violada). */
const stateChanged = () => new HttpError(409, 'state_changed');

function inTransaction(db, fn) {
  try {
    return withTransaction(db, fn);
  } catch (err) {
    if (isUniqueViolation(err)) throw stateChanged();
    const code = TRIGGER_CONFLICTS.find((c) => isTriggerAbort(err, c));
    throw code ? new HttpError(409, code) : err;
  }
}

const invalidTransition = (status) => new HttpError(409, 'invalid_transition', {}, { status });

function toReview(row) {
  return {
    id: row.id,
    versionId: row.content_version_id,
    decision: row.decision,
    comment: row.comment,
    reviewer: { id: row.reviewer_id, displayName: row.reviewer_name },
    createdAt: row.created_at,
  };
}

function toPending(row) {
  return {
    section: { id: row.section_id, name: row.section_name },
    content: { id: row.content_id, slug: row.slug, status: row.content_status },
    version: {
      id: row.version_id,
      versionNumber: row.version_number,
      title: row.title,
      submittedBy: { id: row.submitted_by, displayName: row.submitted_by_name },
      submittedAt: row.submitted_at,
    },
  };
}

/** @param {{ db: import('node:sqlite').DatabaseSync }} deps */
export function createEditorialModule({ db }) {
  const contents = createContentRepository(db);
  const editorial = createEditorialRepository(db);
  const authorizer = createAuthorizer(db);
  const audit = createAuditLog(db);
  const sectionById = db.prepare('SELECT id, status, workflow FROM sections WHERE id = ?');

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

  /** Contenido visible (no eliminado), su sección y, si la ruta la nombra, la versión; si no, 404. */
  function load(ctx) {
    const row = contents.findById(ctx.params.id);
    if (!row || row.status === 'deleted' || !authorizer.canView(user(ctx), row.section_id)) {
      throw new HttpError(404, 'not_found');
    }
    const section = sectionById.get(row.section_id);
    let version = null;
    if (ctx.params.versionId !== undefined) {
      version = contents.version(row.id, ctx.params.versionId);
      if (!version) throw new HttpError(404, 'not_found');
    }
    return { row, section, version };
  }

  /**
   * Vuelve a leer el estado dentro de la transacción y repite las comprobaciones:
   * entre la lectura inicial y la escritura pudo cambiar (la petición espera el cuerpo).
   */
  function reload(ctx, check) {
    const state = load(ctx);
    check(state);
    return state;
  }

  /** Sección archivada: sin transiciones. Contenido archivado: sin transiciones de versión. */
  function assertActive({ section, row }, { allowArchivedContent = false } = {}) {
    if (section.status === 'archived') throw new HttpError(409, 'section_archived');
    if (!allowArchivedContent && row.status === 'archived') throw new HttpError(409, 'content_not_editable');
  }

  /** El cuerpo guardado debe seguir cumpliendo la lista blanca (D-033) antes de enviarlo o publicarlo. */
  function assertPublishableBody(version) {
    const result = validateBody(JSON.parse(version.body));
    if (!result.ok) throw new HttpError(409, 'body_invalid', {}, { fields: { body: result.code }, bodyPath: result.path });
  }

  function assertRevision(version, revision) {
    if (revision === undefined) {
      throw new HttpError(400, 'validation_failed', {}, { fields: { revision: 'required' } });
    }
    if (version.revision !== revision) throw new HttpError(409, 'revision_conflict', {}, { currentRevision: version.revision });
  }

  function record(ctx, action, { row, section }, details) {
    audit.record({
      action, outcome: 'success', actorUserId: actor(ctx), entityType: 'content', entityId: row.id,
      sectionId: section.id, ip: ctx.ip, details,
    });
  }

  const response = (contentId, versionId) => {
    const body = { content: toContent(contents.findById(contentId)) };
    if (versionId !== undefined) body.version = toVersion(contents.version(contentId, versionId));
    return { status: 200, body };
  };

  // --- Versiones --------------------------------------------------------------

  async function submit(ctx) {
    const initial = load(ctx);
    requirePermission(ctx, 'content.submit', initial.section.id);
    const input = validate(await readJsonBody(ctx.req), { revision: rules.integer({ min: 1 }) });

    const check = (s) => {
      assertActive(s);
      if (s.section.workflow !== 'approval') throw new HttpError(409, 'review_not_required');
      if (s.version.status !== 'draft') throw invalidTransition(s.version.status);
      assertRevision(s.version, input.revision);
      assertPublishableBody(s.version);
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      if (!editorial.submit(state.version.id, input.revision, actor(ctx))) throw stateChanged();
      contents.touch(state.row.id);
      record(ctx, 'version.submit', state, { versionId: state.version.id, versionNumber: state.version.version_number });
      return state;
    });
    return response(s.row.id, s.version.id);
  }

  /** Aprobar o solicitar cambios: solo general_admin (la ruta lo exige; la base, también). */
  async function review(ctx, decision) {
    const initial = load(ctx);
    const comment = rules.string({ min: decision === 'changes_requested' ? 1 : 0, max: REVIEW_COMMENT_MAX_LENGTH });
    const input = validate(await readJsonBody(ctx.req), {
      comment: decision === 'changes_requested' ? comment : { ...comment, optional: true },
    });

    const check = (s) => {
      assertActive(s);
      if (s.version.status !== 'pending_review') throw invalidTransition(s.version.status);
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      const reviewId = editorial.review(state.version.id, actor(ctx), decision, input.comment ?? '');
      if (reviewId === null) throw stateChanged();
      contents.touch(state.row.id);
      record(ctx, decision === 'approved' ? 'version.approve' : 'version.request_changes', state, {
        versionId: state.version.id, versionNumber: state.version.version_number, reviewId,
      });
      return state;
    });
    return response(s.row.id, s.version.id);
  }

  async function publish(ctx) {
    const initial = load(ctx);
    requirePermission(ctx, 'content.publish', initial.section.id);
    const input = validate(await readJsonBody(ctx.req), { revision: rules.integer({ min: 1, optional: true }) });

    const check = (s) => {
      assertActive(s);
      const { status } = s.version;
      if (status === 'draft') {
        // En 'approval' solo se publica la versión aprobada (D-040).
        if (s.section.workflow === 'approval') throw new HttpError(409, 'approval_required');
        assertRevision(s.version, input.revision);
      } else if (status !== 'approved') {
        throw invalidTransition(status);
      }
      assertPublishableBody(s.version);
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      const previousVersionId = state.row.published_version_id;
      if (!editorial.publish({ contentId: state.row.id, versionId: state.version.id, previousVersionId, userId: actor(ctx) })) {
        throw stateChanged();
      }
      record(ctx, 'version.publish', state, {
        versionId: state.version.id, versionNumber: state.version.version_number, from: state.version.status,
        replacedVersionId: previousVersionId,
      });
      return state;
    });
    return response(s.row.id, s.version.id);
  }

  function listReviews(ctx) {
    const { version } = load(ctx);
    return { status: 200, body: { reviews: editorial.reviews(version.id).map(toReview) } };
  }

  // --- Contenidos -------------------------------------------------------------

  function unpublish(ctx) {
    const initial = load(ctx);
    requirePermission(ctx, 'content.unpublish', initial.section.id);
    const check = (s) => {
      assertActive(s);
      if (s.row.status !== 'published') throw new HttpError(409, 'content_not_published');
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      if (!editorial.unpublish(state.row.id, state.row.published_version_id)) throw stateChanged();
      record(ctx, 'content.unpublish', state, {
        versionId: state.row.published_version_id, versionNumber: state.row.published_number,
      });
      return state;
    });
    return response(s.row.id);
  }

  function archive(ctx) {
    const initial = load(ctx);
    requirePermission(ctx, 'content.archive', initial.section.id);
    const check = (s) => {
      assertActive(s, { allowArchivedContent: true });
      if (s.row.status === 'archived') throw invalidTransition(s.row.status);
      // Una versión en revisión o aprobada se resuelve antes (como al eliminar, D-037).
      if (contents.blockingVersionCount(s.row.id) > 0) throw new HttpError(409, 'content_in_review');
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      const unpublished = state.row.published_version_id;
      if (!editorial.archive(state.row.id, unpublished)) throw stateChanged();
      record(ctx, 'content.archive', state, { from: state.row.status, unpublishedVersionId: unpublished });
      return state;
    });
    return response(s.row.id);
  }

  function restore(ctx) {
    const initial = load(ctx);
    requirePermission(ctx, 'content.archive', initial.section.id);
    const check = (s) => {
      assertActive(s, { allowArchivedContent: true });
      if (s.row.status !== 'archived') throw invalidTransition(s.row.status);
    };
    check(initial);
    const s = inTransaction(db, () => {
      const state = reload(ctx, check);
      if (!editorial.restore(state.row.id)) throw stateChanged();
      record(ctx, 'content.restore', state, {});
      return state;
    });
    return response(s.row.id);
  }

  /** Cola de revisión: versiones pendientes de todas las secciones (solo general_admin). */
  function pendingReviews() {
    return { status: 200, body: { pending: editorial.pending().map(toPending) } };
  }

  const session = { auth: true };
  const generalAdmin = { auth: true, role: 'general_admin' };
  const version = '/api/contents/:id/versions/:versionId';
  return Object.freeze({
    routes: [
      { method: 'POST', path: `${version}/submit`, handler: submit, ...session },
      { method: 'POST', path: `${version}/approve`, handler: (ctx) => review(ctx, 'approved'), ...generalAdmin },
      { method: 'POST', path: `${version}/request-changes`, handler: (ctx) => review(ctx, 'changes_requested'), ...generalAdmin },
      { method: 'POST', path: `${version}/publish`, handler: publish, ...session },
      { method: 'GET', path: `${version}/reviews`, handler: listReviews, ...session },
      { method: 'POST', path: '/api/contents/:id/unpublish', handler: unpublish, ...session },
      { method: 'POST', path: '/api/contents/:id/archive', handler: archive, ...session },
      { method: 'POST', path: '/api/contents/:id/restore', handler: restore, ...session },
      { method: 'GET', path: '/api/reviews/pending', handler: pendingReviews, ...generalAdmin },
    ],
  });
}
