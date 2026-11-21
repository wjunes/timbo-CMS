/**
 * Administración de secciones (Bloque 05).
 *
 * - Escritura: solo el general_admin (el rol se exige en app.js).
 * - Lectura: el general_admin ve todas; un section_admin solo las asignadas
 *   (las demás responden 404, para no revelar su existencia).
 * - Tipos y presentaciones son catálogos del sistema, de solo lectura.
 * - Las invariantes de jerarquía y estado las garantiza la base (migración 003);
 *   aquí se validan antes para dar errores claros y se traducen los códigos.
 * - Cada escritura y su auditoría se confirman en la misma transacción.
 */
import { isTriggerAbort, isUniqueViolation } from '../../database/errors.js';
import { withTransaction } from '../../database/transaction.js';
import { HttpError, readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';
import { createPermissionRepository } from '../permissions/repository.js';
import { createSectionRepository } from './repository.js';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, isReservedSlug, slugify } from './slug.js';

export const WORKFLOWS = Object.freeze(['direct', 'approval']);

/** Transiciones de estado por acción. */
const STATUS_ACTIONS = Object.freeze({
  activate: { from: ['inactive', 'archived'], to: 'active' },
  deactivate: { from: ['active', 'archived'], to: 'inactive' },
  archive: { from: ['active', 'inactive'], to: 'archived' },
});

/** Códigos de trigger (migración 001/003) que se devuelven tal cual como 409. */
const TRIGGER_CONFLICTS = Object.freeze([
  'section_cycle', 'section_depth_exceeded', 'parent_archived', 'section_has_active_children', 'system_section_protected',
]);

function translateDbError(err) {
  if (isUniqueViolation(err)) return new HttpError(409, 'slug_taken');
  const code = TRIGGER_CONFLICTS.find((c) => isTriggerAbort(err, c));
  return code ? new HttpError(409, code) : err;
}

function inTransaction(db, fn) {
  try {
    return withTransaction(db, fn);
  } catch (err) {
    throw translateDbError(err);
  }
}

const fieldError = (field, code) => new HttpError(400, 'validation_failed', {}, { fields: { [field]: code } });

