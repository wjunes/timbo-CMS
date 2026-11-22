-- Migración 007 (Bloque 09): reglas para el sitio público.
--
-- 1. Un contenido y una subsección de la misma sección no comparten slug: ambos
--    tendrían la misma URL (/seccion/slug). Resuelve D-039 en los dos sentidos.
-- 2. Redirecciones: al cambiar el slug de un contenido o el slug o el padre de
--    una sección se registra la ubicación antigua, y el sitio público responde
--    301 hacia la actual (D-055). Los triggers lo registran en la misma
--    transacción que el cambio, venga de donde venga.
-- 3. Ajustes del sitio con su valor por defecto (D-056).

-- ---------------------------------------------------------------------------
-- 1. Slugs de contenidos frente a subsecciones (D-039)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_contents_slug_vs_sections_insert
BEFORE INSERT ON contents
BEGIN
  SELECT RAISE(ABORT, 'slug_taken')
  WHERE EXISTS (SELECT 1 FROM sections WHERE parent_id = NEW.section_id AND slug = NEW.slug);
END;

CREATE TRIGGER trg_contents_slug_vs_sections_update
BEFORE UPDATE OF slug ON contents
WHEN NEW.slug IS NOT OLD.slug AND NEW.status <> 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'slug_taken')
  WHERE EXISTS (SELECT 1 FROM sections WHERE parent_id = NEW.section_id AND slug = NEW.slug);
END;

CREATE TRIGGER trg_sections_slug_vs_contents_insert
BEFORE INSERT ON sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'slug_taken')
  WHERE EXISTS (SELECT 1 FROM contents WHERE section_id = NEW.parent_id AND slug = NEW.slug AND status <> 'deleted');
END;

CREATE TRIGGER trg_sections_slug_vs_contents_update
BEFORE UPDATE OF slug, parent_id ON sections
WHEN NEW.parent_id IS NOT NULL AND (NEW.slug IS NOT OLD.slug OR NEW.parent_id IS NOT OLD.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'slug_taken')
  WHERE EXISTS (SELECT 1 FROM contents WHERE section_id = NEW.parent_id AND slug = NEW.slug AND status <> 'deleted');
END;

-- ---------------------------------------------------------------------------
-- 2. Redirecciones (D-055)
-- ---------------------------------------------------------------------------

-- Ubicación antigua de una sección: (padre anterior, slug anterior). La raíz es old_parent_id NULL.
CREATE TABLE section_redirects (
  id            INTEGER PRIMARY KEY,
  old_parent_id INTEGER REFERENCES sections (id) ON DELETE CASCADE,
  old_slug      TEXT    NOT NULL CHECK (length(old_slug) BETWEEN 1 AND 100 AND old_slug NOT GLOB '*[^a-z0-9-]*'),
  section_id    INTEGER NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX ux_section_redirects_location ON section_redirects (coalesce(old_parent_id, 0), old_slug);
CREATE INDEX ix_section_redirects_section ON section_redirects (section_id);

-- Slug anterior de un contenido dentro de su sección (un contenido no cambia de sección, D-034).
CREATE TABLE content_redirects (
  section_id INTEGER NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  old_slug   TEXT    NOT NULL CHECK (length(old_slug) BETWEEN 1 AND 150 AND old_slug NOT GLOB '*[^a-z0-9-]*'),
  content_id INTEGER NOT NULL REFERENCES contents (id),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (section_id, old_slug)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_content_redirects_content ON content_redirects (content_id);

-- Si la ubicación antigua ya tenía una redirección, la nueva la sustituye.
CREATE TRIGGER trg_sections_record_redirect
AFTER UPDATE OF slug, parent_id ON sections
WHEN NEW.slug IS NOT OLD.slug OR NEW.parent_id IS NOT OLD.parent_id
BEGIN
  DELETE FROM section_redirects WHERE coalesce(old_parent_id, 0) = coalesce(OLD.parent_id, 0) AND old_slug = OLD.slug;
  INSERT INTO section_redirects (old_parent_id, old_slug, section_id) VALUES (OLD.parent_id, OLD.slug, NEW.id);
END;

CREATE TRIGGER trg_contents_record_redirect
AFTER UPDATE OF slug ON contents
WHEN NEW.slug IS NOT OLD.slug
BEGIN
  INSERT OR REPLACE INTO content_redirects (section_id, old_slug, content_id) VALUES (OLD.section_id, OLD.slug, NEW.id);
END;

-- Las redirecciones solo se escriben desde los triggers anteriores.
CREATE TRIGGER trg_section_redirects_no_update
BEFORE UPDATE ON section_redirects
BEGIN
  SELECT RAISE(ABORT, 'redirect_immutable');
END;

CREATE TRIGGER trg_content_redirects_no_update
BEFORE UPDATE ON content_redirects
BEGIN
  SELECT RAISE(ABORT, 'redirect_immutable');
END;

-- ---------------------------------------------------------------------------
-- 3. Ajustes del sitio (D-056). Valores JSON; se editarán desde el panel en el Bloque 10.
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('site.name', '"CMS-MULTISECCIÓN"'),
  ('site.description', '"Sitio institucional"');
