-- 001 · Esquema inicial de CMS-MULTISECCION
--
-- Convenciones:
--   * Tablas STRICT (tipos verificados). Booleanos como INTEGER 0/1.
--   * Fechas en TEXT ISO-8601 UTC con milisegundos (strftime '%Y-%m-%dT%H:%M:%fZ').
--   * Los triggers con RAISE(ABORT, '<codigo>') protegen invariantes que no
--     pueden expresarse con CHECK/UNIQUE/FK. El código es estable para la app.
--   * Este archivo NO debe modificarse una vez aplicado: los cambios van en 002+.
--   * Documentación del modelo: docs/DATABASE.md

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL COLLATE NOCASE UNIQUE
                CHECK (length(username) BETWEEN 3 AND 64 AND username NOT GLOB '*[^A-Za-z0-9._-]*'),
  email         TEXT    NOT NULL COLLATE NOCASE UNIQUE
                CHECK (length(email) BETWEEN 3 AND 254 AND email GLOB '?*@?*' AND email NOT GLOB '*[ ]*'),
  display_name  TEXT    NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  -- Solo hashes Argon2id en formato PHC; nunca contraseñas en claro.
  password_hash TEXT    NOT NULL CHECK (password_hash GLOB '$argon2id$*' AND length(password_hash) <= 512),
  role          TEXT    NOT NULL CHECK (role IN ('general_admin', 'section_admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  created_by    INTEGER REFERENCES users (id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- El administrador general no puede suspenderse ni desactivarse (evita el bloqueo total del sistema).
  CHECK (role <> 'general_admin' OR status = 'active')
) STRICT;

-- Impide estructuralmente más de un general_admin.
CREATE UNIQUE INDEX ux_users_single_general_admin ON users (role) WHERE role = 'general_admin';

-- El rol es inmutable: impide escalar privilegios o degradar al administrador general.
CREATE TRIGGER trg_users_role_immutable
BEFORE UPDATE OF role ON users
WHEN NEW.role IS NOT OLD.role
BEGIN
  SELECT RAISE(ABORT, 'user_role_immutable');
END;

-- Los usuarios no se eliminan (se desactivan): preserva auditoría y autoría.
CREATE TRIGGER trg_users_no_delete
BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'user_delete_forbidden');
END;

