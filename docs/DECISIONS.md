# Registro de decisiones técnicas

Formato: contexto → decisión → consecuencias. Las decisiones solo se revisan con justificación demostrable.

## D-001 · Nombre del paquete y del repositorio

- **Contexto:** el repositorio se llama `timbo-CMS`; el proyecto se denomina CMS-MULTISECCION.
- **Decisión:** no se renombra el repositorio. `package.json` usa `cms-multiseccion` (npm exige minúsculas) con `"private": true` para impedir publicaciones accidentales.

## D-002 · Módulos ECMAScript

- **Decisión:** `"type": "module"`. Es el estándar de Node 24, permite `import` estático y coincide con el código del navegador.

## D-003 · Carga de `.env` con el flag nativo de Node

- **Decisión:** usar `node --env-file-if-exists=.env` en los scripts, sin dependencia `dotenv`. `loadConfig(env)` es una función pura que recibe el objeto de entorno, lo que permite probarla sin tocar `process.env`.
- **Consecuencias:** las variables reales del entorno prevalecen sobre `.env`. Si `.env` no existe, se usan los valores por defecto (solo válidos fuera de producción).

## D-004 · Separación `app.js` / `server.js`

- **Contexto:** la estructura de referencia solo nombra `backend/server.js`.
- **Decisión:** `app.js` construye el servidor sin efectos secundarios; `server.js` solo arranca, escucha señales y sale. Permite pruebas de integración en un puerto efímero sin `process.exit`.

## D-005 · Pruebas con `node:test`

- **Decisión:** usar el runner nativo (`node --test`) y `node:assert/strict`. Sin Jest/Mocha.

## D-006 · Riesgo: repositorio dentro de OneDrive — RESUELTO

- **Contexto:** durante el Bloque 01 el proyecto residía en una carpeta sincronizada por OneDrive. La sincronización puede bloquear o copiar de forma no atómica los archivos de SQLite (`.db`, `-wal`, `-shm`), con riesgo de corrupción.
- **Resolución (2026-11-10):** el proyecto se trasladó a un disco local no sincronizado (`D:\dev\timbo-CMS`). El riesgo deja de aplicar al entorno de desarrollo.
- **Medida que se mantiene:** las rutas de la base de datos y de `storage/` serán configurables por variables de entorno (Bloque 02). Ya no responde a este riesgo, sino a la necesidad de ubicar los datos fuera del código en producción. Regla general: nunca ubicar la base de datos en carpetas sincronizadas (OneDrive, Dropbox…) ni en unidades de red.

## D-007 · Argon2id nativo — DECIDIDO (Bloque 03)

- **Contexto:** Node expone `crypto.argon2` / `crypto.argon2Sync` desde la v24.7.0. La documentación de Node 24 no les asigna un nivel de estabilidad propio, así que heredan el del módulo `crypto` (Stable).
- **Decisión:** usar Argon2id nativo, sin dependencia externa ni compilación nativa. Parámetros: 64 MiB, t=3, p=4, etiqueta de 32 bytes y sal de 16 (RFC 9106 §4), en formato PHC. La implementación se comprueba con el vector de prueba de RFC 9106.
- **Consecuencias:** `engines.node` pasa a `>=24.7.0` y `npm run check` falla si `crypto.argon2` no existe. Los cálculos simultáneos están limitados (cada uno reserva ~64 MiB). Si se cambian los parámetros, los hashes se recalculan de forma transparente en el siguiente login.

## D-008 · Directorios solo con contenido real

- **Decisión:** no se crean carpetas ni archivos vacíos o `.gitkeep` para completar la estructura de referencia. La estructura planificada se documenta en [ARCHITECTURE.md](ARCHITECTURE.md).

## D-009 · Finales de línea LF

- **Decisión:** `.gitattributes` con `* text=auto eol=lf` para evitar diferencias por CRLF entre Windows y los servidores Linux de despliegue.

## D-010 · Migraciones solo hacia delante, inmutables y explícitas (Bloque 02)

- **Decisión:** archivos SQL `NNN_nombre.sql` contiguos, una transacción por migración, checksum SHA-256 registrado en `schema_migrations`. No hay migraciones de vuelta atrás. El servidor **no migra al arrancar**: si hay migraciones pendientes o modificadas, no arranca (`npm run db:migrate` se ejecuta explícitamente).
- **Motivo:** las migraciones de vuelta atrás rara vez se prueban y pueden perder datos; revertir es restaurar un backup (Bloque 10). Migrar en el arranque oculta cambios de esquema en producción y complica despliegues con varias instancias.

