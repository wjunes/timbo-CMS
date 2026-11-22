-- Migración 008 (Bloque 10): integridad de la auditoría y purga de archivos.
--
-- 1. audit_chain: una huella SHA-256 por entrada de auditoría, encadenada con la
--    anterior (D-059). La calcula la aplicación al registrar (SQLite no tiene
--    SHA-256 en SQL); la base garantiza que se añaden en orden, sin huecos, y
--    que no se modifican ni se borran. audit_logs no cambia.
-- 2. media_purges: registro de los archivos purgados físicamente (D-061). Solo
--    se purga un archivo eliminado que no usa ninguna versión; la fila de media
--    se conserva para que la auditoría y el historial sigan teniendo sentido.

CREATE TABLE audit_chain (
  audit_id INTEGER PRIMARY KEY REFERENCES audit_logs (id),
  hash     TEXT    NOT NULL CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

-- Solo se encadena la primera entrada todavía sin huella: orden estricto, sin huecos.
CREATE TRIGGER trg_audit_chain_order
BEFORE INSERT ON audit_chain
WHEN NEW.audit_id IS NOT (
  SELECT min(id) FROM audit_logs
  WHERE id > coalesce((SELECT max(audit_id) FROM audit_chain), 0))
BEGIN
  SELECT RAISE(ABORT, 'audit_chain_order');
END;

CREATE TRIGGER trg_audit_chain_no_update
BEFORE UPDATE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_log_immutable');
END;

CREATE TRIGGER trg_audit_chain_no_delete
BEFORE DELETE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_log_immutable');
END;

CREATE TABLE media_purges (
  media_id  INTEGER PRIMARY KEY REFERENCES media (id),
  purged_by INTEGER NOT NULL REFERENCES users (id),
  purged_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Solo archivos eliminados (lógicamente) y que no usa ninguna versión de ningún contenido.
CREATE TRIGGER trg_media_purges_allowed
BEFORE INSERT ON media_purges
WHEN (SELECT status FROM media WHERE id = NEW.media_id) IS NOT 'deleted'
  OR EXISTS (SELECT 1 FROM content_media WHERE media_id = NEW.media_id)
BEGIN
  SELECT RAISE(ABORT, 'media_not_purgeable');
END;

CREATE TRIGGER trg_media_purges_no_update
BEFORE UPDATE ON media_purges
BEGIN
  SELECT RAISE(ABORT, 'media_purge_immutable');
END;

CREATE TRIGGER trg_media_purges_no_delete
BEFORE DELETE ON media_purges
BEGIN
  SELECT RAISE(ABORT, 'media_purge_immutable');
END;

-- Un archivo purgado ya no existe: ninguna versión puede volver a usarlo.
CREATE TRIGGER trg_content_media_not_purged
BEFORE INSERT ON content_media
WHEN EXISTS (SELECT 1 FROM media_purges WHERE media_id = NEW.media_id)
BEGIN
  SELECT RAISE(ABORT, 'media_not_available');
END;
