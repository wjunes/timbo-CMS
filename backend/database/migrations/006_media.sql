-- Migración 006 (Bloque 08): reglas de la multimedia.
--
-- La estructura de media / content_media es de la migración 001. Aquí se añaden
-- las invariantes que la aplicación también comprueba antes (para dar errores
-- claros), de modo que la base no quede en un estado inválido aunque se escriba
-- en ella por otra vía.

-- Los datos del archivo son inmutables: el archivo en disco no cambia nunca
-- después de subirlo. Solo se editan el texto alternativo y el estado.
CREATE TRIGGER trg_media_identity_immutable
BEFORE UPDATE OF storage_key, original_name, mime_type, extension, size_bytes, sha256, width, height,
                 visibility, section_id, uploaded_by, created_at ON media
WHEN NEW.storage_key IS NOT OLD.storage_key
  OR NEW.original_name IS NOT OLD.original_name
  OR NEW.mime_type IS NOT OLD.mime_type
  OR NEW.extension IS NOT OLD.extension
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.width IS NOT OLD.width
  OR NEW.height IS NOT OLD.height
  OR NEW.visibility IS NOT OLD.visibility
  OR NEW.section_id IS NOT OLD.section_id
  OR NEW.uploaded_by IS NOT OLD.uploaded_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'media_immutable');
END;

-- Un archivo eliminado no vuelve a estar activo ni se edita.
CREATE TRIGGER trg_media_deleted_final
BEFORE UPDATE ON media
WHEN OLD.status = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'media_deleted');
END;

-- No se elimina un archivo que usa una versión en borrador, en revisión,
-- aprobada o publicada (D-047). Las versiones archivadas, las de cambios
-- solicitados y las de contenidos eliminados no lo impiden: el archivo físico
-- se conserva igualmente (borrado lógico).
CREATE TRIGGER trg_media_delete_in_use
BEFORE UPDATE OF status ON media
WHEN NEW.status = 'deleted' AND OLD.status = 'active'
  AND EXISTS (
    SELECT 1 FROM content_media AS cm
    JOIN content_versions AS v ON v.id = cm.content_version_id
    JOIN contents AS c ON c.id = v.content_id
    WHERE cm.media_id = NEW.id AND c.status <> 'deleted'
      AND v.status IN ('draft', 'pending_review', 'approved', 'published'))
BEGIN
  SELECT RAISE(ABORT, 'media_in_use');
END;

-- No se suben archivos a una sección archivada.
CREATE TRIGGER trg_media_insert_section_archived
BEFORE INSERT ON media
WHEN NEW.section_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'section_archived')
  WHERE (SELECT status FROM sections WHERE id = NEW.section_id) = 'archived';
END;

-- Una versión solo referencia archivos de su propia sección.
CREATE TRIGGER trg_content_media_same_section
BEFORE INSERT ON content_media
BEGIN
  SELECT RAISE(ABORT, 'media_section_mismatch')
  WHERE (SELECT section_id FROM media WHERE id = NEW.media_id) IS NOT (
    SELECT c.section_id FROM content_versions AS v JOIN contents AS c ON c.id = v.content_id
    WHERE v.id = NEW.content_version_id);
END;

-- No se envía a revisión ni se publica una versión que usa un archivo eliminado.
CREATE TRIGGER trg_versions_media_available
BEFORE UPDATE OF status ON content_versions
WHEN NEW.status IN ('pending_review', 'published') AND NEW.status IS NOT OLD.status
  AND EXISTS (
    SELECT 1 FROM content_media AS cm JOIN media AS m ON m.id = cm.media_id
    WHERE cm.content_version_id = NEW.id AND m.status <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'media_not_available');
END;

UPDATE permissions SET description = 'Subir archivos multimedia y documentos, y editar su texto alternativo'
WHERE code = 'media.upload';