## D-011 · Invariantes en la base de datos además del backend (Bloque 02)

- **Decisión:** las reglas estructurales se aplican también con `CHECK`, `UNIQUE` parciales, FK compuestas y triggers que fallan con `RAISE(ABORT, '<código>')`. Ejemplos: un solo `general_admin`, rol inmutable, inmutabilidad de versiones, auditoría de solo inserción, permisos solo sobre secciones asignadas. Los códigos son estables y se documentan en [DATABASE.md](DATABASE.md).
- **Motivo:** defensa en profundidad. Un fallo en la aplicación no puede dejar un estado inválido. Las comprobaciones de autorización por petición siguen siendo del backend (Bloques 03–07).
- **Ajuste sobre el plan:** la prevención de ciclos en la jerarquía de secciones, prevista para el Bloque 05, se incorporó como trigger (la CTE recursiva funciona dentro de triggers en SQLite 3.53). El Bloque 05 solo valida y traduce el error.

## D-012 · Estado del contenido separado del estado de la versión (Bloque 02)

- **Decisión:** el contenido tiene `draft|published|archived|deleted`, que indica si es visible. La versión tiene `draft|pending_review|changes_requested|approved|published|archived`, que es el estado editorial. `changes_requested` es final para esa versión: se crea una nueva basada en ella. La versión publicada anterior pasa a `archived`.
- **Consecuencia:** lo enviado a revisión nunca se modifica, y una aprobación siempre se refiere a una versión concreta. El grafo de transiciones lo valida el Bloque 07.

## D-013 · Usuarios sin borrado físico; rol inmutable; `general_admin` siempre activo (Bloque 02)

- **Decisión:** los usuarios se desactivan, nunca se eliminan (así se conservan la autoría y la auditoría). El rol no cambia tras la creación. El `general_admin` no puede suspenderse ni desactivarse.
- **Consecuencia:** cambiar quién es el administrador general no es una operación del panel. Cualquier procedimiento de recuperación o traspaso tendrá que ser explícito y auditado, y se definirá en los Bloques 03–04 (sin puertas traseras).

## D-014 · Rutas de datos configurables y fuera de lo público (Bloque 02)

- **Decisión:** `DATABASE_PATH` (por defecto `database/cms.db`) y `STORAGE_DIR` (por defecto `storage`) se resuelven respecto de la raíz del proyecto, no del directorio actual. Se rechazan si apuntan dentro de `frontend/` o contienen caracteres nulos. `:memory:` solo se admite fuera de producción.

## D-015 · Datos del sistema en la migración 001 (Bloque 02)

- **Decisión:** la migración 001 carga los 5 tipos de sección y las 5 secciones predefinidas (`is_system = 1`, `workflow = 'approval'`, el más restrictivo). El catálogo de permisos se carga en el Bloque 04, donde se define el significado de cada permiso.

## D-016 · Prefijos de URL reservados (Bloque 02)

- **Decisión:** las secciones de primer nivel no pueden usar `admin`, `api`, `assets`, `media`, `static`, `health`, `login` ni `logout`, para que no choquen con las rutas del sistema (Bloque 09). Si hicieran falta más prefijos, se añadirían con una migración.

## D-017 · `tests/helpers/` (Bloque 02)

- **Decisión:** se añade `tests/helpers/` (no aparece en la estructura de referencia) para las utilidades compartidas de prueba: base de datos migrada en memoria y datos de ejemplo. No contiene archivos `*.test.js`, así que el runner no lo ejecuta.

## D-018 · Alta y recuperación del `general_admin` solo por consola (Bloque 03)

- **Decisión:** `npm run admin:create` crea la única cuenta `general_admin` y falla si ya existe. `npm run admin:reset-password` cambia su contraseña y revoca todas sus sesiones. Ninguna de las dos operaciones existe por HTTP ni en el panel.
- **Motivo:** no hay registro público ni puertas traseras. Recuperar el acceso exige acceso al servidor, que es el mismo nivel de confianza que tener la base de datos, y cada operación queda auditada (`via: "cli"`). La contraseña se pide oculta y nunca como argumento (no queda en el historial del shell ni en la lista de procesos).

## D-019 · Límite de intentos en memoria, sin bloqueo permanente (Bloque 03)