-- ---------------------------------------------------------------------------
-- Tipos de sección (catálogo del sistema, solo se modifica mediante migraciones)
-- ---------------------------------------------------------------------------
CREATE TABLE section_types (
  id                   INTEGER PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 40 AND code NOT GLOB '*[^a-z0-9_]*'),
  name                 TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description          TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  default_presentation TEXT NOT NULL CHECK (default_presentation IN ('page', 'list', 'grid', 'accordion', 'document_list')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- ---------------------------------------------------------------------------
-- Secciones (jerárquicas)
-- ---------------------------------------------------------------------------
CREATE TABLE sections (
  id              INTEGER PRIMARY KEY,
  section_type_id INTEGER NOT NULL REFERENCES section_types (id),
  parent_id       INTEGER REFERENCES sections (id),
  slug            TEXT    NOT NULL CHECK (
                    length(slug) BETWEEN 1 AND 100
                    AND slug NOT GLOB '*[^a-z0-9-]*'
                    AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'),
  name            TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description     TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  workflow        TEXT    NOT NULL DEFAULT 'approval' CHECK (workflow IN ('direct', 'approval')),
  presentation    TEXT    NOT NULL CHECK (presentation IN ('page', 'list', 'grid', 'accordion', 'document_list')),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_system       INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_by      INTEGER REFERENCES users (id),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_id IS NULL OR parent_id <> id),
  -- Prefijos reservados para rutas del sistema en el primer nivel de URL.
  CHECK (parent_id IS NOT NULL OR slug NOT IN ('admin', 'api', 'assets', 'media', 'static', 'health', 'login', 'logout'))
) STRICT;

-- Slug único entre hermanos. Dos índices porque UNIQUE trata cada NULL como distinto.
CREATE UNIQUE INDEX ux_sections_root_slug  ON sections (slug) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX ux_sections_child_slug ON sections (parent_id, slug) WHERE parent_id IS NOT NULL;
CREATE INDEX ix_sections_type   ON sections (section_type_id);
CREATE INDEX ix_sections_parent ON sections (parent_id, sort_order);

-- Impide ciclos en la jerarquía (una sección no puede ser su propio ancestro).
CREATE TRIGGER trg_sections_no_cycle
BEFORE UPDATE OF parent_id ON sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'section_cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors (id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT s.parent_id FROM sections AS s JOIN ancestors AS a ON s.id = a.id WHERE s.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;

-- Las secciones predefinidas no pueden eliminarse ni perder su condición de sistema.
CREATE TRIGGER trg_sections_system_no_delete
BEFORE DELETE ON sections
WHEN OLD.is_system = 1
BEGIN
  SELECT RAISE(ABORT, 'system_section_protected');
END;

CREATE TRIGGER trg_sections_system_flag_immutable
BEFORE UPDATE OF is_system ON sections
WHEN NEW.is_system IS NOT OLD.is_system
BEGIN
  SELECT RAISE(ABORT, 'system_section_protected');
END;

-- ---------------------------------------------------------------------------
-- Asignación de secciones a administradores de sección
-- ---------------------------------------------------------------------------
CREATE TABLE user_sections (
  user_id     INTEGER NOT NULL REFERENCES users (id),
  section_id  INTEGER NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  assigned_by INTEGER NOT NULL REFERENCES users (id),
  assigned_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, section_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_user_sections_section ON user_sections (section_id);

-- Solo se asignan secciones a section_admin, y solo el general_admin asigna.
CREATE TRIGGER trg_user_sections_insert_roles
BEFORE INSERT ON user_sections
BEGIN
  SELECT RAISE(ABORT, 'assignee_must_be_section_admin')
  WHERE (SELECT role FROM users WHERE id = NEW.user_id) IS NOT 'section_admin';
  SELECT RAISE(ABORT, 'assigner_must_be_general_admin')
  WHERE (SELECT role FROM users WHERE id = NEW.assigned_by) IS NOT 'general_admin';
END;

-- Las asignaciones no se editan: se revocan (DELETE) y se vuelven a conceder (INSERT).
CREATE TRIGGER trg_user_sections_no_update
BEFORE UPDATE ON user_sections
BEGIN
  SELECT RAISE(ABORT, 'assignment_immutable');
END;

-- ---------------------------------------------------------------------------
-- Permisos (catálogo; los códigos se definen en el Bloque 04)
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 3 AND 64 AND code NOT GLOB '*[^a-z0-9_.]*'),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Un permiso solo puede existir sobre una sección asignada (FK compuesta);
-- al revocar la asignación se eliminan sus permisos.
CREATE TABLE user_section_permissions (
  user_id       INTEGER NOT NULL,
  section_id    INTEGER NOT NULL,
  permission_id INTEGER NOT NULL REFERENCES permissions (id),
  granted_by    INTEGER NOT NULL REFERENCES users (id),
  granted_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, section_id, permission_id),
  FOREIGN KEY (user_id, section_id) REFERENCES user_sections (user_id, section_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_usp_permission ON user_section_permissions (permission_id);

CREATE TRIGGER trg_usp_insert_granter
BEFORE INSERT ON user_section_permissions
BEGIN
  SELECT RAISE(ABORT, 'granter_must_be_general_admin')
  WHERE (SELECT role FROM users WHERE id = NEW.granted_by) IS NOT 'general_admin';
END;

CREATE TRIGGER trg_usp_no_update
BEFORE UPDATE ON user_section_permissions
BEGIN
  SELECT RAISE(ABORT, 'permission_grant_immutable');
END;

-- ---------------------------------------------------------------------------
-- Contenidos (estado general) y versiones (estado editorial)
-- ---------------------------------------------------------------------------
CREATE TABLE contents (
  id                   INTEGER PRIMARY KEY,
  section_id           INTEGER NOT NULL REFERENCES sections (id),
  slug                 TEXT    NOT NULL CHECK (
                         length(slug) BETWEEN 1 AND 150
                         AND slug NOT GLOB '*[^a-z0-9-]*'
                         AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'),
  status               TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived', 'deleted')),
  published_version_id INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER NOT NULL REFERENCES users (id),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_by           INTEGER REFERENCES users (id),
  deleted_at           TEXT,
  -- La versión publicada debe pertenecer a este mismo contenido.
  FOREIGN KEY (id, published_version_id) REFERENCES content_versions (content_id, id),
  -- Publicado <=> tiene versión publicada.
  CHECK ((status = 'published') = (published_version_id IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((deleted_by IS NULL) = (deleted_at IS NULL))
) STRICT;

-- Slug único por sección entre contenidos no eliminados.
CREATE UNIQUE INDEX ux_contents_section_slug ON contents (section_id, slug) WHERE status <> 'deleted';
CREATE INDEX ix_contents_section_status ON contents (section_id, status, sort_order);
CREATE INDEX ix_contents_published_version ON contents (published_version_id) WHERE published_version_id IS NOT NULL;

CREATE TABLE content_versions (
  id                  INTEGER PRIMARY KEY,
  content_id          INTEGER NOT NULL REFERENCES contents (id),
  version_number      INTEGER NOT NULL CHECK (version_number >= 1),
  based_on_version_id INTEGER REFERENCES content_versions (id),
  status              TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN (
                        'draft', 'pending_review', 'changes_requested', 'approved', 'published', 'archived')),
  title               TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  summary             TEXT    NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
  body_format         TEXT    NOT NULL DEFAULT 'tiptap_json' CHECK (body_format IN ('tiptap_json')),
  body                TEXT    NOT NULL DEFAULT '{"type":"doc","content":[]}'
                      CHECK (json_valid(body) AND json_type(body) = 'object' AND length(body) <= 2097152),
  -- Control de concurrencia optimista sobre borradores (UPDATE ... WHERE revision = ?).
  revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by          INTEGER NOT NULL REFERENCES users (id),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by          INTEGER REFERENCES users (id),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_by        INTEGER REFERENCES users (id),
  submitted_at        TEXT,
  approved_by         INTEGER REFERENCES users (id),
  approved_at         TEXT,
  published_by        INTEGER REFERENCES users (id),
  published_at        TEXT,
  UNIQUE (content_id, version_number),
  UNIQUE (content_id, id),
  CHECK (based_on_version_id IS NULL OR based_on_version_id <> id),
  CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)),
  CHECK ((approved_by  IS NULL) = (approved_at  IS NULL)),
  CHECK ((published_by IS NULL) = (published_at IS NULL)),
  CHECK (status NOT IN ('pending_review', 'changes_requested') OR submitted_at IS NOT NULL),
  CHECK (status <> 'approved'  OR approved_at  IS NOT NULL),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
) STRICT;

-- Como máximo una versión publicada y una versión "en curso" por contenido.
CREATE UNIQUE INDEX ux_versions_one_published ON content_versions (content_id) WHERE status = 'published';
CREATE UNIQUE INDEX ux_versions_one_open      ON content_versions (content_id) WHERE status IN ('draft', 'pending_review', 'approved');
CREATE INDEX ix_versions_status   ON content_versions (status);
CREATE INDEX ix_versions_based_on ON content_versions (based_on_version_id) WHERE based_on_version_id IS NOT NULL;

-- Identidad de la versión siempre inmutable.
CREATE TRIGGER trg_versions_identity_immutable
BEFORE UPDATE OF content_id, version_number, based_on_version_id, created_by, created_at ON content_versions
WHEN NEW.content_id IS NOT OLD.content_id
  OR NEW.version_number IS NOT OLD.version_number
  OR NEW.based_on_version_id IS NOT OLD.based_on_version_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable');
END;

-- Una versión que salió de borrador es inmutable en su contenido y no vuelve a borrador.
CREATE TRIGGER trg_versions_content_immutable
BEFORE UPDATE ON content_versions
WHEN OLD.status <> 'draft' AND (
     NEW.status = 'draft'
  OR NEW.title IS NOT OLD.title
  OR NEW.summary IS NOT OLD.summary
  OR NEW.body_format IS NOT OLD.body_format
  OR NEW.body IS NOT OLD.body
  OR NEW.revision IS NOT OLD.revision)
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable');
END;

-- Solo pueden eliminarse borradores (descartar un borrador).
CREATE TRIGGER trg_versions_delete_only_draft
BEFORE DELETE ON content_versions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable');
END;

-- El puntero de publicación solo puede apuntar a una versión en estado 'published'.
CREATE TRIGGER trg_contents_published_version_insert
BEFORE INSERT ON contents
WHEN NEW.published_version_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'published_version_not_published')
  WHERE (SELECT status FROM content_versions WHERE id = NEW.published_version_id) IS NOT 'published';
END;

CREATE TRIGGER trg_contents_published_version_update
BEFORE UPDATE OF published_version_id ON contents
WHEN NEW.published_version_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'published_version_not_published')
  WHERE (SELECT status FROM content_versions WHERE id = NEW.published_version_id) IS NOT 'published';
