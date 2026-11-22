/**
 * Transiciones editoriales sobre contents / content_versions / publication_reviews.
 *
 * Solo consultas parametrizadas. Cada UPDATE lleva como condición el estado de
 * origen y devuelve si afectó a la fila: así una transición nunca se aplica
 * sobre un estado distinto del comprobado. Las funciones que hacen varios
 * cambios deben llamarse dentro de una transacción.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** @param {import('node:sqlite').DatabaseSync} db */
export function createEditorialRepository(db) {
  const submit = db.prepare(`
    UPDATE content_versions SET status = 'pending_review', submitted_by = ?, submitted_at = ${NOW}
    WHERE id = ? AND status = 'draft' AND revision = ?`);
  const insertReview = db.prepare(`
    INSERT INTO publication_reviews (content_version_id, reviewer_id, decision, comment) VALUES (?, ?, ?, ?)`);
  const approve = db.prepare(`
    UPDATE content_versions SET status = 'approved', approved_by = ?, approved_at = ${NOW}
    WHERE id = ? AND status = 'pending_review'`);
  const requestChanges = db.prepare(`
    UPDATE content_versions SET status = 'changes_requested' WHERE id = ? AND status = 'pending_review'`);
  const publishVersion = db.prepare(`
    UPDATE content_versions SET status = 'published', published_by = ?, published_at = ${NOW}
    WHERE id = ? AND status IN ('draft', 'approved')`);
  const archiveVersion = db.prepare(`
    UPDATE content_versions SET status = 'archived' WHERE id = ? AND status = 'published'`);
  const clearPointer = db.prepare(`
    UPDATE contents SET status = ?, published_version_id = NULL, updated_at = ${NOW}
    WHERE id = ? AND status = 'published' AND published_version_id = ?`);
  const setPointer = db.prepare(`
    UPDATE contents SET status = 'published', published_version_id = ?, updated_at = ${NOW}
    WHERE id = ? AND status = 'draft' AND published_version_id IS NULL`);
  const setContentStatus = db.prepare(`
    UPDATE contents SET status = ?, updated_at = ${NOW} WHERE id = ? AND status = ?`);

  const reviews = db.prepare(`
    SELECT r.id, r.content_version_id, r.decision, r.comment, r.created_at, r.reviewer_id, u.display_name AS reviewer_name
    FROM publication_reviews AS r JOIN users AS u ON u.id = r.reviewer_id
    WHERE r.content_version_id = ? ORDER BY r.created_at, r.id`);
  const pending = db.prepare(`
    SELECT v.id AS version_id, v.version_number, v.title, v.submitted_at, v.submitted_by, su.display_name AS submitted_by_name,
           c.id AS content_id, c.slug, c.status AS content_status, s.id AS section_id, s.name AS section_name
    FROM content_versions AS v
    JOIN contents AS c ON c.id = v.content_id
    JOIN sections AS s ON s.id = c.section_id
    JOIN users AS su ON su.id = v.submitted_by
    WHERE v.status = 'pending_review' AND c.status <> 'deleted'
    ORDER BY v.submitted_at, v.id`);

  const one = (stmt, ...args) => stmt.run(...args).changes === 1;

  /** Retira la versión publicada (pasa a `archived`) y deja el contenido en `toStatus`. */
  function retirePublished(contentId, publishedVersionId, toStatus) {
    return one(clearPointer, toStatus, contentId, publishedVersionId) && one(archiveVersion, publishedVersionId);
  }

  return Object.freeze({
    submit: (versionId, revision, userId) => one(submit, userId, versionId, revision),

    /** Registra la revisión y aplica la decisión. @returns {number|null} id de la revisión. */
    review(versionId, reviewerId, decision, comment) {
      const reviewId = Number(insertReview.run(versionId, reviewerId, decision, comment).lastInsertRowid);
      const applied = decision === 'approved' ? one(approve, reviewerId, versionId) : one(requestChanges, versionId);
      return applied ? reviewId : null;
    },

    /**
     * Publica la versión; si había otra publicada, la archiva antes (DATABASE.md,
     * «Reemplazar la versión publicada»). @returns {boolean}
     */
    publish({ contentId, versionId, previousVersionId, userId }) {
      if (previousVersionId !== null && !retirePublished(contentId, previousVersionId, 'draft')) return false;
      return one(publishVersion, userId, versionId) && one(setPointer, versionId, contentId);
    },

    /** Despublica: la versión publicada pasa a `archived` y el contenido a `draft`. */
    unpublish: (contentId, publishedVersionId) => retirePublished(contentId, publishedVersionId, 'draft'),

    /** Archiva el contenido; si estaba publicado, lo retira en el mismo paso. */
    archive(contentId, publishedVersionId) {
      if (publishedVersionId !== null) return retirePublished(contentId, publishedVersionId, 'archived');
      return one(setContentStatus, 'archived', contentId, 'draft');
    },

    restore: (contentId) => one(setContentStatus, 'draft', contentId, 'archived'),

    reviews: (versionId) => reviews.all(versionId),
    pending: () => pending.all(),
  });
}