- **Decisión:** se cuentan los intentos fallidos en ventanas de 15 min: 5 por usuario e IP, 30 por IP y 50 por usuario desde cualquier IP. El intento bloqueado no ejecuta Argon2. El número de claves en memoria está acotado.
- **Motivo:** el monolito corre en un solo proceso, así que no hace falta almacenamiento compartido. Un bloqueo permanente permitiría a un atacante dejar fuera al `general_admin`.
- **Consecuencias:** los contadores se reinician al reiniciar el proceso. Si en el futuro hubiera varias instancias, el límite tendría que compartirse (por ejemplo, en SQLite).

## D-020 · CSRF: origen + token derivado de la sesión; rechazos al logger (Bloque 03)

- **Decisión:**
  - Capa 1: los métodos que modifican datos exigen `Origin` igual a `APP_BASE_URL` o `Sec-Fetch-Site: same-origin`.
  - Capa 2: las rutas autenticadas que modifican datos exigen `X-CSRF-Token = HMAC-SHA256(token de sesión, "cms-csrf-v1")`, comparado en tiempo constante. Se suma a la cookie `SameSite=Strict`.
- **Motivo:** el token se puede calcular sin guardar nada, sin secreto de servidor que rotar y sin columna nueva, y solo lo conoce quien tiene la cookie `HttpOnly`.
- **Ajuste sobre el plan:** las peticiones rechazadas por origen, CSRF o límite de intentos se registran en el logger (`warn`), no en `audit_logs`. Un atacante no autenticado no puede llenar la auditoría. Los logins fallidos sí se auditan, y su volumen está acotado por el límite de intentos.

## D-021 · `createServer` recibe la base de datos y dependencias inyectables (Bloque 03)

- **Decisión:** `createServer({ config, logger, db, clock?, passwordHasher? })`. El reloj y el hasher se pueden sustituir para probar caducidades y contar llamadas sin esperar ni usar parámetros reales de 64 MiB. Por eso se modificó `tests/integration/server.test.js` (Bloque 01), que solo pasa ahora la conexión: no cambia ninguna expectativa.
- **Detalle:** el nombre de la cookie depende del esquema de `APP_BASE_URL`: `__Host-cms_session` con `Secure` si es https y `cms_session` si es http (desarrollo local), porque sobre http `Secure` y `__Host-` no son fiables entre navegadores (solo algunos los aceptan en `localhost`). En producción la URL es siempre https (validado en la configuración).

## D-022 · Catálogo de permisos del sistema y autorizador único (Bloque 04)

- **Decisión:** 9 permisos por sección (`content.create|edit|submit|publish|unpublish|archive|delete`, `media.upload|delete`), cargados en la migración 002. `content.edit` abarca toda la sección. El `general_admin` tiene todos por su rol. Toda decisión pasa por `createAuthorizer(db).can/require`, que relee rol y estado desde la base.
- **Motivo:** un permiso solo tiene efecto si el código lo comprueba. Si se pudieran crear permisos desde el panel, serían etiquetas sin efecto y darían una falsa sensación de control. Por eso el catálogo se amplía con una migración más el código que lo exige.
- **Consecuencia:** asignar y quitar permisos a cada administrador y sección sí se hace desde el panel, sin límites.

## D-023 · Alta con contraseña temporal y cambio obligatorio (Bloque 04)

- **Decisión:** no hay invitación por correo (no existe esa infraestructura). El `general_admin` fija una contraseña temporal (con la misma política) y `users.must_change_password = 1`. Hasta cambiarla, la sesión solo accede a `session`, `password` y `logout` (`403 password_change_required`).
- **Consecuencia:** la contraseña temporal se comunica fuera del sistema. Nunca se guarda en claro ni aparece en la auditoría o los registros.

## D-024 · `disabled` final, usuario inmutable, `general_admin` fuera de la API (Bloque 04)

- **Decisión:** triggers en la migración 002: `disabled` no se puede revertir y `username` no se puede cambiar (comparación binaria, también para cambios de mayúsculas). La API de usuarios responde `403 target_protected` a cualquier escritura sobre el `general_admin`, que solo cambia su contraseña con `/api/auth/password` y se recupera por consola (D-018).
- **Motivo:** la auditoría sigue siendo legible (un nombre siempre identifica a la misma persona) y no hay forma de bloquear o degradar al administrador general desde la API.

## D-025 · Denegaciones por rol en la auditoría (Bloque 04)

