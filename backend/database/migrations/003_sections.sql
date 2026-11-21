-- 003 · Secciones: catálogo de presentaciones y reglas de jerarquía y estado (Bloque 05)
--
-- Este archivo NO debe modificarse una vez aplicado: los cambios van en 004+.

-- ---------------------------------------------------------------------------
-- Catálogo de presentaciones (D-027)
-- ---------------------------------------------------------------------------
-- Antes, las presentaciones eran una lista fija en un CHECK, y SQLite no permite
-- modificarlo sin reconstruir la tabla. Con un catálogo, añadir una presentación
-- es un INSERT en una migración (junto con su plantilla en el sitio público).
CREATE TABLE presentations (
  code        TEXT    PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 40 AND code NOT GLOB '*[^a-z0-9_]*'),
  name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  sort_order  INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

INSERT INTO presentations (code, name, description, sort_order) VALUES
  ('page',          'Página',               'Un único contenido a página completa.',              10),
  ('list',          'Lista',                'Contenidos en lista, del más reciente al más antiguo.', 20),
  ('grid',          'Cuadrícula',           'Contenidos en tarjetas.',                            30),
  ('accordion',     'Acordeón',             'Preguntas y respuestas desplegables.',               40),
  ('document_list', 'Lista de documentos',  'Documentos descargables con sus metadatos.',         50);

-- Sustitución de la columna con CHECK por una clave foránea al catálogo, sin
-- reconstruir la tabla (una reconstrucción exigiría desactivar las claves
-- foráneas y arriesgaría borrados en cascada de las asignaciones).
-- SQLite no admite añadir una columna con REFERENCES y valor por defecto no nulo,
-- así que NOT NULL se garantiza con triggers.
ALTER TABLE sections ADD COLUMN presentation_code TEXT REFERENCES presentations (code);
UPDATE sections SET presentation_code = presentation;
ALTER TABLE sections DROP COLUMN presentation;
ALTER TABLE sections RENAME COLUMN presentation_code TO presentation;

ALTER TABLE section_types ADD COLUMN default_presentation_code TEXT REFERENCES presentations (code);
UPDATE section_types SET default_presentation_code = default_presentation;
ALTER TABLE section_types DROP COLUMN default_presentation;
ALTER TABLE section_types RENAME COLUMN default_presentation_code TO default_presentation;

CREATE INDEX ix_sections_presentation ON sections (presentation);
CREATE INDEX ix_section_types_presentation ON section_types (default_presentation);

CREATE TRIGGER trg_sections_presentation_required_insert
BEFORE INSERT ON sections
WHEN NEW.presentation IS NULL
BEGIN
  SELECT RAISE(ABORT, 'presentation_required');
END;

CREATE TRIGGER trg_sections_presentation_required_update
BEFORE UPDATE OF presentation ON sections
WHEN NEW.presentation IS NULL
BEGIN
  SELECT RAISE(ABORT, 'presentation_required');
END;

CREATE TRIGGER trg_section_types_presentation_required_insert
BEFORE INSERT ON section_types
WHEN NEW.default_presentation IS NULL
BEGIN
  SELECT RAISE(ABORT, 'presentation_required');
END;

CREATE TRIGGER trg_section_types_presentation_required_update
BEFORE UPDATE OF default_presentation ON section_types
WHEN NEW.default_presentation IS NULL
BEGIN
  SELECT RAISE(ABORT, 'presentation_required');
END;

-- ---------------------------------------------------------------------------
-- Tipo de sección inmutable (D-028)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_sections_type_immutable
BEFORE UPDATE OF section_type_id ON sections
WHEN NEW.section_type_id IS NOT OLD.section_type_id
BEGIN
  SELECT RAISE(ABORT, 'section_type_immutable');
END;

-- ---------------------------------------------------------------------------
-- Profundidad máxima: 3 niveles (raíz = nivel 1) (D-029)
-- ---------------------------------------------------------------------------
-- Nivel del padre + 1 + altura del subárbol que se mueve. Los recorridos están
-- acotados (n < 16) como defensa ante datos inconsistentes.
CREATE TRIGGER trg_sections_max_depth_insert
BEFORE INSERT ON sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'section_depth_exceeded')
  WHERE (
    WITH RECURSIVE ancestors (id, n) AS (
      SELECT NEW.parent_id, 1
      UNION ALL
      SELECT s.parent_id, a.n + 1 FROM sections AS s JOIN ancestors AS a ON s.id = a.id
      WHERE s.parent_id IS NOT NULL AND a.n < 16
    )
    SELECT max(n) FROM ancestors
  ) + 1 > 3;
END;

-- En un ciclo deja actuar a trg_sections_no_cycle (código section_cycle).
CREATE TRIGGER trg_sections_max_depth_update
BEFORE UPDATE OF parent_id ON sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'section_depth_exceeded')
  WHERE NOT EXISTS (
    WITH RECURSIVE ancestors (id, n) AS (
      SELECT NEW.parent_id, 1
      UNION ALL
      SELECT s.parent_id, a.n + 1 FROM sections AS s JOIN ancestors AS a ON s.id = a.id
      WHERE s.parent_id IS NOT NULL AND a.n < 16
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  )
  AND (
    WITH RECURSIVE ancestors (id, n) AS (
      SELECT NEW.parent_id, 1
      UNION ALL
      SELECT s.parent_id, a.n + 1 FROM sections AS s JOIN ancestors AS a ON s.id = a.id
      WHERE s.parent_id IS NOT NULL AND a.n < 16
    )
    SELECT max(n) FROM ancestors
  ) + 1 + (
    WITH RECURSIVE descendants (id, h) AS (
      SELECT NEW.id, 0
      UNION ALL
      SELECT s.id, d.h + 1 FROM sections AS s JOIN descendants AS d ON s.parent_id = d.id
      WHERE d.h < 16
    )
    SELECT max(h) FROM descendants
  ) > 3;
END;

-- ---------------------------------------------------------------------------
-- Estados y jerarquía (D-030)
-- ---------------------------------------------------------------------------
-- No se cuelga una sección de un padre archivado, ni se reactiva bajo él.
CREATE TRIGGER trg_sections_parent_archived_insert
BEFORE INSERT ON sections
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT status FROM sections WHERE id = NEW.parent_id) = 'archived'
 AND NEW.status IS NOT 'archived'
BEGIN
  SELECT RAISE(ABORT, 'parent_archived');
END;

CREATE TRIGGER trg_sections_parent_archived_update
BEFORE UPDATE OF parent_id, status ON sections
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT status FROM sections WHERE id = NEW.parent_id) = 'archived'
 AND NEW.status IS NOT 'archived'
BEGIN
  SELECT RAISE(ABORT, 'parent_archived');
END;

-- Una sección solo se archiva si todas sus subsecciones ya están archivadas.
CREATE TRIGGER trg_sections_archive_children
BEFORE UPDATE OF status ON sections
WHEN NEW.status = 'archived' AND OLD.status IS NOT 'archived'
BEGIN
  SELECT RAISE(ABORT, 'section_has_active_children')
  WHERE EXISTS (SELECT 1 FROM sections WHERE parent_id = NEW.id AND status <> 'archived');
END;

-- Las secciones del sistema pueden desactivarse, pero no archivarse.
CREATE TRIGGER trg_sections_system_not_archivable
BEFORE UPDATE OF status ON sections
WHEN NEW.status = 'archived' AND OLD.is_system = 1
BEGIN
  SELECT RAISE(ABORT, 'system_section_protected');
END;
