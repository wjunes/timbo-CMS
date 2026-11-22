/**
 * Consulta y verificación del registro de auditoría (Bloque 10, solo general_admin).
 *
 * - Solo lectura: no hay ninguna ruta que modifique o borre entradas, y la base
 *   tampoco lo permite (triggers de las migraciones 001 y 008).
 * - Filtros por fecha, autor, acción (exacta o prefijo terminado en "."),
 *   resultado, entidad y sección. Paginación por cursor (`before`: id).
 * - La verificación recorre la cadena de huellas y la compara con las anclas
 *   de las copias de seguridad (D-059).
 */
import { HttpError } from '../../middleware/http.js';
import { createAuditChain } from './chain.js';

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const ACTION = /^[a-z0-9_.]{1,64}$/;
const ENTITY = /^[a-z_]{1,40}$/;
const ID = /^[1-9]\d{0,15}$/;
const OUTCOMES = ['success', 'failure', 'denied'];
const PARAMS = new Set(['from', 'to', 'actor', 'action', 'outcome', 'entityType', 'entityId', 'section', 'before', 'limit']);
export const AUDIT_PAGE_MAX = 200;

/** Fecha ISO → formato de id de copia (AAAAMMDDhhmmss), para comparar. */
const compactId = (iso) => iso.replace(/[-:T]/g, '').slice(0, 14);

/** Lee y valida los filtros: cualquier parámetro desconocido o mal formado es un 400. */
export function parseAuditQuery(searchParams) {
  const fields = {};
  const q = {};
  for (const key of new Set(searchParams.keys())) {
    if (!PARAMS.has(key)) fields[key] = 'unknown_field';
    else if (searchParams.getAll(key).length > 1) fields[key] = 'duplicated_value';
  }
  const get = (key, re, convert = (v) => v) => {
    const v = searchParams.get(key);
    if (v === null || v === '') return;
    if (!re.test(v)) fields[key] = 'invalid_format';
    else q[key] = convert(v);
  };
  get('from', DATE, (v) => (v.length === 10 ? `${v}T00:00:00.000Z` : v));
  // "to" con solo fecha incluye todo ese día.
  get('to', DATE, (v) => (v.length === 10 ? `${v}T23:59:59.999Z` : v));
  get('actor', ID, Number);
  get('action', ACTION);
  get('outcome', new RegExp(`^(${OUTCOMES.join('|')})$`));
  get('entityType', ENTITY);
  get('entityId', ID, Number);
  get('section', ID, Number);
  get('before', ID, Number);
  get('limit', /^\d{1,3}$/, Number);
  if (q.limit !== undefined && (q.limit < 1 || q.limit > AUDIT_PAGE_MAX)) fields.limit = 'invalid_value';
  if (q.entityId !== undefined && q.entityType === undefined) fields.entityId = 'requires_entity_type';
  if (Object.keys(fields).length) throw new HttpError(400, 'validation_failed', {}, { fields });
  return q;
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, anchors?: () => Promise<{ source: string, id: number, hash: string }[]> }} deps
 */
export function createAuditModule({ db, anchors = async () => [] }) {
  const chain = createAuditChain(db);
  const restores = db.prepare(`SELECT occurred_at, json_extract(details, '$.backupId') AS backup_id,
      json_extract(details, '$.safetyBackupId') AS safety_id
    FROM audit_logs WHERE action = 'backup.restore' AND outcome = 'success'`);

  /**
   * Una restauración vuelve a un punto anterior de la cadena y la continúa por
   * otro camino: las copias hechas entre ese punto y la restauración son de una
   * historia descartada y no sirven como ancla. Tampoco la copia del estado
   * anterior que guarda la propia restauración.
   */
  async function liveAnchors() {
    const list = restores.all();
    const abandoned = list.map((r) => [String(r.backup_id), compactId(r.occurred_at)]);
    const safety = new Set(list.map((r) => r.safety_id).filter(Boolean).map(String));
    return (await anchors()).filter((a) => !safety.has(a.source) && !abandoned.some(([from, to]) => a.source > from && a.source <= to));
  }

  function search(q) {
    const where = [];
    const args = {};
    if (q.from) { where.push('a.occurred_at >= :from'); args.from = q.from; }
    if (q.to) { where.push('a.occurred_at <= :to'); args.to = q.to; }
    if (q.actor) { where.push('a.actor_user_id = :actor'); args.actor = q.actor; }
    if (q.action) {
      if (q.action.endsWith('.')) { where.push('substr(a.action, 1, length(:action)) = :action'); }
      else where.push('a.action = :action');
      args.action = q.action;
    }
    if (q.outcome) { where.push('a.outcome = :outcome'); args.outcome = q.outcome; }
    if (q.entityType) { where.push('a.entity_type = :entityType'); args.entityType = q.entityType; }
    if (q.entityId) { where.push('a.entity_id = :entityId'); args.entityId = q.entityId; }
    if (q.section) { where.push('a.section_id = :section'); args.section = q.section; }
    if (q.before) { where.push('a.id < :before'); args.before = q.before; }
    const limit = q.limit ?? 50;
    const rows = db.prepare(`
      SELECT a.id, a.occurred_at, a.actor_user_id, u.username, u.display_name, a.action, a.outcome,
             a.entity_type, a.entity_id, a.section_id, a.ip_address, a.details
      FROM audit_logs AS a LEFT JOIN users AS u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ${limit + 1}`).all(args);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actor: r.actor_user_id === null ? null : { id: r.actor_user_id, username: r.username, displayName: r.display_name },
      action: r.action,
      outcome: r.outcome,
      entityType: r.entity_type,
      entityId: r.entity_id,
      sectionId: r.section_id,
      ip: r.ip_address,
      details: JSON.parse(r.details),
    }));
    return { entries, nextBefore: more ? entries.at(-1).id : null };
  }

  function list(ctx) {
    const q = parseAuditQuery(new URL(ctx.req.url, 'http://localhost').searchParams);
    return { status: 200, body: search(q) };
  }

  async function verify() {
    const result = chain.verify(await liveAnchors());
    return { status: 200, body: result };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    search,
    verify: async () => chain.verify(await liveAnchors()),
    routes: [
      { method: 'GET', path: '/api/audit', handler: list, ...ga },
      { method: 'GET', path: '/api/audit/verify', handler: verify, ...ga },
    ],
  });
}