- **Decisión:** un usuario autenticado que intenta usar una ruta de otro rol recibe `403 forbidden`, y queda un registro `access.denied` en `audit_logs`.
- **Motivo:** es una señal de seguridad relevante (intento de escalada). A diferencia de los rechazos sin sesión (D-020), el actor está identificado y el volumen depende de usuarios legítimos.

## D-026 · Enrutador con parámetros numéricos y validación estricta (Bloque 04)

- **Decisión:** `middleware/router.js` admite segmentos `:nombre` que solo aceptan enteros positivos; otro valor responde `404`. `utils/validation.js` valida los cuerpos con un esquema explícito, rechaza campos desconocidos (impide la asignación masiva de `role`/`status`) y devuelve `fields: { campo: código }`.
- **Contrato ampliado:** el login y `GET /api/auth/session` incluyen ahora `user.mustChangePassword` y `access` (`{ scope: "all" }` o `{ scope: "sections", sections: [...] }`). Se actualizó la aserción correspondiente en `tests/integration/auth.test.js` (Bloque 03).

## D-027 · Presentaciones en un catálogo con clave foránea (Bloque 05)

- **Decisión:** la migración 003 crea la tabla `presentations` y convierte `sections.presentation` y `section_types.default_presentation` en claves foráneas hacia ella. Antes eran un `CHECK` con una lista fija.
- **Motivo:** SQLite no permite modificar un `CHECK` sin reconstruir la tabla. Reconstruir `sections` exige desactivar las claves foráneas y arriesga borrados en cascada de las asignaciones (`user_sections … ON DELETE CASCADE`). Con el catálogo, añadir una presentación es un `INSERT` en una migración.
- **Cómo:** sin reconstruir tablas (`ADD COLUMN … REFERENCES`, copia, `DROP COLUMN`, `RENAME COLUMN`), probado con datos y asignaciones. SQLite no admite añadir una columna con `REFERENCES` y valor por defecto no nulo, así que `NOT NULL` se garantiza con triggers (`presentation_required`).
- **Se mantiene:** los administradores eligen entre presentaciones existentes; no se suben plantillas ni código. Una presentación nueva requiere su plantilla en el sitio público (Bloque 09).

## D-028 · El tipo de sección es inmutable (Bloque 05)

- **Decisión:** trigger `section_type_immutable`; `PATCH /api/sections/:id` no acepta `type`.
- **Motivo:** el tipo determina la estructura de los contenidos (Bloque 06). Cambiarlo con contenidos existentes los dejaría incoherentes. Se crea otra sección y se mueven los contenidos.

## D-029 · Jerarquía de 3 niveles como máximo (Bloque 05)

- **Decisión:** triggers en la migración 003 al insertar y al mover (nivel del padre + 1 + altura del subárbol movido ≤ 3). En un ciclo, el error sigue siendo `section_cycle`. Los recorridos están acotados.
- **Motivo:** URLs legibles y navegación manejable en el sitio público; consultas jerárquicas acotadas.

## D-030 · Semántica de estados de sección (Bloque 05)

- **Decisión:** `active` (visible), `inactive` (oculta, editable y asignable: sirve para preparar una sección antes de mostrarla) y `archived` (oculta, solo lectura, no asignable). Las secciones del sistema pueden desactivarse pero no archivarse. Una sección solo se archiva si sus subsecciones ya lo están, y nada se crea ni se reactiva bajo un padre archivado. Todo ello con triggers.
- **Borrado:** solo secciones personalizadas sin subsecciones, contenidos ni archivos. Lo demás se archiva.
- **Ajuste de una prueba del Bloque 04:** `tests/integration/users.test.js` archivaba la sección del sistema 3 para probar `section_archived`; ahora usa una sección personalizada archivada, porque la regla nueva lo impide. La expectativa no cambia.

## D-031 · No pasar a flujo directo con revisiones pendientes (Bloque 05)

- **Decisión:** `approval` → `direct` responde `409 pending_reviews_exist` si hay versiones en `pending_review` en la sección.
- **Motivo:** con flujo directo nadie revisaría esas versiones y se podrían publicar sin la aprobación con la que se enviaron. El tratamiento completo de las transiciones es del Bloque 07.

## D-032 · Validación: `__proto__` y reglas nuevas (Bloque 05)

