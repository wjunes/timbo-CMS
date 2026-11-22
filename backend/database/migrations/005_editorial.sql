-- Migración 005 (Bloque 07): reglas del flujo editorial.
--
-- La aplicación comprueba lo mismo antes (para dar errores claros); estos
-- triggers garantizan que la base no quede en un estado editorial inválido
-- aunque se escriba en ella por otra vía.

-- Transiciones válidas del estado de una versión:
--   draft          -> pending_review | published
--   pending_review -> approved | changes_requested
--   approved       -> published
--   published      -> archived
-- changes_requested y archived son finales (se trabaja sobre una versión nueva).
-- La vuelta a borrador ya la impide trg_versions_content_immutable (001).
CREATE TRIGGER trg_versions_status_transition
BEFORE UPDATE OF status ON content_versions
WHEN NEW.status IS NOT OLD.status AND NEW.status <> 'draft' AND NOT (
     (OLD.status = 'draft'          AND NEW.status IN ('pending_review', 'published'))
  OR (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'changes_requested'))
  OR (OLD.status = 'approved'       AND NEW.status = 'published')
  OR (OLD.status = 'published'      AND NEW.status = 'archived'))
BEGIN
  SELECT RAISE(ABORT, 'version_invalid_transition');
END;

-- Una versión se revisa una sola vez: la decisión es final.
CREATE UNIQUE INDEX ux_reviews_one_per_version ON publication_reviews (content_version_id);

-- Aprobar o solicitar cambios exige la revisión registrada con esa decisión;
-- la aprobación, además, la firma quien hizo la revisión.
CREATE TRIGGER trg_versions_review_required
BEFORE UPDATE OF status ON content_versions
WHEN OLD.status = 'pending_review' AND NEW.status IN ('approved', 'changes_requested')
BEGIN
  SELECT RAISE(ABORT, 'review_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM publication_reviews
    WHERE content_version_id = OLD.id AND decision = NEW.status
      AND (NEW.status <> 'approved' OR reviewer_id IS NEW.approved_by));
END;

-- En las secciones con flujo 'approval' un borrador no se publica sin aprobación.
CREATE TRIGGER trg_versions_publish_requires_approval
BEFORE UPDATE OF status ON content_versions
WHEN OLD.status = 'draft' AND NEW.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'approval_required')
  WHERE (SELECT s.workflow FROM contents AS c JOIN sections AS s ON s.id = c.section_id WHERE c.id = OLD.content_id) = 'approval';
END;

-- content.publish también publica versiones aprobadas en secciones 'approval' (D-040).
UPDATE permissions
SET description = 'Publicar contenidos (en secciones con flujo approval, solo versiones aprobadas)'
WHERE code = 'content.publish';
