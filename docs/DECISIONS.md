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
