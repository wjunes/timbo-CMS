/**
 * Acceso a media / content_media. Solo consultas parametrizadas.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const MEDIA_COLUMNS = `
  m.id, m.storage_key, m.original_name, m.mime_type, m.extension, m.size_bytes, m.sha256, m.width, m.height,
  m.alt_text, m.visibility, m.section_id, m.status, m.created_at, m.deleted_at,
  m.uploaded_by, u.display_name AS uploaded_by_name`;

/** Estados de versión que impiden eliminar un archivo que usan (D-047). */
export const BLOCKING_VERSION_STATUSES = Object.freeze(['draft', 'pending_review', 'approved', 'published']);

/** @param {import('node:sqlite').DatabaseSync} db */
export function createMediaRepository(db) {
  const insert = db.prepare(`
    INSERT INTO media (storage_key, original_name, mime_type, extension, size_bytes, sha256, width, height,
                       alt_text, visibility, section_id, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?)`);
  const byId = db.prepare(`SELECT ${MEDIA_COLUMNS} FROM media AS m JOIN users AS u ON u.id = m.uploaded_by WHERE m.id = ?`);
  const listBySection = db.prepare(`
    SELECT ${MEDIA_COLUMNS} FROM media AS m JOIN users AS u ON u.id = m.uploaded_by
    WHERE m.section_id = ? AND m.status = 'active' ORDER BY m.created_at DESC, m.id DESC`);
  const updateAlt = db.prepare("UPDATE media SET alt_text = ? WHERE id = ? AND status = 'active'");
  const softDelete = db.prepare(`
    UPDATE media SET status = 'deleted', deleted_by = ?, deleted_at = ${NOW} WHERE id = ? AND status = 'active'`);
  // Versiones de contenidos no eliminados que usan el archivo (las de contenidos eliminados no se pueden editar ni publicar).
  const usage = db.prepare(`
    SELECT v.id AS version_id, v.version_number, v.status AS version_status, v.title,
           c.id AS content_id, c.slug, c.status AS content_status
    FROM content_media AS cm
    JOIN content_versions AS v ON v.id = cm.content_version_id
    JOIN contents AS c ON c.id = v.content_id
    WHERE cm.media_id = ? AND c.status <> 'deleted'
    ORDER BY c.id, v.version_number DESC`);

  return Object.freeze({
    /** @returns {number} id */
    insert: (m) => Number(insert.run(
      m.storageKey, m.originalName, m.mimeType, m.extension, m.sizeBytes, m.sha256, m.width, m.height,
      m.altText, m.sectionId, m.uploadedBy,
    ).lastInsertRowid),
    findById: (id) => byId.get(id),
    listBySection: (sectionId) => listBySection.all(sectionId),
    updateAlt: (id, alt) => updateAlt.run(alt, id).changes === 1,
    softDelete: (id, userId) => softDelete.run(userId, id).changes === 1,
    usage: (id) => usage.all(id),
  });
}