- **Hallazgo:** en `utils/validation.js` (Bloque 04), una clave `"__proto__"` en el cuerpo no se rechazaba: asignarla en el objeto de errores cambiaba el prototipo en lugar de crear el campo, y el error se perdía. No era explotable (solo se copian los campos del esquema), pero incumplía el rechazo estricto de campos desconocidos.
- **Corrección:** el objeto de errores no tiene prototipo y se convierte con `Object.fromEntries`. Prueba unitaria y de seguridad añadidas.
- **Ampliación:** reglas `oneOf`, `integer`, `idList` y la opción `nullable`. No cambian el comportamiento de las reglas existentes.

## D-033 · Validación estricta del cuerpo Tiptap desde el Bloque 06

- **Decisión:** el backend valida el cuerpo en cada guardado con una lista blanca de nodos, marcas y atributos con valores acotados, y rechaza lo que no encaja indicando la ruta (`bodyPath`). No se corrige ni se descarta nada en silencio: lo guardado es exactamente lo que envió el autor.
- **Motivo:** no guardar nunca contenido sin validar, aunque el editor llegue en el Bloque 08. Corregir en silencio ocultaría errores del cliente y haría que el autor viera algo distinto de lo guardado.
- **Alcance:** texto, títulos (2–4), listas, citas, tablas, saltos de línea; negrita, cursiva, subrayado y enlaces (`http(s)`, `mailto`, rutas propias, anclas). Se admiten los atributos por defecto que emite Tiptap. Las imágenes se añaden en el Bloque 08. El sitio público (Bloque 09) escapará todo al renderizar.

## D-034 · Un contenido no cambia de sección (Bloque 06)

- **Decisión:** trigger `content_section_immutable`; la API no acepta `sectionId` al editar.
- **Motivo:** los permisos se conceden por sección; mover un contenido cambiaría quién puede verlo y editarlo, y su URL pública. Si hiciera falta, se planteará como operación propia y auditada.

## D-035 · Borrado lógico de contenidos (Bloque 06)

- **Decisión:** `DELETE /api/contents/:id` marca `status = 'deleted'` con `deleted_by`/`deleted_at`; las versiones se conservan; el slug queda libre. El trigger `content_delete_forbidden` impide el borrado físico.
- **Ajuste de una prueba del Bloque 02:** `tests/integration/schema.test.js` («el borrador es editable y descartable») borraba físicamente el contenido; ahora comprueba que la base lo impide. El resto de la prueba no cambia.
- **Pendiente:** consulta y restauración de eliminados (sin bloque asignado; se propondrá más adelante).

## D-036 · El autor edita sus propios borradores con `content.create` (Bloque 06)

- **Decisión:** editar o descartar un borrador exige `content.edit`, o `content.create` si el borrador lo creó el propio usuario. Crear versiones nuevas, cambiar slug u orden exige `content.edit`.
- **Motivo:** sin esto, quien solo puede crear no podría corregir lo que acaba de crear.

## D-037 · Contenidos publicados o en revisión no se eliminan (Bloque 06)

- **Decisión:** `409 content_published` (despublicar antes, Bloque 07) y `409 content_in_review` si hay una versión `pending_review` o `approved`. La base ya impedía el primer caso (`CHECK` de `published_version_id`).
- **Motivo:** no retirar del sitio público ni dejar revisiones huérfanas con una operación de edición.

## D-038 · Descarte de borradores y numeración (Bloque 06)

- **Decisión:** un borrador se descarta con borrado físico (lo permitía ya la migración 001), salvo que sea la única versión (`409 only_version`: se elimina el contenido). El número de versión es el máximo existente + 1, así que el de un borrador descartado puede reutilizarse.
- **Motivo:** un borrador descartado nunca fue revisado ni publicado; la auditoría (`version.discard`, con su número e id) conserva el rastro. La entidad de auditoría es el contenido, cuyo id no se reutiliza porque no se borra.

## D-039 · Colisión de slugs entre contenidos y subsecciones (aplazada al Bloque 09)

- **Riesgo detectado:** un contenido y una subsección de la misma sección pueden tener el mismo slug (`/noticias/agenda`). Hoy no hay conflicto porque no existe el sitio público.
- **Propuesta:** decidirlo en el Bloque 09 junto con el enrutado público (precedencia o comprobación cruzada en ambos sentidos). Comprobar solo en un sentido ahora sería incompleto y exigiría modificar el Bloque 05, ya aprobado.
- **Acordado (2026-11-21):** el responsable del proyecto aprueba aplazarlo; se resolverá en el Bloque 09.
- **Resuelto (Bloque 09):** se prohíbe en los dos sentidos; ver D-058.

