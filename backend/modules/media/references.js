/**
 * Referencias del cuerpo de una versión a la biblioteca multimedia (D-050).
 *
 * `validateBody` devuelve las referencias (nodos `image` y enlaces `/media/<id>`).
 * Aquí se comprueba que cada archivo existe, está activo y es de la misma
 * sección del contenido (y que una imagen es una imagen), y se registran en
 * `content_media`, que es lo que impide eliminar un archivo en uso.
 *
 * - Al guardar un borrador: error 400 en el campo `body`, con `bodyPath`.
 * - Al enviar a revisión o publicar: 409 `media_not_available` (un archivo pudo
 *   eliminarse después de guardar, si el borrador venía de una versión archivada).
 * La base lo garantiza también (migración 006).
 */
import { HttpError } from '../../middleware/http.js';
import { MEDIA_TYPES } from './inspect.js';

/** @param {import('node:sqlite').DatabaseSync} db */
export function createMediaReferences(db) {
  const mediaById = db.prepare('SELECT id, section_id, status, mime_type, width, height FROM media WHERE id = ?');
  const clear = db.prepare('DELETE FROM content_media WHERE content_version_id = ?');
  const add = db.prepare('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)');
  const copy = db.prepare(`
    INSERT INTO content_media (content_version_id, media_id)
    SELECT ?, media_id FROM content_media WHERE content_version_id = ?`);

  const isImageRef = (ref) => ref.path.endsWith('/attrs/mediaId');

  /** Primera referencia no utilizable, con el motivo; null si todas lo son. */
  function firstUnavailable(sectionId, refs) {
    for (const ref of refs) {
      const row = mediaById.get(ref.mediaId);
      if (!row || row.status !== 'active' || row.section_id !== sectionId) return { ref, code: 'media_not_available' };
      if (isImageRef(ref) && MEDIA_TYPES[row.mime_type]?.kind !== 'image') return { ref, code: 'media_not_image' };
    }
    return null;
  }

  return Object.freeze({
    /** Al guardar: 400 validation_failed con `fields.body`, `bodyPath` y `mediaId`. */
    assertSavable(sectionId, refs) {
      const bad = firstUnavailable(sectionId, refs);
      if (bad) {
        throw new HttpError(400, 'validation_failed', {}, { fields: { body: bad.code }, bodyPath: bad.ref.path, mediaId: bad.ref.mediaId });
      }
    },

    /** Al enviar o publicar: 409 con el código, `bodyPath` y `mediaId`. */
    assertPublishable(sectionId, refs) {
      const bad = firstUnavailable(sectionId, refs);
      if (bad) throw new HttpError(409, bad.code, {}, { bodyPath: bad.ref.path, mediaId: bad.ref.mediaId });
    },

    /** Deja en content_media exactamente los archivos del cuerpo. Dentro de una transacción. */
    sync(versionId, refs) {
      clear.run(versionId);
      for (const id of new Set(refs.map((r) => r.mediaId))) add.run(versionId, id);
    },

    /** Copia las referencias de una versión a otra nueva (mismo cuerpo). Dentro de una transacción. */
    copy: (fromVersionId, toVersionId) => copy.run(toVersionId, fromVersionId),

    /** Dimensiones de las imágenes activas referenciadas, para el renderizado. */
    dimensions(refs) {
      const map = new Map();
      for (const id of new Set(refs.map((r) => r.mediaId))) {
        const row = mediaById.get(id);
        if (row?.status === 'active') map.set(id, { width: row.width, height: row.height });
      }
      return map;
    },
  });
}
