# Base de datos

SQLite 3.53 mediante `node:sqlite` (`DatabaseSync`, síncrono). Esquema definido en
[`backend/database/migrations/`](../backend/database/migrations/).

## Componentes

| Archivo | Responsabilidad |
| --- | --- |
| `backend/database/connection.js` | `openDatabase(path, { create })` / `closeDatabase(db)`. Única forma de abrir conexiones. |
| `backend/database/transaction.js` | `withTransaction(db, fn)`: `BEGIN IMMEDIATE`; `SAVEPOINT` si se anida; revierte ante cualquier excepción. |
| `backend/database/migrator.js` | `loadMigrations`, `getMigrationStatus`, `migrate`, `assertSchemaCurrent`. |
| `scripts/db.js` | CLI: `npm run db:migrate`, `npm run db:status`. |

## Configuración de la conexión

| PRAGMA / opción | Valor | Motivo |
| --- | --- | --- |
| `journal_mode` | `WAL` (verificado al abrir) | Lectores concurrentes con un escritor. |
| `synchronous` | `NORMAL` | Seguro frente a corrupción en WAL. |
| `foreign_keys` | `ON` (verificado) | Integridad referencial. |
| `busy_timeout` | 5000 ms | Esperar al escritor en lugar de fallar. |
| `trusted_schema` | `OFF` | El esquema no puede invocar funciones con efectos. |
| Modo defensivo | activado | Impide corromper el esquema (`writable_schema`). |
| Extensiones | deshabilitadas | Sin carga de código nativo. |

**Requisito de entorno:** el archivo debe estar en un disco local. WAL no funciona sobre
unidades de red, y las carpetas sincronizadas (OneDrive, Dropbox…) pueden corromperlo.

## Migraciones

- Archivos `NNN_nombre.sql`, numerados de forma contigua desde `001`.
- **Solo avanzan.** No hay migraciones de vuelta atrás: se revierte restaurando un backup (Bloque 10).
- **Una migración aplicada no se edita.** Su SHA-256 queda en `schema_migrations`; si el archivo cambia, el migrador y el servidor se detienen. Los cambios van en una migración nueva.
- Cada migración y su registro se aplican en una sola transacción, seguida de `foreign_key_check`. Al terminar todas se ejecuta `integrity_check`.
- Las migraciones no pueden contener `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` propios.
- **El servidor no migra al arrancar:** si hay migraciones pendientes o inconsistentes, no arranca. Hay que ejecutar `npm run db:migrate` explícitamente.

## Modelo (migraciones 001–002)

Todas las tablas son `STRICT`. Las fechas se guardan como TEXT ISO-8601 UTC con milisegundos. Los booleanos son `INTEGER` 0/1.

```text
section_types ──< sections ──< sections (parent_id, jerarquía)
                     │
users ──< user_sections >── sections
            │
            └──< user_section_permissions >── permissions

sections ──< contents ──< content_versions ──< publication_reviews
                │  └── published_version_id ──┘      │
                                                       └──< content_media >── media
users ──< sessions
audit_logs (sin FK a entidades, salvo actor)   settings (clave → JSON)
```

### Invariantes garantizadas por la base de datos

Cada una tiene su prueba en `tests/integration/schema.test.js`. Los triggers fallan con `RAISE(ABORT, '<código>')`; ese código es estable y la aplicación puede usarlo.