## D-040 · `content.publish` también publica versiones aprobadas en secciones `approval` (Bloque 07)

- **Decisión:** en las secciones `approval`, aprobar y publicar son pasos distintos. Publica la versión aprobada exacta el `general_admin` o un `section_admin` con `content.publish`. En las secciones `direct`, `content.publish` publica borradores.
- **Motivo:** la aprobación queda ligada a una versión concreta e inmutable, y quien gestiona la sección decide cuándo sale. Nadie publica sin aprobación: lo impiden la aplicación y la base (`approval_required`).
- **Cambio respecto al catálogo del Bloque 04:** la descripción de `content.publish` decía «solo secciones con flujo direct». La migración 005 la actualiza (el código del permiso no cambia), y también se actualizó [USERS.md](USERS.md). Aprobado por el responsable del proyecto el 2026-11-22.

## D-041 · El `general_admin` sigue el mismo flujo (Bloque 07)

- **Decisión:** en las secciones `approval`, el `general_admin` también envía, aprueba y publica en pasos separados; no hay atajo «publicar sin revisión».
- **Motivo:** que quede registrado quién envió, quién aprobó y quién publicó cada versión, sin excepciones (tampoco puertas traseras). La interfaz podrá encadenar las tres llamadas.

## D-042 · Despublicar y archivar sin aprobación (Bloque 07)

- **Decisión:** despublicar (`content.unpublish`), archivar y restaurar (`content.archive`) no pasan por revisión, ni siquiera en secciones `approval`.
- **Motivo:** retiran contenido del sitio, no lo exponen. Restaurar deja el contenido en borrador, así que no publica nada. Archivar no se permite con una versión en revisión o aprobada (`content_in_review`), por coherencia con D-037.

## D-043 · Las transiciones de borrador exigen la `revision` del cliente (Bloque 07)

- **Decisión:** enviar a revisión y publicar un borrador (flujo `direct`) exigen la `revision` que tiene el cliente; si no coincide, `409 revision_conflict`.
- **Motivo:** se envía o se publica exactamente lo que la persona vio, aunque otra haya guardado el borrador entre medias. Las versiones aprobadas son inmutables y no la necesitan.

## D-044 · Defensa en la base del flujo editorial (Bloque 07)

- **Decisión:** la migración 005 añade transiciones válidas, revisión obligatoria y única por versión, aprobación firmada por el revisor y `approval_required`. La regla de «sección archivada sin transiciones» queda solo en la aplicación.
- **Motivo:** las garantías clave (nadie publica sin aprobación, aprobaciones ligadas a una versión) se cumplen aunque se escriba en la base por otra vía. Llevar a la base la de la sección archivada exigiría modificar una prueba aprobada del Bloque 06.
- **Pruebas anteriores ajustadas:** el ayudante `publishVersion` (`tests/helpers/db.js`) recorre ahora enviar, revisar y aprobar en las secciones `approval`; se añade `reviewVersion`. En `contents.test.js`, la versión rechazada se crea con su revisión. En `schema.test.js` («los estados exigen sus marcas…»), publicar un borrador en una sección `approval` da `approval_required`, y el `CHECK` de la marca de publicación se comprueba en una sección `direct`. Las reglas que comprobaban siguen cumpliéndose.

## D-045 · Alcance del panel en el Bloque 08

- **Decisión:** el Bloque 08 construye el núcleo del panel: acceso, cambio de contraseña, secciones, contenidos con el editor, acciones editoriales, cola de revisión y biblioteca multimedia. Las pantallas de usuarios, permisos, secciones (alta y edición) y configuración pasan al Bloque 10, junto con la consulta de auditoría y las copias de seguridad, que también son pantallas de administración.
- **Motivo:** el editor y la multimedia necesitan un panel donde usarse, pero ningún bloque del plan recogía las pantallas de administración general. Su API ya existe (Bloques 04–05).
- **Aprobado** por el responsable del proyecto al aprobar el plan del Bloque 08 (2026-11-22).

## D-046 · Tiptap como dependencia de desarrollo y bundle versionado (Bloque 08)