END;

-- Una versión referenciada como publicada no puede cambiar de estado sin retirar antes el puntero.
CREATE TRIGGER trg_versions_published_pointer
BEFORE UPDATE OF status ON content_versions
WHEN OLD.status = 'published' AND NEW.status <> 'published'
BEGIN
  SELECT RAISE(ABORT, 'version_is_published')
  WHERE EXISTS (SELECT 1 FROM contents WHERE published_version_id = OLD.id);
END;

-- ---------------------------------------------------------------------------
-- Revisiones de publicación (ligadas a una versión concreta; solo inserción)
-- ---------------------------------------------------------------------------
CREATE TABLE publication_reviews (
  id                 INTEGER PRIMARY KEY,
  content_version_id INTEGER NOT NULL REFERENCES content_versions (id),
  reviewer_id        INTEGER NOT NULL REFERENCES users (id),
  decision           TEXT    NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  comment            TEXT    NOT NULL DEFAULT '' CHECK (length(comment) <= 5000),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_reviews_version ON publication_reviews (content_version_id, created_at);

CREATE TRIGGER trg_reviews_insert_rules
BEFORE INSERT ON publication_reviews
BEGIN
  SELECT RAISE(ABORT, 'reviewer_must_be_general_admin')
  WHERE (SELECT role FROM users WHERE id = NEW.reviewer_id) IS NOT 'general_admin';
  SELECT RAISE(ABORT, 'version_not_pending_review')
  WHERE (SELECT status FROM content_versions WHERE id = NEW.content_version_id) IS NOT 'pending_review';
END;

CREATE TRIGGER trg_reviews_no_update
BEFORE UPDATE ON publication_reviews
BEGIN
  SELECT RAISE(ABORT, 'review_immutable');
END;

CREATE TRIGGER trg_reviews_no_delete
BEFORE DELETE ON publication_reviews
BEGIN
  SELECT RAISE(ABORT, 'review_immutable');
END;

-- ---------------------------------------------------------------------------
-- Multimedia (metadatos; los archivos viven en STORAGE_DIR, nunca como BLOB)
-- ---------------------------------------------------------------------------
CREATE TABLE media (
  id            INTEGER PRIMARY KEY,
  -- Nombre aleatorio en disco: sin rutas, sin separadores, sin nombres ocultos.
  storage_key   TEXT    NOT NULL UNIQUE CHECK (
                  length(storage_key) BETWEEN 16 AND 128
                  AND storage_key NOT GLOB '*[^a-z0-9.]*'
                  AND storage_key NOT GLOB '.*' AND storage_key NOT GLOB '*..*'),
  original_name TEXT    NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type     TEXT    NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 100 AND mime_type GLOB '?*/?*'
                                        AND mime_type NOT GLOB '*[^a-z0-9.+/-]*'),
  extension     TEXT    NOT NULL CHECK (length(extension) BETWEEN 1 AND 10 AND extension NOT GLOB '*[^a-z0-9]*'),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256        TEXT    NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  alt_text      TEXT    NOT NULL DEFAULT '' CHECK (length(alt_text) <= 500),
  visibility    TEXT    NOT NULL CHECK (visibility IN ('public', 'private')),
  section_id    INTEGER REFERENCES sections (id),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  uploaded_by   INTEGER NOT NULL REFERENCES users (id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_by    INTEGER REFERENCES users (id),
  deleted_at    TEXT,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((deleted_by IS NULL) = (deleted_at IS NULL))
) STRICT;

CREATE INDEX ix_media_section ON media (section_id, status);
CREATE INDEX ix_media_sha256  ON media (sha256);

-- Relación versión ↔ archivo. Un archivo referenciado no puede eliminarse físicamente.
CREATE TABLE content_media (
  content_version_id INTEGER NOT NULL REFERENCES content_versions (id) ON DELETE CASCADE,
  media_id           INTEGER NOT NULL REFERENCES media (id) ON DELETE RESTRICT,
  PRIMARY KEY (content_version_id, media_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_content_media_media ON content_media (media_id);

-- Las referencias de una versión fuera de borrador también son inmutables.
CREATE TRIGGER trg_content_media_insert_draft_only
BEFORE INSERT ON content_media
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable')
  WHERE (SELECT status FROM content_versions WHERE id = NEW.content_version_id) IS NOT 'draft';
END;

-- EXISTS (y no "IS NOT 'draft'"): en el borrado en cascada de un borrador la versión ya no existe.
CREATE TRIGGER trg_content_media_delete_draft_only
BEFORE DELETE ON content_media
WHEN EXISTS (SELECT 1 FROM content_versions WHERE id = OLD.content_version_id AND status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable');
END;

CREATE TRIGGER trg_content_media_no_update
BEFORE UPDATE ON content_media
BEGIN
  SELECT RAISE(ABORT, 'content_version_immutable');
END;

-- ---------------------------------------------------------------------------
-- Sesiones (solo se almacena el hash SHA-256 del token, 32 bytes)
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id             INTEGER PRIMARY KEY,
  token_hash     BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at     TEXT    NOT NULL,
  revoked_at     TEXT,
  revoked_reason TEXT    CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 64),
  ip_address     TEXT    CHECK (ip_address IS NULL OR length(ip_address) <= 45),
  user_agent     TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  CHECK (expires_at > created_at),
  CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL)
) STRICT;

CREATE INDEX ix_sessions_user    ON sessions (user_id, revoked_at);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Auditoría (solo inserción). Sin FK a entidades para sobrevivir a su eliminación.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY,
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_user_id INTEGER REFERENCES users (id),
  action        TEXT    NOT NULL CHECK (length(action) BETWEEN 3 AND 64 AND action NOT GLOB '*[^a-z0-9_.]*'),
  outcome       TEXT    NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  entity_type   TEXT    CHECK (entity_type IS NULL OR (length(entity_type) BETWEEN 1 AND 40 AND entity_type NOT GLOB '*[^a-z_]*')),
  entity_id     INTEGER,
  section_id    INTEGER,
  ip_address    TEXT    CHECK (ip_address IS NULL OR length(ip_address) <= 45),
  details       TEXT    NOT NULL DEFAULT '{}'
                CHECK (json_valid(details) AND json_type(details) = 'object' AND length(details) <= 16384),
  CHECK (entity_id IS NULL OR entity_type IS NOT NULL)
) STRICT;

