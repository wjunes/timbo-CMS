# Hoja de ruta

Estados: `PENDING` · `IN_PROGRESS` · `VALIDATION` · `APPROVED` · `BLOCKED`

| Bloque | Descripción | Estado |
| --- | --- | --- |
| 01 | Inicialización del proyecto y configuración base | `APPROVED` |
| 02 | SQLite, esquema inicial y migraciones | `APPROVED` |
| 03 | Autenticación y gestión de sesiones | `APPROVED` |
| 04 | Usuarios, roles y permisos | `APPROVED` |
| 05 | Administración de secciones | `PENDING` |
| 06 | Motor de contenidos y versionado | `PENDING` |
| 07 | Flujos editoriales y aprobaciones | `PENDING` |
| 08 | Editor enriquecido y multimedia | `PENDING` |
| 09 | Sitio público y presentación adaptable | `PENDING` |
| 10 | Auditoría, copias de seguridad y restauración | `PENDING` |
| 11 | Pruebas integrales, seguridad y despliegue | `PENDING` |

Cada bloque requiere aprobación explícita antes de comenzar el siguiente.

## Bloque 01 — Detalle

**Alcance:** entorno verificado, `package.json` y scripts, estructura inicial, `.gitignore`, `.gitattributes`, `.env.example`, carga y validación de configuración, logger, servidor HTTP mínimo (`/health`), pruebas iniciales, documentación.

**Fuera de alcance:** base de datos, autenticación, usuarios, roles, permisos, secciones, contenidos, editor, multimedia, panel.

**Criterios de aceptación:**

- [x] Entorno verificado (Node 24.21.0, npm 12.0.2, `node:sqlite`, `node:crypto`).
- [x] Estructura inicial organizada.
- [x] Configuración preparada y validada.
- [x] Sin secretos versionados.
- [x] Scripts `start`, `dev`, `check`, `test`, `test:unit`, `test:integration` funcionando.
- [x] Servidor mínimo arranca y responde.
- [x] Pruebas iniciales pasan.
- [x] Documentación refleja el estado real.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-09).

## Bloque 02 — Detalle

**Alcance:** conexión SQLite endurecida (WAL, FK, defensivo); ayudante transaccional; migrador versionado con checksum; esquema inicial de 14 tablas con restricciones, índices y triggers de invariantes; datos del sistema (tipos de sección y secciones predefinidas); `DATABASE_PATH`/`STORAGE_DIR`; scripts `db:migrate`/`db:status`; el servidor exige esquema al día; pruebas; documentación ([DATABASE.md](DATABASE.md)).

**Fuera de alcance:** repositorios por módulo, lógica de autenticación y sesiones (03), catálogo de permisos y CRUD de usuarios (04), CRUD de secciones (05), lógica de contenidos y transiciones editoriales (06–07), archivos en `storage/` (08), backups (10).

**Criterios de aceptación:**

- [x] `node:sqlite` verificado en Node 24.21.0 (SQLite 3.53.4, `STRICT`, `json_valid`, CTE en triggers, `backup()`, modo defensivo).
- [x] Migraciones versionadas, transaccionales, idempotentes y protegidas por checksum.
- [x] Esquema con claves primarias y foráneas, `UNIQUE`, `CHECK`, índices y triggers; `foreign_key_check` e `integrity_check` limpios.
- [x] Más de un `general_admin` imposible a nivel de base de datos.
- [x] WAL activo y verificado; transacciones `BEGIN IMMEDIATE`; comportamiento concurrente probado.
- [x] Multimedia solo como metadatos (sin BLOB de archivos).
- [x] El servidor no arranca con migraciones pendientes o modificadas.
- [x] Todas las pruebas pasan (incluidas las del Bloque 01).
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-10).

## Bloque 03 — Detalle

**Alcance:** Argon2id nativo y política de contraseñas; sesiones opacas con hash, caducidad, inactividad y revocación; cookie segura; CSRF en dos capas; límite de intentos y protección contra enumeración; endpoints `/api/auth/login|logout|session`; enrutador mínimo y utilidades HTTP; auditoría de autenticación; CLI `admin:create`/`admin:reset-password`; configuración de sesiones y proxy; pruebas de seguridad; documentación ([AUTH.md](AUTH.md)).

**Fuera de alcance:** CRUD de usuarios, roles y permisos; revocación de sesiones al suspender desde el panel (04); pantalla de login HTML (08–09).

**Criterios de aceptación:**

- [x] Contraseñas con Argon2id (comprobado con el vector de RFC 9106).
- [x] Sesiones opacas de alta entropía, con solo el hash almacenado, caducidad máxima e inactividad, y revocación (logout, recuperación).
- [x] Cookies `HttpOnly`, `SameSite=Strict` y, con https, `Secure` + `__Host-`.
- [x] Protección CSRF (origen + token) verificada.
- [x] Límite de intentos y protección contra fuerza bruta y enumeración verificados.
- [x] Sin tokens ni contraseñas en claro en la base de datos ni en los registros.
- [x] `general_admin` solo por consola; único y auditado.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–02) y se comprobó el flujo de extremo a extremo con el servidor real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-10).

## Bloque 04 — Detalle

**Alcance:** migración 002 (contraseña temporal, `disabled` final, usuario inmutable, catálogo de 9 permisos); autorizador único; API de usuarios (alta, edición, estados, contraseña temporal, revocación de sesiones) y de asignación de secciones y permisos; cambio de la propia contraseña; alcance en la sesión; enrutador con parámetros; validación estricta; auditoría; pruebas; documentación ([USERS.md](USERS.md)).

**Fuera de alcance:** CRUD de secciones (05); aplicación del autorizador a contenidos y multimedia (06–08); interfaz HTML.

**Criterios de aceptación:**

- [x] Solo el `general_admin` crea administradores de sección, asigna y revoca secciones, define permisos, suspende usuarios y revoca sesiones.
- [x] Los administradores de sección no acceden a la administración (403, auditado) ni pueden escalar privilegios.
- [x] Permisos verificados en el backend por un autorizador único que no confía en el cliente.
- [x] El `general_admin` no se puede manipular por la API; rol y usuario inmutables; `disabled` final.
- [x] Contraseña temporal con cambio obligatorio; cambio de contraseña seguro.
- [x] Cambios de usuarios y permisos auditados, sin contraseñas.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–03) y se comprobó el flujo de extremo a extremo con el servidor real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-10).
