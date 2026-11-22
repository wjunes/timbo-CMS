/**
 * Acceso a contenidos y versiones. Solo consultas parametrizadas; las columnas
 * editables son listas cerradas (nada del cliente se interpola en el SQL).
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const CONTENT_COLUMNS = `
  c.id, c.section_id, c.slug, c.status, c.published_version_id, c.sort_order,
  c.created_by, c.created_at, c.updated_at, c.deleted_by, c.deleted_at`;

/** Metadatos de una versión con los nombres de sus autores (sin el cuerpo). */
const VERSION_COLUMNS = `
  v.id, v.content_id, v.version_number, v.based_on_version_id, v.status, v.title, v.summary, v.body_format,
  v.revision, v.created_at, v.updated_at, v.submitted_at, v.approved_at, v.published_at,
  v.created_by,   cu.display_name AS created_by_name,
  v.updated_by,   uu.display_name AS updated_by_name,
  v.submitted_by, su.display_name AS submitted_by_name,
  v.approved_by,  au.display_name AS approved_by_name,
  v.published_by, pu.display_name AS published_by_name`;

const VERSION_JOINS = `
  JOIN users AS cu ON cu.id = v.created_by
  LEFT JOIN users AS uu ON uu.id = v.updated_by
  LEFT JOIN users AS su ON su.id = v.submitted_by
  LEFT JOIN users AS au ON au.id = v.approved_by
  LEFT JOIN users AS pu ON pu.id = v.published_by`;

const OPEN_STATUSES = "('draft', 'pending_review', 'approved')";