| Tabla | Invariante | Mecanismo / código |
| --- | --- | --- |
| `users` | Un único `general_admin` | índice único parcial `ux_users_single_general_admin` |
| `users` | El rol es inmutable (sin escalada ni degradación) | `user_role_immutable` |
| `users` | El `general_admin` siempre está `active` | `CHECK` |
| `users` | Los usuarios no se eliminan (se desactivan) | `user_delete_forbidden` |
| `users` | Solo hashes Argon2id en formato PHC | `CHECK (password_hash GLOB '$argon2id$*')` |
| `users` | `username` / `email` únicos sin distinguir mayúsculas | `COLLATE NOCASE UNIQUE` |
| `sections` | Slug `[a-z0-9-]`, sin guiones al inicio o al final ni dobles | `CHECK` |
| `sections` | Slug único entre hermanas, también en la raíz | dos índices únicos parciales |
| `sections` | Prefijos reservados en el primer nivel (`admin`, `api`, `assets`, `media`, `static`, `health`, `login`, `logout`) | `CHECK` |
| `sections` | Sin ciclos en la jerarquía | `section_cycle` (CTE recursiva) |
| `sections` | Las secciones del sistema no se eliminan ni pierden su marca | `system_section_protected` |
| `sections` | `workflow` ∈ {`direct`, `approval`}, por defecto `approval`; `presentation` de una lista fija | `CHECK` |
| `user_sections` | Solo se asignan a un `section_admin`, y solo las asigna el `general_admin` | `assignee_must_be_section_admin`, `assigner_must_be_general_admin` |
| `user_sections` | No se editan: se revocan y se vuelven a conceder | `assignment_immutable` |
| `user_section_permissions` | Solo hay permisos sobre secciones asignadas; al revocar la asignación se eliminan | FK compuesta → `user_sections` `ON DELETE CASCADE` |
| `user_section_permissions` | Solo los concede el `general_admin`; no se editan | `granter_must_be_general_admin`, `permission_grant_immutable` |
| `contents` | `published` ⇔ tiene `published_version_id` | `CHECK` |
| `contents` | La versión publicada pertenece al mismo contenido | FK compuesta `(id, published_version_id)` |
| `contents` | El puntero solo apunta a una versión `published` | `published_version_not_published` |
| `contents` | Slug único por sección entre contenidos no eliminados | índice único parcial |
| `content_versions` | Como máximo 1 versión `published` y 1 «en curso» (`draft`/`pending_review`/`approved`) por contenido | índices únicos parciales |
| `content_versions` | Fuera de `draft`: título, resumen, cuerpo y revisión inmutables; nunca vuelve a `draft`; no se elimina | `content_version_immutable` |
| `content_versions` | Identidad (contenido, número, origen, autor, fecha) inmutable | `content_version_immutable` |
| `content_versions` | Los estados exigen su autoría: enviado → `submitted_*`, aprobado → `approved_*`, publicado → `published_*` | `CHECK` |
| `content_versions` | `body` es un objeto JSON válido, ≤ 2 MiB | `CHECK (json_valid …)` |
| `content_versions` | La versión publicada no cambia de estado mientras el contenido apunte a ella | `version_is_published` |
| `publication_reviews` | Ligadas a una versión `pending_review`; solo las hace el `general_admin`; solo inserción | `version_not_pending_review`, `reviewer_must_be_general_admin`, `review_immutable` |
| `media` | `storage_key` aleatoria, sin rutas, separadores ni nombres ocultos; SHA-256 hexadecimal | `CHECK` |
| `content_media` | Un archivo referenciado no puede borrarse físicamente | FK `ON DELETE RESTRICT` |
| `content_media` | Las referencias de una versión fuera de `draft` son inmutables | `content_version_immutable` |
| `sessions` | Solo se guarda el hash del token (BLOB de 32 bytes, único); caduca después de crearse | `CHECK`, `UNIQUE` |
| `audit_logs` | Solo inserción; `details` es un objeto JSON ≤ 16 KiB | `audit_log_immutable`, `CHECK` |
| `settings` | Clave `[a-z0-9_.]`, valor JSON válido | `CHECK` |

### Migración 002 (Bloque 04)

| Cambio | Mecanismo / código |
| --- | --- |
| `users.must_change_password` (0/1, por defecto 0) y `users.password_changed_at` | `ALTER TABLE … ADD COLUMN` con `CHECK` |
| `disabled` es un estado final | `user_disabled_terminal` |
| `username` inmutable (también en mayúsculas) | `username_immutable` |
| Catálogo de 9 permisos | datos del sistema (ver [USERS.md](USERS.md)) |

### Estados

- **Contenido** (`contents.status`) — `draft` · `published` · `archived` · `deleted`. Indica si el contenido es visible.
- **Versión** (`content_versions.status`) — `draft` · `pending_review` · `changes_requested` · `approved` · `published` · `archived`. Indica el estado editorial.
- `changes_requested` es final para esa versión: el autor crea una nueva versión (`based_on_version_id`) a partir de ella. Así se respeta la inmutabilidad de lo que ya se envió a revisión.
- Al reemplazar la versión publicada, la anterior pasa a `archived` y queda en el historial.
- Las transiciones válidas entre estados (qué puede pasar a qué) se validan en el Bloque 07. La base de datos solo garantiza las invariantes de la tabla anterior.

### Reemplazar la versión publicada (una sola transacción)

```sql
UPDATE contents SET status = 'draft', published_version_id = NULL WHERE id = :c;   -- 1. retirar puntero
UPDATE content_versions SET status = 'archived' WHERE id = :v_old;                  -- 2. archivar anterior
UPDATE content_versions SET status = 'published', published_by = :u, published_at = :t WHERE id = :v_new;
UPDATE contents SET status = 'published', published_version_id = :v_new WHERE id = :c;
```

Dentro de `withTransaction`, nadie llega a ver los estados intermedios.

### Datos del sistema

La migración 001 carga:

- Los 5 tipos de sección: `institutional`, `news`, `articles`, `documents`, `faq`.
- Las 5 secciones predefinidas (`is_system = 1`, `workflow = 'approval'`): `institucional`, `noticias`, `articulos`, `biblioteca`, `preguntas-frecuentes`.

El catálogo de permisos lo carga la migración 002.

## Concurrencia

- WAL: muchos lectores y un único escritor. Toda escritura de varias sentencias usa `withTransaction` (`BEGIN IMMEDIATE`).
- Las ediciones simultáneas de un mismo borrador se controlan con `content_versions.revision`, de forma optimista: `UPDATE … SET revision = revision + 1 WHERE id = ? AND revision = ?`. La aplicación lo usa a partir del Bloque 06.
- `node:sqlite` es síncrono: las consultas bloquean el bucle de eventos. Es aceptable para el volumen previsto si se mantienen consultas indexadas y transacciones cortas.

## Limitaciones conocidas

- Los triggers protegen la base frente a errores de la aplicación, no frente a quien tenga acceso directo al archivo (podría ejecutar `DROP TRIGGER`). La protección del archivo depende del sistema operativo, y la verificación de integridad de la auditoría llega en el Bloque 10.
- `updated_at` lo actualiza la aplicación; no hay triggers para ello.
- La purga de auditoría por retención (Bloque 10) requerirá una migración que lo contemple.
