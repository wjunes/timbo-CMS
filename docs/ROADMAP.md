# Hoja de ruta

Estados: `PENDING` · `IN_PROGRESS` · `VALIDATION` · `APPROVED` · `BLOCKED`

| Bloque | Descripción | Estado |
| --- | --- | --- |
| 01 | Inicialización del proyecto y configuración base | `APPROVED` |
| 02 | SQLite, esquema inicial y migraciones | `APPROVED` |
| 03 | Autenticación y gestión de sesiones | `APPROVED` |
| 04 | Usuarios, roles y permisos | `APPROVED` |
| 05 | Administración de secciones | `APPROVED` |
| 06 | Motor de contenidos y versionado | `APPROVED` |
| 07 | Flujos editoriales y aprobaciones | `APPROVED` |
| 08 | Editor enriquecido y multimedia | `APPROVED` |
| 09 | Sitio público y presentación adaptable | `PENDING` |
| 10 | Auditoría, copias de seguridad y restauración (y pantallas de administración general, D-045) | `PENDING` |
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

## Bloque 05 — Detalle

**Alcance:** migración 003 (catálogo de presentaciones con FK, tipo inmutable, máximo 3 niveles, reglas de estado en la jerarquía, secciones del sistema no archivables); API de secciones (alta, edición, movimiento, estados, borrado seguro, orden) y de catálogos (tipos y presentaciones); visibilidad por asignación para administradores de sección; generación de slugs; ampliación de la validación; auditoría; pruebas; documentación ([SECTIONS.md](SECTIONS.md)).

**Fuera de alcance:** contenidos (06), transiciones editoriales (07), renderizado público y redirecciones al cambiar slugs (09), interfaz HTML.

**Criterios de aceptación:**

- [x] Solo el `general_admin` crea, modifica, mueve, archiva, borra y ordena secciones; los intentos de un administrador de sección se rechazan (403, auditado) sin efectos.
- [x] Un administrador de sección solo ve sus secciones asignadas.
- [x] Secciones personalizadas con tipos y presentaciones del sistema; sin plantillas ni código; catálogos ampliables con una migración.
- [x] Jerarquía sin ciclos, de 3 niveles como máximo; slugs válidos, únicos entre hermanas y sin prefijos reservados en la raíz.
- [x] Secciones del sistema protegidas (no se borran ni se archivan); secciones en uso no se borran.
- [x] Flujo `direct`/`approval` configurable, sin saltarse revisiones pendientes.
- [x] Cambios de secciones auditados.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–04) y se comprobó el flujo de extremo a extremo con el servidor real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-21).

## Bloque 06 — Detalle

**Alcance:** migración 004 (contenidos sin cambio de sección ni borrado físico; versiones que nacen como borrador; secciones archivadas y contenidos archivados o eliminados de solo lectura); API de contenidos (alta con versión 1, lectura, slug y orden, borrado lógico) y de versiones (historial, consulta, nueva versión basada en otra, guardado de borradores con control de revisión, descarte); validación estricta del cuerpo Tiptap; `canView` en el autorizador; auditoría; pruebas; documentación ([CONTENTS.md](CONTENTS.md)).

**Fuera de alcance:** transiciones editoriales (07), editor e imágenes (08), renderizado público y colisiones de slug con subsecciones (09), interfaz HTML.

**Criterios de aceptación:**

- [x] Un contenido se crea con su versión 1 en borrador; estado del contenido y de las versiones separados.
- [x] Editar nunca sobrescribe la versión publicada; las versiones anteriores se conservan y el historial se consulta.
- [x] Una sola versión en curso; las versiones nuevas parten de la publicada, de una rechazada o de una anterior.
- [x] Las ediciones simultáneas no se pisan (`revision_conflict`).
- [x] Se registra quién crea y modifica cada versión, y cada escritura se audita (sin el cuerpo).
- [x] Autorización en el backend por sección y permiso; sin acceso entre secciones; denegaciones auditadas.
- [x] El cuerpo solo admite nodos, marcas, atributos y enlaces de la lista blanca; lo demás se rechaza con su ruta.
- [x] Borrado lógico; los contenidos publicados o en revisión no se eliminan.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–05) y se comprobó el flujo de extremo a extremo con el servidor real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-21).

