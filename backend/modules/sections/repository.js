/**
 * Acceso a secciones, tipos de sección y presentaciones.
 */

const SECTION_COLUMNS = `
  s.id, s.parent_id, s.slug, s.name, s.description, t.code AS type, s.presentation, s.workflow,
  s.status, s.sort_order, s.is_system, s.created_at, s.updated_at`;

/** @param {import('node:sqlite').DatabaseSync} db */
export function createSectionRepository(db) {
  const all = db.prepare(`
    SELECT ${SECTION_COLUMNS} FROM sections AS s JOIN section_types AS t ON t.id = s.section_type_id
    ORDER BY s.sort_order, s.id`);
  const byId = db.prepare(`
    SELECT ${SECTION_COLUMNS} FROM sections AS s JOIN section_types AS t ON t.id = s.section_type_id WHERE s.id = ?`);
  const types = db.prepare(`
    SELECT id, code, name, description, default_presentation FROM section_types ORDER BY id`);
  const presentations = db.prepare('SELECT code, name, description FROM presentations ORDER BY sort_order, code');
  const nextSortOrder = db.prepare(`
    SELECT coalesce(max(sort_order), 0) + 10 AS n FROM sections WHERE parent_id IS ?`);
  const insert = db.prepare(`
    INSERT INTO sections (section_type_id, parent_id, slug, name, description, workflow, presentation, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const siblings = db.prepare('SELECT id FROM sections WHERE parent_id IS ? ORDER BY sort_order, id');
  const setSortOrder = db.prepare(`
    UPDATE sections SET sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
  const setStatus = db.prepare(`
    UPDATE sections SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
  const remove = db.prepare('DELETE FROM sections WHERE id = ?');
  const childCount = db.prepare('SELECT count(*) AS n FROM sections WHERE parent_id = ?');
  const contentCount = db.prepare('SELECT count(*) AS n FROM contents WHERE section_id = ?');
  const mediaCount = db.prepare('SELECT count(*) AS n FROM media WHERE section_id = ?');
  const assignedUsers = db.prepare('SELECT user_id FROM user_sections WHERE section_id = ? ORDER BY user_id');
  const pendingReviews = db.prepare(`
    SELECT count(*) AS n FROM content_versions AS v JOIN contents AS c ON c.id = v.content_id
    WHERE c.section_id = ? AND v.status = 'pending_review'`);

  /** Columnas editables: nombre de la API → columna. Lista cerrada (no se interpola nada del cliente). */
  const EDITABLE = Object.freeze({
    name: 'name', description: 'description', slug: 'slug', parentId: 'parent_id', presentation: 'presentation', workflow: 'workflow',
  });

  function update(id, changes) {
    const keys = Object.keys(changes);
    if (!keys.length) return;
    const sets = keys.map((k) => {
      if (!Object.hasOwn(EDITABLE, k)) throw new TypeError(`Campo no editable: ${k}`);
      return `${EDITABLE[k]} = ?`;
    });
    db.prepare(`UPDATE sections SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...keys.map((k) => changes[k]), id);
  }

  return Object.freeze({
    all: () => all.all(),
    findById: (id) => byId.get(id),
    types: () => types.all(),
    presentations: () => presentations.all(),
    create({ typeId, parentId, slug, name, description, workflow, presentation, createdBy }) {
      const sortOrder = nextSortOrder.get(parentId).n;
      return Number(insert.run(typeId, parentId, slug, name, description, workflow, presentation, sortOrder, createdBy).lastInsertRowid);
    },
    update,
    setStatus: (id, status) => setStatus.run(status, id),
    siblingIds: (parentId) => siblings.all(parentId).map((r) => r.id),
    setSortOrder: (id, order) => setSortOrder.run(order, id),
    remove: (id) => remove.run(id),
    usage: (id) => ({
      children: childCount.get(id).n,
      contents: contentCount.get(id).n,
      media: mediaCount.get(id).n,
    }),
    assignedUserIds: (id) => assignedUsers.all(id).map((r) => r.user_id),
    pendingReviewCount: (id) => pendingReviews.get(id).n,
  });
}
