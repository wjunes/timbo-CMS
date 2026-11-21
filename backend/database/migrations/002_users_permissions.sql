-- 002 · Usuarios: contraseña temporal y estados; catálogo de permisos (Bloque 04)
--
-- Este archivo NO debe modificarse una vez aplicado: los cambios van en 003+.

-- Contraseña temporal: el usuario debe cambiarla antes de operar (D-023).
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

-- 'disabled' es un estado final: la cuenta queda cerrada definitivamente (D-024).
CREATE TRIGGER trg_users_disabled_terminal
BEFORE UPDATE OF status ON users
WHEN OLD.status = 'disabled' AND NEW.status IS NOT 'disabled'
BEGIN
  SELECT RAISE(ABORT, 'user_disabled_terminal');
END;

-- El nombre de usuario es inmutable (incluidos cambios de mayúsculas: comparación binaria).
CREATE TRIGGER trg_users_username_immutable
BEFORE UPDATE OF username ON users
WHEN NEW.username COLLATE BINARY IS NOT OLD.username COLLATE BINARY
BEGIN
  SELECT RAISE(ABORT, 'username_immutable');
END;

-- Catálogo de permisos por sección (D-022). El general_admin los tiene todos por su rol.
-- Añadir o retirar un permiso requiere una migración y el código que lo exige.
INSERT INTO permissions (id, code, description) VALUES
  (1, 'content.create',    'Crear contenidos y borradores en la sección'),
  (2, 'content.edit',      'Editar borradores de cualquier contenido de la sección'),
  (3, 'content.submit',    'Enviar versiones a revisión (secciones con flujo approval)'),
  (4, 'content.publish',   'Publicar directamente (solo secciones con flujo direct)'),
  (5, 'content.unpublish', 'Despublicar contenidos'),
  (6, 'content.archive',   'Archivar y restaurar contenidos'),
  (7, 'content.delete',    'Eliminar contenidos (borrado lógico)'),
  (8, 'media.upload',      'Subir archivos multimedia y documentos'),
  (9, 'media.delete',      'Eliminar archivos que no estén en uso');