- **Decisión:** `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-table`, `@tiptap/extension-blockquote` y `@tiptap/extension-list` (3.33.0), más `esbuild` (0.28.2), son `devDependencies` con versión exacta. `npm run build:editor` genera `frontend/admin/assets/editor.bundle.js`, que se versiona junto con las licencias de lo que contiene. Una prueba comprueba que el bundle coincide con las dependencias instaladas.
- **Motivo:**
  - la especificación exige Tiptap sin un framework frontend;
  - Tiptap y ProseMirror son módulos npm que el navegador no puede cargar sin empaquetar;
  - un CDN añadiría un tercero a la CSP y a la cadena de suministro;
  - versionar el bundle evita compilar al desplegar, y el servidor sigue sin dependencias de ejecución.
- **Versiones:** todas tenían más de dos semanas de antigüedad. Se instaló con `npm install --before=2026-11-08`, también para las dependencias transitivas con rango `^`. El `postinstall` de esbuild no se autorizó: no es necesario.

## D-047 · Archivos en uso y borrado lógico (Bloque 08)

- **Decisión:** eliminar un archivo es lógico. No se permite si lo usa una versión en borrador, en revisión, aprobada o publicada de un contenido no eliminado (`409 media_in_use`, también por trigger). El archivo físico se conserva. La purga física, el «procedimiento controlado» de la especificación, queda para el Bloque 10.
- **Motivo:** la especificación prohíbe eliminar archivos que usen contenidos publicados. Extenderlo a borradores y revisiones evita que algo en curso pierda sus imágenes. Conservar el archivo físico mantiene consultable el historial de versiones archivadas.

## D-048 · Tipos admitidos y subida en bruto (Bloque 08)

- **Decisión:**
  - PNG, JPEG, WebP y PDF; ni SVG ni GIF;
  - 10 MiB por archivo, configurable con `MEDIA_MAX_BYTES` (de 1 KiB a 50 MiB);
  - el archivo es el cuerpo de la petición, con su `Content-Type` y el nombre original en `X-File-Name` (URI-encoded), en lugar de `multipart/form-data`.
- **Motivo:** SVG puede contener scripts. La subida en bruto evita escribir o añadir un analizador multipart, que es una superficie de ataque más.

## D-049 · Eliminación de metadatos sin recodificar (Bloque 08)

- **Decisión:** al subir, se eliminan EXIF (incluido el GPS), XMP, IPTC, comentarios, bloques de texto y los datos posteriores al final del formato. De EXIF solo se conserva la orientación. Se hace con código propio que reescribe la estructura del archivo, sin decodificar la imagen.
- **Motivo:** las fotos de móvil revelan la ubicación y el dispositivo, y en un sitio institucional se publicarían. Recodificar exigiría una biblioteca nativa de imágenes. Quitar los datos finales neutraliza archivos políglotas, por ejemplo una imagen seguida de un ZIP o de código.

## D-050 · Referencias a la biblioteca desde el cuerpo (Bloque 08)

- **Decisión:**
  - el nodo `image` guarda `mediaId` y `alt`, nunca una URL;
  - un enlace a la biblioteca usa la ruta exacta `/media/<id>`, que será la pública del Bloque 09;
  - ambos deben ser archivos activos de la misma sección, y se registran en `content_media` al guardar el borrador;
  - se vuelven a comprobar al enviar y al publicar;
  - la base garantiza la misma sección (`media_section_mismatch`) y que no se envíe ni publique nada con archivos eliminados (`media_not_available`).
- **Motivo:** sin URL libre no se pueden incrustar imágenes externas, que permitirían rastreo o contenido mixto. Registrar las referencias es lo que impide eliminar un archivo en uso (D-047), también los PDF enlazados.

## D-051 · PDF sin contenido activo (Bloque 08)

- **Decisión:** se rechazan los PDF con JavaScript, acciones de lanzamiento, archivos incrustados, contenido multimedia, formularios XFA, envío o importación de datos. Se revisan también los flujos comprimidos, con un límite de descompresión, y se interpretan los escapes `#xx`.
- **Motivo:** el sitio publicará estos documentos para descargarlos, y muchos lectores de PDF ejecutan contenido activo. Es una defensa de mejor esfuerzo. Además, el servidor los sirve siempre como descarga, con `nosniff` y una CSP `sandbox`.

## D-052 · `media.upload` también edita el texto alternativo (Bloque 08)

- **Decisión:** editar el texto alternativo de un archivo exige `media.upload`. La migración 006 actualiza la descripción del permiso (el código no cambia).
- **Motivo:** el catálogo de permisos (D-022) no tiene uno para editar metadatos. Crear uno nuevo para un único campo complicaría la asignación sin aportar seguridad.

