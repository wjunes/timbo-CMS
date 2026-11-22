-- Migración 004 (Bloque 06): reglas del motor de contenidos y versionado.
--
-- La estructura de contents / content_versions es de la migración 001; aquí solo
-- se añaden invariantes que la aplicación también comprueba antes (para dar
-- errores claros), de modo que la base no quede en un estado inválido aunque se
-- escriba en ella por otra vía.

-- Un contenido no cambia de sección: los permisos se conceden por sección y un
-- movimiento cambiaría quién puede verlo y editarlo (D-034).
CREATE TRIGGER trg_contents_section_immutable
BEFORE UPDATE OF section_id ON contents
WHEN NEW.section_id IS NOT OLD.section_id
BEGIN
  SELECT RAISE(ABORT, 'content_section_immutable');
END;

-- Los contenidos no se borran físicamente: el borrado es lógico (status 'deleted')
-- y conserva el historial de versiones (D-035).
CREATE TRIGGER trg_contents_no_delete
BEFORE DELETE ON contents
BEGIN
  SELECT RAISE(ABORT, 'content_delete_forbidden');
END;

-- Una sección archivada es de solo lectura: no recibe contenidos nuevos.
CREATE TRIGGER trg_contents_insert_section_archived
BEFORE INSERT ON contents
BEGIN
  SELECT RAISE(ABORT, 'section_archived')
  WHERE (SELECT status FROM sections WHERE id = NEW.section_id) = 'archived';
END;

-- Las versiones nacen siempre como borrador; los demás estados se alcanzan
-- mediante transiciones (Bloque 07).
CREATE TRIGGER trg_versions_insert_draft_only
BEFORE INSERT ON content_versions
WHEN NEW.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'version_must_start_as_draft');
END;

-- No se crean versiones en secciones archivadas ni en contenidos archivados o eliminados.
CREATE TRIGGER trg_versions_insert_editable
BEFORE INSERT ON content_versions
BEGIN
  SELECT RAISE(ABORT, 'section_archived')
  WHERE (SELECT s.status FROM contents AS c JOIN sections AS s ON s.id = c.section_id WHERE c.id = NEW.content_id) = 'archived';
  SELECT RAISE(ABORT, 'content_not_editable')
  WHERE (SELECT status FROM contents WHERE id = NEW.content_id) IN ('archived', 'deleted');
END;

-- Lo mismo al editar un borrador (las transiciones de estado no se ven afectadas).
CREATE TRIGGER trg_versions_draft_update_editable
BEFORE UPDATE OF title, summary, body_format, body ON content_versions
WHEN OLD.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'section_archived')
  WHERE (SELECT s.status FROM contents AS c JOIN sections AS s ON s.id = c.section_id WHERE c.id = OLD.content_id) = 'archived';
  SELECT RAISE(ABORT, 'content_not_editable')
  WHERE (SELECT status FROM contents WHERE id = OLD.content_id) IN ('archived', 'deleted');
END;