/** @param {import('node:sqlite').DatabaseSync} db */
export function createContentRepository(db) {
  // Resumen para listados: título y número de la última versión, versión en curso y publicada.
  const summaryColumns = `${CONTENT_COLUMNS},
    (SELECT title FROM content_versions WHERE content_id = c.id ORDER BY version_number DESC LIMIT 1) AS latest_title,
    (SELECT max(version_number) FROM content_versions WHERE content_id = c.id) AS latest_number,
    (SELECT count(*) FROM content_versions WHERE content_id = c.id) AS version_count,
    o.id AS open_id, o.version_number AS open_number, o.status AS open_status, o.revision AS open_revision,
    o.created_by AS open_created_by,
    p.version_number AS published_number`;
  const summaryFrom = `
    FROM contents AS c
    LEFT JOIN content_versions AS o ON o.content_id = c.id AND o.status IN ${OPEN_STATUSES}
    LEFT JOIN content_versions AS p ON p.id = c.published_version_id`;

  const listBySection = db.prepare(`
    SELECT ${summaryColumns} ${summaryFrom}
    WHERE c.section_id = ? AND c.status <> 'deleted' ORDER BY c.sort_order, c.id`);
  const byId = db.prepare(`SELECT ${summaryColumns} ${summaryFrom} WHERE c.id = ?`);
  const slugTaken = db.prepare(`
    SELECT 1 AS ok FROM contents WHERE section_id = ? AND slug = ? AND status <> 'deleted' AND id IS NOT ?`);
  const nextSortOrder = db.prepare('SELECT coalesce(max(sort_order), 0) + 10 AS n FROM contents WHERE section_id = ?');
  const insertContent = db.prepare('INSERT INTO contents (section_id, slug, sort_order, created_by) VALUES (?, ?, ?, ?)');
  const touch = db.prepare(`UPDATE contents SET updated_at = ${NOW} WHERE id = ?`);
  const softDelete = db.prepare(`
    UPDATE contents SET status = 'deleted', deleted_by = ?, deleted_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`);

  const versions = db.prepare(`
    SELECT ${VERSION_COLUMNS} FROM content_versions AS v ${VERSION_JOINS}
    WHERE v.content_id = ? ORDER BY v.version_number DESC`);
  const version = db.prepare(`
    SELECT ${VERSION_COLUMNS}, v.body FROM content_versions AS v ${VERSION_JOINS}
    WHERE v.content_id = ? AND v.id = ?`);
  const nextNumber = db.prepare('SELECT coalesce(max(version_number), 0) + 1 AS n FROM content_versions WHERE content_id = ?');
  const insertVersion = db.prepare(`
    INSERT INTO content_versions (content_id, version_number, based_on_version_id, title, summary, body, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const sourceOf = db.prepare('SELECT title, summary, body FROM content_versions WHERE id = ?');
  const deleteVersion = db.prepare("DELETE FROM content_versions WHERE id = ? AND status = 'draft'");
  const blockingVersions = db.prepare(`
    SELECT count(*) AS n FROM content_versions WHERE content_id = ? AND status IN ('pending_review', 'approved')`);

  /** Columnas de contents editables: nombre de la API → columna. */
  const CONTENT_EDITABLE = Object.freeze({ slug: 'slug', sortOrder: 'sort_order' });
  /** Columnas de un borrador editables. */
  const DRAFT_EDITABLE = Object.freeze({ title: 'title', summary: 'summary', body: 'body' });

  const setClause = (changes, editable) =>
    Object.keys(changes).map((k) => {
      if (!Object.hasOwn(editable, k)) throw new TypeError(`Campo no editable: ${k}`);
      return `${editable[k]} = ?`;
    });

  return Object.freeze({
    listBySection: (sectionId) => listBySection.all(sectionId),
    findById: (id) => byId.get(id),
    isSlugTaken: (sectionId, slug, exceptId = null) => slugTaken.get(sectionId, slug, exceptId) !== undefined,

    /** Crea el contenido con su versión 1 en borrador. Debe llamarse dentro de una transacción. */
    create({ sectionId, slug, title, summary, body, userId }) {
      const sortOrder = nextSortOrder.get(sectionId).n;
      const contentId = Number(insertContent.run(sectionId, slug, sortOrder, userId).lastInsertRowid);
      const versionId = Number(insertVersion.run(contentId, 1, null, title, summary, body, userId, userId).lastInsertRowid);
      return { contentId, versionId };
    },

    update(id, changes) {
      const sets = setClause(changes, CONTENT_EDITABLE);
      if (!sets.length) return;
      db.prepare(`UPDATE contents SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ?`)
        .run(...Object.keys(changes).map((k) => changes[k]), id);
    },
    touch: (id) => touch.run(id),
    softDelete: (id, userId) => softDelete.run(userId, id),
    blockingVersionCount: (id) => blockingVersions.get(id).n,

    versions: (contentId) => versions.all(contentId),
    version: (contentId, versionId) => version.get(contentId, versionId),

    /** Nueva versión en borrador copiada de `sourceId`. Debe llamarse dentro de una transacción. */
    createVersionFrom({ contentId, sourceId, userId }) {
      const source = sourceOf.get(sourceId);
      const number = nextNumber.get(contentId).n;
      const id = Number(insertVersion.run(contentId, number, sourceId, source.title, source.summary, source.body, userId, userId).lastInsertRowid);
      return { id, number };
    },

    /**
     * Guarda un borrador con control optimista: solo si sigue en borrador y con la revisión esperada.
     * @returns {boolean} true si se guardó.
     */
    saveDraft(versionId, expectedRevision, changes, userId) {
      const sets = setClause(changes, DRAFT_EDITABLE);
      const { changes: n } = db
        .prepare(`
          UPDATE content_versions SET ${sets.join(', ')}, revision = revision + 1, updated_by = ?, updated_at = ${NOW}
          WHERE id = ? AND status = 'draft' AND revision = ?`)
        .run(...Object.keys(changes).map((k) => changes[k]), userId, versionId, expectedRevision);
      return n === 1;
    },

    discardDraft: (versionId) => deleteVersion.run(versionId).changes === 1,
  });
}