## Bloque 07 — Detalle

**Alcance:** migración 005 (transiciones válidas de versión, revisión obligatoria y única por versión, sin publicación de borradores en secciones `approval`); módulo `editorial` con enviar a revisión, aprobar, solicitar cambios, publicar (con reemplazo atómico de la versión publicada), despublicar, archivar y restaurar contenidos; revisiones por versión y cola de revisión del `general_admin`; revalidación del cuerpo; auditoría; pruebas; documentación ([EDITORIAL.md](EDITORIAL.md)).

**Fuera de alcance:** publicación programada y notificaciones (no especificadas), interfaz (08–09), consulta y restauración de contenidos eliminados.

**Criterios de aceptación:**

- [x] Flujo `direct`: publicación de borradores por quien tiene `content.publish`.
- [x] Flujo `approval`: enviar, revisión del `general_admin` (aprobar o solicitar cambios con comentario) y publicación de la versión aprobada exacta.
- [x] Nadie, ni un `section_admin` con todos los permisos, aprueba ni publica sin aprobación en secciones `approval`; la base lo garantiza también.
- [x] Publicar nunca sobrescribe: la versión anterior se archiva en la misma transacción y queda en el historial.
- [x] Despublicar, archivar y restaurar contenidos.
- [x] Se registra quién envió, aprobó (o pidió cambios) y publicó cada versión; cada transición se audita.
- [x] Solo transiciones válidas; las versiones enviadas son inmutables; el cuerpo se revalida antes de enviar y publicar.
- [x] Autorización en el backend por sección y permiso; sin acceso entre secciones; denegaciones auditadas.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–06) y se comprobó el flujo de extremo a extremo con el servidor real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-22).

## Bloque 08 — Detalle

**Alcance:**

- migración 006: archivos inmutables, eliminación bloqueada si están en uso, referencias solo de la propia sección, nada se envía ni se publica con archivos eliminados;
- módulo `media`:
  - subida en bruto con verificación del contenido real y eliminación de metadatos;
  - biblioteca por sección, texto alternativo, borrado lógico;
  - envío al panel en un sandbox;
- imágenes (`mediaId`) y enlaces `/media/<id>` en el cuerpo, registrados en `content_media`;
- renderizado seguro y vista previa;
- editor Tiptap empaquetado localmente;
- núcleo del panel en `/admin/` con CSP estricta;
- pruebas y documentación ([MEDIA.md](MEDIA.md)).

**Fuera de alcance:**

- servir los archivos al público (Bloque 09);
- purga física de archivos, huérfanos y temporales (Bloque 10);
- pantallas de usuarios, permisos, secciones y configuración (Bloque 10, D-045).

**Criterios de aceptación:**

- [x] Editor con negrita, cursiva, subrayado, encabezados, listas, enlaces, imágenes, tablas, citas, alineación, deshacer y rehacer, y vista previa; Tiptap sin framework frontend.
- [x] Contenido estructurado (JSON) que el backend valida con la lista blanca y escapa al renderizar; el esquema del editor coincide con la lista blanca.
- [x] Archivos en disco (nunca BLOB), con nombre aleatorio; validación de la extensión, el MIME y el contenido real; límite de tamaño y de dimensiones.
- [x] Sin ejecución: MIME de la base, `nosniff`, CSP `sandbox`, PDF como descarga y sin contenido activo; `storage/` no se sirve.
- [x] Control de acceso por sección y permiso (`media.upload`, `media.delete`); sin acceso entre secciones; denegaciones auditadas.
- [x] No se eliminan archivos en uso por contenidos publicados (ni en borrador, revisión o aprobados); la base lo garantiza también.
- [x] Metadatos de las fotos eliminados (EXIF/GPS, XMP, comentarios), conservando la orientación.
- [x] Panel con CSP sin nada en línea; token CSRF solo en memoria; nada en `localStorage`.
- [x] Todas las pruebas pasan (incluidas las de los Bloques 01–07). Se comprobó el flujo de extremo a extremo con el servidor real y el panel en un navegador real.
- [x] Documentación actualizada.
- [x] Revisión y aprobación del responsable del proyecto (2026-11-22).
