/**
 * Lecturas del sitio público (Bloque 09). Solo SELECT parametrizados.
 *
 * Nada de aquí decide la visibilidad por sí solo: las consultas de contenidos
 * exigen `status = 'published'` y leen siempre la versión del puntero
 * `published_version_id` (nunca un borrador). La visibilidad de las secciones
 * (activas con todos sus ancestros activos) la calcula index.js sobre el árbol.
 */

const PUBLISHED = `
  FROM contents AS c
  JOIN content_versions AS v ON v.id = c.published_version_id
  WHERE c.status = 'published'`;
const CONTENT_COLUMNS = 'c.id, c.section_id, c.slug, c.sort_order, v.id AS version_id, v.title, v.summary, v.published_at';

/** @param {import('node:sqlite').DatabaseSync} db */
export function createPublicRepository(db) {
  const sections = db.prepare(`
    SELECT s.id, s.parent_id, s.slug, s.name, s.description, s.presentation, s.status, s.sort_order, t.code AS type
    FROM sections AS s JOIN section_types AS t ON t.id = s.section_type_id
    ORDER BY s.sort_order, s.id`);
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?');

  // Orden: 'recent' (fecha de publicación) o 'manual' (orden del contenido).
  const listRecent = db.prepare(`SELECT ${CONTENT_COLUMNS}, v.body ${PUBLISHED} AND c.section_id = ?
    ORDER BY v.published_at DESC, c.id DESC LIMIT ? OFFSET ?`);
  const listManual = db.prepare(`SELECT ${CONTENT_COLUMNS}, v.body ${PUBLISHED} AND c.section_id = ?
    ORDER BY c.sort_order, c.id LIMIT ? OFFSET ?`);
  const count = db.prepare(`SELECT count(*) AS n ${PUBLISHED} AND c.section_id = ?`);
  const bySlug = db.prepare(`SELECT ${CONTENT_COLUMNS}, v.body, c.status FROM contents AS c
    LEFT JOIN content_versions AS v ON v.id = c.published_version_id
    WHERE c.section_id = ? AND c.slug = ? AND c.status <> 'deleted'`);
  const byId = db.prepare(`SELECT ${CONTENT_COLUMNS} ${PUBLISHED} AND c.id = ?`);
  const allPublished = db.prepare(`SELECT ${CONTENT_COLUMNS} ${PUBLISHED} ORDER BY v.published_at DESC`);

  const versionMedia = db.prepare(`
    SELECT m.id, m.original_name, m.mime_type, m.extension, m.size_bytes, m.width, m.height, m.alt_text
    FROM content_media AS cm JOIN media AS m ON m.id = cm.media_id
    WHERE cm.content_version_id = ? AND m.status = 'active' ORDER BY m.id`);
  // Secciones de los contenidos publicados cuya versión publicada usa el archivo.
  const mediaPublication = db.prepare(`
    SELECT m.id, m.storage_key, m.original_name, m.mime_type, m.sha256, c.section_id
    FROM media AS m
    JOIN content_media AS cm ON cm.media_id = m.id
    JOIN contents AS c ON c.published_version_id = cm.content_version_id AND c.status = 'published'
    WHERE m.id = ? AND m.status = 'active'`);

  const sectionRedirect = db.prepare('SELECT section_id FROM section_redirects WHERE coalesce(old_parent_id, 0) = ? AND old_slug = ?');
  const contentRedirect = db.prepare('SELECT content_id FROM content_redirects WHERE section_id = ? AND old_slug = ?');

  return Object.freeze({
    sections: () => sections.all(),
    /** Valor JSON de un ajuste, o `fallback` si falta o no es del tipo esperado. */
    setting(key, fallback) {
      const row = setting.get(key);
      if (!row) return fallback;
      const value = JSON.parse(row.value);
      return typeof value === typeof fallback ? value : fallback;
    },
    list: (sectionId, { order, limit, offset }) => (order === 'manual' ? listManual : listRecent).all(sectionId, limit, offset),
    count: (sectionId) => count.get(sectionId).n,
    /** Contenido no eliminado por slug (publicado o no: quien llama comprueba `status`). */
    bySlug: (sectionId, slug) => bySlug.get(sectionId, slug),
    publishedById: (id) => byId.get(id),
    allPublished: () => allPublished.all(),
    versionMedia: (versionId) => versionMedia.all(versionId),
    mediaPublication: (mediaId) => mediaPublication.all(mediaId),
    sectionRedirect: (parentId, slug) => sectionRedirect.get(parentId ?? 0, slug)?.section_id ?? null,
    contentRedirect: (sectionId, slug) => contentRedirect.get(sectionId, slug)?.content_id ?? null,
  });
}