CREATE INDEX ix_audit_occurred ON audit_logs (occurred_at);
CREATE INDEX ix_audit_actor    ON audit_logs (actor_user_id, occurred_at);
CREATE INDEX ix_audit_entity   ON audit_logs (entity_type, entity_id, occurred_at);
CREATE INDEX ix_audit_action   ON audit_logs (action, occurred_at);

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_log_immutable');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_log_immutable');
END;

-- ---------------------------------------------------------------------------
-- Configuración (valores JSON)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9_.]*'),
  value      TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 65536),
  updated_by INTEGER REFERENCES users (id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Datos del sistema: tipos de sección y secciones predefinidas
-- ---------------------------------------------------------------------------
INSERT INTO section_types (id, code, name, description, default_presentation) VALUES
  (1, 'institutional', 'Institucional',             'Páginas institucionales de contenido estable.', 'page'),
  (2, 'news',          'Noticias',                  'Noticias con fecha de publicación.',            'list'),
  (3, 'articles',      'Artículos y publicaciones', 'Artículos, informes y publicaciones.',          'list'),
  (4, 'documents',     'Biblioteca documental',     'Repositorio de documentos descargables.',       'document_list'),
  (5, 'faq',           'Preguntas frecuentes',      'Preguntas y respuestas.',                       'accordion');

INSERT INTO sections (id, section_type_id, slug, name, presentation, sort_order, is_system) VALUES
  (1, 1, 'institucional',        'Institucional',             'page',          10, 1),
  (2, 2, 'noticias',             'Noticias',                  'list',          20, 1),
  (3, 3, 'articulos',            'Artículos y publicaciones', 'list',          30, 1),
  (4, 4, 'biblioteca',           'Biblioteca documental',     'document_list', 40, 1),
  (5, 5, 'preguntas-frecuentes', 'Preguntas frecuentes',      'accordion',     50, 1);