## D-053 · Tiempo máximo de petición de 120 s (Bloque 08)

- **Decisión:** `server.requestTimeout` pasa de 30 s a 120 s.
- **Motivo:** subir 10 MiB en 30 s exige unos 2,8 Mbit/s de subida, más de lo que tienen muchas conexiones. La protección frente a clientes lentos se mantiene: las cabeceras deben llegar en 15 s, y cada ruta limita el tamaño del cuerpo (16 KiB en las JSON).

## D-054 · Sitio público generado en el servidor y sin JavaScript (Bloque 09)

- **Decisión:**
  - el HTML público lo generan plantillas del sistema que escapan todo dato;
  - no hay JavaScript: el acordeón usa `<details>`, y la CSP pública no admite scripts;
  - solo se lee lo publicado: secciones `active` con ancestros `active`, y la versión publicada de los contenidos `published`;
  - todo lo demás responde un `404` idéntico al de una ruta inexistente.
- **Motivo:** la especificación exige acceso solo a lo publicado, y que los administradores no puedan introducir código. Sin scripts, un fallo de escapado no podría ejecutar nada. El `404` idéntico no revela qué existe.
- **Lección de la validación:** el `304` debe repetir la CSP de la respuesta. Si no, el navegador actualiza la copia guardada con la CSP base (`default-src 'none'`) y la página pierde estilos e imágenes. Las pruebas HTTP no lo detectaban; la prueba en navegador real sí, y ahora hay una prueba de regresión.

## D-055 · Redirecciones permanentes al cambiar URL (Bloque 09)

- **Decisión:** triggers de la migración 007 registran la ubicación anterior al cambiar el slug de un contenido, o el slug o el padre de una sección. Los registros solo se insertan, nunca se modifican. El sitio responde `301` a la ruta actual, solo si el destino es visible. Una ruta real tiene prioridad sobre una redirección.
- **Motivo:** era la deuda del Bloque 05 («No hay redirecciones automáticas»). Los enlaces externos y los buscadores no se rompen al renombrar. Registrarlo con triggers lo hace en la misma transacción, venga el cambio de donde venga.

## D-056 · Nombre y descripción del sitio en `settings` (Bloque 09)

- **Decisión:** `site.name` y `site.description` se guardan en la tabla `settings`. La migración 007 los crea con un valor por defecto, y el sitio usa ese mismo valor si el ajuste falta o no es un texto.
- **Motivo:** son datos editoriales, no de despliegue, así que no van en variables de entorno. La pantalla para editarlos llega con la configuración general (Bloque 10, D-045).

## D-057 · Portada, sitemap, robots y favicon (Bloque 09)

- **Decisión:**
  - la portada muestra las últimas 6 publicaciones de las secciones de tipo noticias y artículos, y las secciones principales;
  - `sitemap.xml` incluye solo lo visible;
  - `robots.txt` excluye `/admin/` y `/api/`;
  - `/favicon.ico` responde `204` hasta que exista una identidad visual.
- **Motivo:** no lo exige la especificación, pero son prácticas básicas de un sitio público, y el `204` evita un error en cada visita. Lo aprobó el responsable del proyecto (2026-11-22).

## D-058 · Contenidos y subsecciones no comparten slug (Bloque 09, resuelve D-039)

- **Decisión:** un contenido no puede tomar el slug de una subsección de su sección, ni una subsección el de un contenido no eliminado de su sección padre (`409 slug_taken`). Lo garantizan la aplicación y la base, con triggers de la migración 007. El slug generado de un contenido evita los de las subsecciones.
- **Motivo:** ambos tendrían la misma URL. Prohibirlo en los dos sentidos es lo único que no deja contenidos inaccesibles sin aviso. Exigió tocar los módulos de secciones y contenidos, ya aprobados, como se acordó al aplazar D-039.
- **Pruebas anteriores ajustadas:**
  - `schema.test.js`: hay 17 tablas, y la clave de ejemplo de `settings` pasa a ser `prueba.nombre`, porque `site.name` ya existe;
  - `database.test.js`: cuenta solo su propia clave de `settings`;
  - `server.test.js`: el 404 genérico en JSON se comprueba en `/api/…`, porque las demás rutas las atiende el sitio público (404 en HTML).

  Las reglas que comprobaban siguen cumpliéndose.