/** @param {{ db: import('node:sqlite').DatabaseSync }} deps */
export function createSectionsModule({ db }) {
  const sections = createSectionRepository(db);
  const permissions = createPermissionRepository(db);
  const audit = createAuditLog(db);

  // Catálogos: solo cambian con una migración, y el servidor no arranca con migraciones pendientes.
  const typeRows = sections.types();
  const typeByCode = new Map(typeRows.map((t) => [t.code, t]));
  const presentationCodes = sections.presentations().map((p) => p.code);

  const actor = (ctx) => ctx.auth.session.user.id;
  const isGeneralAdmin = (ctx) => ctx.auth.session.user.role === 'general_admin';

  /** Ordena en profundidad (por sort_order) y calcula ruta y nivel de cada sección. */
  function tree() {
    const rows = sections.all();
    const children = new Map();
    for (const row of rows) {
      const key = row.parent_id ?? 0;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(row);
    }
    const out = [];
    const walk = (parentId, prefix, depth) => {
      for (const row of children.get(parentId) ?? []) {
        const path = prefix ? `${prefix}/${row.slug}` : row.slug;
        out.push(toPublic(row, path, depth));
        walk(row.id, path, depth + 1);
      }
    };
    walk(0, '', 1);
    return out;
  }

  const toPublic = (row, path, depth) => ({
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    path,
    depth,
    name: row.name,
    description: row.description,
    type: row.type,
    presentation: row.presentation,
    workflow: row.workflow,
    status: row.status,
    isSystem: row.is_system === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const findPublic = (id) => tree().find((s) => s.id === id);

  /** Secciones visibles para el usuario de la sesión. */
  function visibleTo(ctx) {
    const all = tree();
    if (isGeneralAdmin(ctx)) return all;
    const assigned = new Set(permissions.accessForUser(actor(ctx)).map((s) => s.id));
    return all.filter((s) => assigned.has(s.id));
  }

  function load(id) {
    const row = sections.findById(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  function checkParent(parentId) {
    if (parentId === null) return;
    if (!sections.findById(parentId)) throw fieldError('parentId', 'not_found');
  }

  function checkSlug(slug, parentId) {
    if (isReservedSlug(slug, parentId === null)) throw fieldError('slug', 'reserved');
  }

  const slugRule = (o = {}) => rules.string({ min: 1, max: SLUG_MAX_LENGTH, pattern: SLUG_PATTERN, ...o });

  // --- Lectura ---------------------------------------------------------------

  function list(ctx) {
    return { status: 200, body: { sections: visibleTo(ctx) } };
  }

  function get(ctx) {
    const section = visibleTo(ctx).find((s) => s.id === ctx.params.id);
    if (!section) throw new HttpError(404, 'not_found');
    return { status: 200, body: { section } };
  }

  function listTypes() {
    const types = sections.types().map((t) => ({
      code: t.code, name: t.name, description: t.description, defaultPresentation: t.default_presentation,
    }));
    return { status: 200, body: { types } };
  }

  function listPresentations() {
    return { status: 200, body: { presentations: sections.presentations() } };
  }

  // --- Escritura (general_admin) ------------------------------------------

  async function create(ctx) {
    const input = validate(await readJsonBody(ctx.req), {
      name: rules.string({ min: 1, max: 120 }),
      type: rules.oneOf([...typeByCode.keys()]),
      slug: slugRule({ optional: true }),
      description: rules.string({ max: 1000, optional: true }),
      parentId: rules.integer({ min: 1, optional: true, nullable: true }),
      presentation: rules.oneOf(presentationCodes, { optional: true }),
      workflow: rules.oneOf(WORKFLOWS, { optional: true }),
    });
    const type = typeByCode.get(input.type);
    const parentId = input.parentId ?? null;
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw fieldError('slug', 'required');
    checkParent(parentId);
    checkSlug(slug, parentId);

    const id = inTransaction(db, () => {
      const sectionId = sections.create({
        typeId: type.id,
        parentId,
        slug,
        name: input.name,
        description: input.description ?? '',
        workflow: input.workflow ?? 'approval',
        presentation: input.presentation ?? type.default_presentation,
        createdBy: actor(ctx),
      });
      audit.record({
        action: 'section.create', outcome: 'success', actorUserId: actor(ctx), entityType: 'section', entityId: sectionId,
        sectionId, ip: ctx.ip, details: { slug, type: type.code, parentId },
      });
      return sectionId;
    });
    return { status: 201, body: { section: findPublic(id) } };
  }

  async function update(ctx) {
    const target = load(ctx.params.id);
    if (target.status === 'archived') throw new HttpError(409, 'section_archived');
    const input = validate(
      await readJsonBody(ctx.req),
      {
        name: rules.string({ min: 1, max: 120, optional: true }),
        description: rules.string({ max: 1000, optional: true }),
        slug: slugRule({ optional: true }),
        parentId: rules.integer({ min: 1, optional: true, nullable: true }),
        presentation: rules.oneOf(presentationCodes, { optional: true }),
        workflow: rules.oneOf(WORKFLOWS, { optional: true }),
      },
      { requireAny: true },
    );

    const current = {
      name: target.name, description: target.description, slug: target.slug, parentId: target.parent_id,
      presentation: target.presentation, workflow: target.workflow,
    };
    const changes = {};
    for (const [key, value] of Object.entries(input)) if (value !== current[key]) changes[key] = value;

    if ('parentId' in changes) checkParent(changes.parentId);
    if ('slug' in changes || 'parentId' in changes) {
      checkSlug(changes.slug ?? current.slug, 'parentId' in changes ? changes.parentId : current.parentId);
    }
    // Pasar a publicación directa con versiones en revisión las dejaría sin revisor (D-031).
    if (changes.workflow === 'direct' && sections.pendingReviewCount(target.id) > 0) {
      throw new HttpError(409, 'pending_reviews_exist');
    }

    if (Object.keys(changes).length) {
      inTransaction(db, () => {
        sections.update(target.id, changes);
        const diff = Object.fromEntries(Object.keys(changes).map((k) => [k, { from: current[k], to: changes[k] }]));
        audit.record({
          action: 'section.update', outcome: 'success', actorUserId: actor(ctx), entityType: 'section', entityId: target.id,
          sectionId: target.id, ip: ctx.ip, details: { changes: diff },
        });
      });
    }
    return { status: 200, body: { section: findPublic(target.id) } };
  }

  function changeStatus(action) {
    const rule = STATUS_ACTIONS[action];
    return (ctx) => {
      const target = load(ctx.params.id);
      if (!rule.from.includes(target.status)) throw new HttpError(409, 'invalid_status_transition');
      if (rule.to === 'archived' && target.is_system === 1) throw new HttpError(409, 'system_section_protected');
      inTransaction(db, () => {
        sections.setStatus(target.id, rule.to);
        audit.record({
          action: 'section.status_change', outcome: 'success', actorUserId: actor(ctx), entityType: 'section', entityId: target.id,
          sectionId: target.id, ip: ctx.ip, details: { from: target.status, to: rule.to },
        });
      });
      return { status: 200, body: { section: findPublic(target.id) } };
    };
  }

  function remove(ctx) {
    const target = load(ctx.params.id);
    if (target.is_system === 1) throw new HttpError(409, 'system_section_protected');
    const usage = sections.usage(target.id);
    if (usage.children || usage.contents || usage.media) throw new HttpError(409, 'section_in_use', {}, { usage });
    inTransaction(db, () => {
      const removedAssignments = sections.assignedUserIds(target.id);
      sections.remove(target.id); // las asignaciones y sus permisos se eliminan en cascada
      audit.record({
        action: 'section.delete', outcome: 'success', actorUserId: actor(ctx), entityType: 'section', entityId: target.id,
        sectionId: target.id, ip: ctx.ip, details: { slug: target.slug, name: target.name, removedAssignments },
      });
    });
    return { status: 204 };
  }

  async function reorder(ctx) {
    const { parentId, ids } = validate(await readJsonBody(ctx.req), {
      parentId: rules.integer({ min: 1, nullable: true }),
      ids: rules.idList({ max: 500 }),
    });
    if (parentId !== null && !sections.findById(parentId)) throw fieldError('parentId', 'not_found');
    const before = sections.siblingIds(parentId);
    // Debe enviarse exactamente el conjunto de secciones de ese nivel.
    if (before.length !== ids.length || !ids.every((id) => before.includes(id))) {
      throw new HttpError(409, 'order_mismatch');
    }
    const changed = ids.some((id, i) => id !== before[i]);
    if (changed) {
      inTransaction(db, () => {
        ids.forEach((id, i) => sections.setSortOrder(id, (i + 1) * 10));
        audit.record({
          action: 'section.reorder', outcome: 'success', actorUserId: actor(ctx), entityType: 'section', entityId: parentId,
          sectionId: parentId, ip: ctx.ip, details: { parentId, before, after: ids },
        });
      });
    }
    return { status: 200, body: { parentId, ids: sections.siblingIds(parentId), changed } };
  }

  const ga = { auth: true, role: 'general_admin' };
  const session = { auth: true };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/section-types', handler: listTypes, ...session },
      { method: 'GET', path: '/api/presentations', handler: listPresentations, ...session },
      { method: 'GET', path: '/api/sections', handler: list, ...session },
      { method: 'POST', path: '/api/sections', handler: create, ...ga },
      { method: 'PUT', path: '/api/sections/order', handler: reorder, ...ga },
      { method: 'GET', path: '/api/sections/:id', handler: get, ...session },
      { method: 'PATCH', path: '/api/sections/:id', handler: update, ...ga },
      { method: 'DELETE', path: '/api/sections/:id', handler: remove, ...ga },
      { method: 'POST', path: '/api/sections/:id/activate', handler: changeStatus('activate'), ...ga },
      { method: 'POST', path: '/api/sections/:id/deactivate', handler: changeStatus('deactivate'), ...ga },
      { method: 'POST', path: '/api/sections/:id/archive', handler: changeStatus('archive'), ...ga },
    ],
  });
}
