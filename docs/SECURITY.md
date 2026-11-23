# Seguridad

La seguridad forma parte del diseño desde el Bloque 01. Este documento distingue entre lo **implementado y verificado** y lo **planificado**.

## Cumplimiento de la especificación (revisión del Bloque 11)

Cada medida de seguridad que exige la especificación, dónde está y qué la comprueba.

| Exigencia | Implementación | Verificación |
| --- | --- | --- |
| Contraseñas con Argon2id | `modules/auth/password.js` (`crypto.argon2` nativo, D-007) | `tests/unit/password.test.js` (vector de RFC 9106) |
| Sesiones opacas con tokens aleatorios de alta entropía | `modules/auth/sessions.js` (32 bytes de `randomBytes`) | `tests/unit/sessions.test.js` |
| Solo se guarda el hash del token | `sessions.token_hash` (SHA-256) | `tests/unit/sessions.test.js`, `tests/security/auth.security.test.js` |
| Cookies `HttpOnly`, `Secure` y `SameSite` | `middleware/http.js` (`SameSite=Strict`; `Secure` con `APP_BASE_URL` https, obligatoria en producción) | `tests/unit/http.test.js`, `tests/integration/auth.test.js` |
| Protección CSRF | Mismo origen en toda escritura y token `X-CSRF-Token` ligado a la sesión, solo en memoria del panel | `tests/security/routes.security.test.js` (todas las rutas), `auth.security.test.js` |
| XSS: sanitización y codificación contextual | Cuerpo por lista blanca y renderizado escapado; sitio público con plantillas escapadas y sin JavaScript; panel sin `innerHTML`; CSP | `tests/security/contents.security.test.js`, `public.security.test.js`, `tests/unit/contents-render.test.js` |
| Consultas SQL parametrizadas | Sentencias preparadas en todos los repositorios; la consulta de auditoría compone solo fragmentos fijos con parámetros con nombre | revisión de código, filtros probados en `tests/integration/audit.test.js` |
| Fuerza bruta y abuso de autenticación | Límites de inicio de sesión por IP, por usuario y por ambos; Argon2id acotado en concurrencia | `tests/security/auth.security.test.js` |
| Rate limiting | Límite general por IP, con otro más bajo para escrituras (D-064) | `tests/security/routes.security.test.js` |
| Content Security Policy | API `default-src 'none'`; panel sin nada en línea; sitio público sin scripts (también en `304`); archivos en `sandbox` | `tests/integration/server.test.js`, `public.security.test.js`, `media.security.test.js`; navegador real sin violaciones (`npm run test:browser`) |
| Cabeceras HTTP de seguridad | `baseSecurityHeaders` en toda respuesta; HSTS en producción | `tests/integration/server.test.js` |
| Validación estricta de entrada | `utils/validation.js` (campos desconocidos rechazados), parámetros de ruta solo numéricos, límites de cuerpo en cada lectura | `tests/unit/router-validation.test.js`, pruebas de cada módulo, `routes.security.test.js` (cuerpos enormes) |
| Permisos en el backend | Autorizador central `can`/`canView` y rol por ruta; el navegador no decide nada | `tests/security/authorization.security.test.js`, `routes.security.test.js` (inventario completo) |
| Validación real de archivos | Firma, estructura y tipo reales; sin metadatos; PDF sin contenido activo | `tests/unit/media-inspect.test.js`, `tests/security/media.security.test.js` |
| Auditoría de operaciones críticas | Registro inmodificable con cadena de huellas (D-059) | `tests/integration/audit.test.js`, `lifecycle.test.js` |
| Revocación de sesiones | Al suspender, desactivar o cambiar la contraseña, a petición y al restaurar | `tests/integration/users.test.js`, `backups.test.js`, `lifecycle.test.js` |
| HTTPS obligatorio en producción | `APP_BASE_URL` https obligatoria; proxy con redirección (D-065); escucha local comprobada por `npm run check` | `tests/unit/config.test.js`, `deploy-config.test.js`, `tests/integration/processes.test.js` |
| Sin tokens en `localStorage` | Cookie `HttpOnly`; CSRF en memoria | prueba que revisa todos los archivos del panel (`tests/security/media.security.test.js`) |
| Sin secretos en el frontend, el repositorio ni los registros | Redacción en registro y auditoría; `.gitignore`; la aplicación no necesita secretos | `tests/unit/logger.test.js`, `maintenance.security.test.js` |
| Sin código ejecutable de los administradores | Cuerpo por lista blanca, plantillas del sistema, configuración en texto plano | `contents.security.test.js`, `maintenance.test.js` |
| Sin puertas traseras | El `general_admin` pasa por las mismas comprobaciones; su cuenta solo se gestiona por línea de órdenes; no hay rutas ocultas | `routes.security.test.js` (inventario) |
| Archivos: nombres aleatorios, fuera de lo público, sin BLOB, no se borran en uso | `modules/media`, triggers de las migraciones 006 y 008 | `tests/integration/media.test.js`, `maintenance.test.js` |

## Implementado (Bloques 01–12)

| Medida | Dónde | Verificación |
| --- | --- | --- |
| Validación estricta de configuración; el servidor no arranca si es inválida | `backend/config/index.js` | `tests/unit/config.test.js` |
| `https` obligatorio en `APP_BASE_URL` en producción; sin credenciales en la URL | `backend/config/index.js` | idem |
| Escucha por defecto solo en `127.0.0.1` | `backend/config/index.js` | idem |
| Cabeceras de seguridad en toda respuesta: CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, COOP, CORP, `Permissions-Policy`, `Cache-Control: no-store` | `backend/app.js` | `tests/integration/server.test.js` |
| HSTS solo en producción | `backend/app.js` | idem |
| Sin cabeceras `Server` / `X-Powered-By` | `backend/app.js` | idem |
| Errores genéricos (sin stack ni detalles internos) al cliente | `backend/app.js` | idem |
| Timeouts de cabeceras/petición/keep-alive frente a clientes lentos | `backend/app.js` | revisión de código |
| Logger con redacción de claves sensibles (password, token, cookie, session, authorization, secret, api key, csrf, hash); sin stack en producción | `backend/utils/logger.js` | `tests/unit/logger.test.js` |
| Secretos y datos de ejecución excluidos de Git (`.env*`, claves, `storage/`, bases SQLite) | `.gitignore` | revisión |
| `.env.example` sin secretos reales | `.env.example` | revisión |
| `"private": true` en `package.json` | `package.json` | revisión |
| Sin dependencias de terceros | `package.json` | `npm ls` |
| Rutas de base de datos y `storage/` fuera de `frontend/`; `:memory:` prohibido en producción | `backend/config/index.js` | `tests/unit/config.test.js` |
| SQLite endurecido: FK activas y verificadas, `trusted_schema=OFF`, modo defensivo, extensiones deshabilitadas | `backend/database/connection.js` | `tests/integration/database.test.js` |
| Migraciones con checksum: una migración aplicada y luego modificada impide arrancar | `backend/database/migrator.js` | `tests/unit/migrator.test.js` |
| Un único `general_admin` (estructural), rol inmutable, `general_admin` siempre activo, usuarios sin borrado físico | migración 001 | `tests/integration/schema.test.js` |
| Solo hashes Argon2id (PHC) en `users.password_hash`; sesiones solo con hash de 32 bytes | migración 001 | idem |
| Asignaciones y permisos solo concedidos por `general_admin` y solo sobre secciones asignadas | migración 001 | idem |
| Versiones enviadas a revisión inmutables; revisiones ligadas a una versión `pending_review` y de solo inserción | migración 001 | idem |
| Auditoría de solo inserción (sin `UPDATE`/`DELETE`) | migración 001 | idem |
| `storage_key` de multimedia sin rutas ni separadores (sin path traversal); archivos referenciados no borrables | migración 001 | idem |
| Presentaciones (catálogo con FK) y flujos de sección limitados a valores del sistema, sin plantillas ni código | migraciones 001 y 003 | idem |
| Argon2id nativo (64 MiB, t=3, p=4, PHC), comprobado con el vector de RFC 9106; parámetros almacenados acotados; concurrencia limitada (503 al saturarse) | `modules/auth/password.js` | `tests/unit/password.test.js` |
| Política de contraseñas de 12 a 128 caracteres (NIST), normalización NFC | idem | idem |
| Sesiones opacas de 256 bits; solo el hash SHA-256 en la base; caducidad máxima e inactividad; revocación; usuario no activo ⇒ sesión inválida | `modules/auth/sessions.js` | `tests/unit/sessions.test.js`, `tests/security/` |
| Cookie `HttpOnly`, `SameSite=Strict`, `Secure` y prefijo `__Host-` con https; nunca en el cuerpo ni en `localStorage` | `modules/auth/index.js` | `tests/integration/auth.test.js` |
| Protección contra fijación de sesión (token nuevo en cada login y revocación de la sesión previa) | idem | `tests/security/auth.security.test.js` |
| CSRF: origen o `Sec-Fetch-Site` en todo método que modifica estado (también el login) + `X-CSRF-Token` ligado a la sesión | `app.js`, `middleware/http.js` | `tests/integration/auth.test.js`, `tests/unit/http.test.js` |
| Límite de intentos (usuario+IP, IP, usuario); sin bloqueo permanente; `X-Forwarded-For` solo con `TRUST_PROXY` | `modules/auth/rate-limiter.js`, `index.js` | `tests/security/` |
| Sin enumeración de usuarios: mismo 401 y Argon2 ejecutado siempre | `modules/auth/index.js` | idem |
| Cuerpos JSON con `Content-Type` obligatorio y tamaño limitado | `middleware/http.js` | `tests/unit/http.test.js` |
| Auditoría de login (éxito y fallo, sin guardar usuarios inexistentes), logout, alta y recuperación del `general_admin` | `modules/audit/audit.js` | `tests/integration/` |
| `general_admin` solo por consola, con contraseña oculta y nunca como argumento | `scripts/admin.js` | `tests/integration/admin-cli.test.js` |
| Autorizador único por sección que relee rol y estado de la base (nunca del cliente) | `modules/permissions/authorizer.js` | `tests/unit/authorizer.test.js` |
| Administración de usuarios y permisos solo para `general_admin`; denegaciones auditadas (`access.denied`) | `app.js`, `modules/users`, `modules/permissions` | `tests/security/authorization.security.test.js` |
| Validación estricta: campos desconocidos rechazados (sin asignación masiva de `role`/`status`), parámetros de ruta solo numéricos | `utils/validation.js`, `middleware/router.js` | `tests/unit/router-validation.test.js` |
| `general_admin` no gestionable por la API (`target_protected`); rol y usuario inmutables; `disabled` final | `modules/users`, migración 002 | `tests/integration/users.test.js`, `schema.test.js` |
| Contraseña temporal con cambio obligatorio antes de operar; cambio de la propia contraseña con la actual, límite de intentos y revocación de las demás sesiones | `modules/auth/index.js`, `app.js` | `tests/security/authorization.security.test.js` |
| Suspender, desactivar o restablecer la contraseña revoca las sesiones | `modules/users/index.js` | idem |
| Administración de secciones solo para `general_admin` (denegaciones auditadas); un `section_admin` solo ve sus secciones asignadas (el resto, `404`) | `modules/sections` | `tests/security/sections.security.test.js` |
| Slugs sin caracteres de ruta ni HTML; prefijos del sistema reservados en la raíz; jerarquía acotada y sin ciclos | `modules/sections/slug.js`, migraciones 001 y 003 | idem, `tests/unit/sections-slug.test.js` |
| Las secciones del sistema no se borran ni se archivan; las secciones en uso no se borran | migración 003, `modules/sections` | `tests/integration/sections.test.js` |
| Una clave `__proto__` en el cuerpo se rechaza como campo desconocido | `utils/validation.js` | `tests/unit/sections-slug.test.js` |
| Contenidos: autorizador en cada operación (ver con asignación; crear, editar y eliminar con su permiso); secciones no visibles responden `404`; denegaciones auditadas con el permiso que faltaba | `modules/contents`, `modules/permissions/authorizer.js` | `tests/security/contents.security.test.js`, `tests/unit/authorizer.test.js` |
| Cuerpo Tiptap validado con lista blanca estricta de nodos, marcas y atributos; se rechaza (no se corrige) lo no admitido; sin HTML en el documento | `modules/contents/body.js` | `tests/unit/contents-body.test.js` |
| Enlaces solo `http(s)`, `mailto`, rutas propias y anclas (`javascript:`, `data:`, `//`, credenciales rechazados) | idem | idem |
| Límites de profundidad, nodos, texto y tamaño del cuerpo; petición acotada | idem, `modules/contents/index.js` | idem, `tests/integration/contents.test.js` |
| Sin asignación masiva de estado, autoría, sección ni punteros de publicación | `modules/contents` | `tests/security/contents.security.test.js` |
| La versión publicada nunca se sobrescribe; borradores con control de concurrencia optimista | migraciones 001 y 004, `modules/contents` | `tests/integration/contents.test.js` |
| Contenidos sin borrado físico ni cambio de sección; secciones archivadas de solo lectura | migración 004 | `tests/integration/schema.test.js` |
| Solo el `general_admin` aprueba o solicita cambios (ruta, y trigger de la base); denegaciones auditadas | `modules/editorial`, migraciones 001 y 005 | `tests/security/editorial.security.test.js` |
| En secciones `approval` nada se publica sin aprobación, tampoco escribiendo en la base por otra vía; la aprobación queda ligada a la versión exacta, que es inmutable | `modules/editorial`, migración 005 | idem, `tests/integration/editorial.test.js`, `schema.test.js` |
| Transiciones con su permiso por sección (`content.submit`, `content.publish`, `content.unpublish`, `content.archive`); secciones no visibles responden `404` | `modules/editorial` | `tests/security/editorial.security.test.js` |
| Solo transiciones válidas entre estados; estado releído y condicionado en la transacción | migración 005, `modules/editorial/repository.js` | `tests/integration/schema.test.js`, `editorial.test.js` |
| El cuerpo se vuelve a validar antes de enviar y de publicar | `modules/editorial` | `tests/integration/editorial.test.js` |
| Sin asignación masiva de estado, decisión, revisor ni autoría en las transiciones | idem | `tests/security/editorial.security.test.js` |
| Subidas: permiso `media.upload` por sección, solo PNG/JPEG/WebP/PDF (sin SVG), extensión acorde al tipo, contenido real verificado recorriendo la estructura del formato, límites de tamaño (`MEDIA_MAX_BYTES`) y de píxeles | `modules/media` | `tests/unit/media-inspect.test.js`, `tests/security/media.security.test.js` |
| Archivos con clave aleatoria de 128 bits, fuera de lo público, escritura atómica; el nombre original es solo un dato (rutas y controles rechazados) | `modules/media/storage.js`, `index.js` | `tests/integration/media.test.js`, `tests/unit/media-names.test.js` |
| Metadatos eliminados (EXIF/GPS, XMP, IPTC, comentarios) y datos tras el final del formato (políglotas) | `modules/media/inspect.js` | `tests/unit/media-inspect.test.js` |
| PDF sin contenido activo (JavaScript, Launch, incrustados, XFA…), también en flujos comprimidos, con límite de descompresión | idem | idem |
| Sin ejecución al servir: MIME de la base, `nosniff`, CSP `sandbox`, PDF como descarga, `no-store`; `storage/` no tiene ruta | `modules/media/index.js` | `tests/integration/media.test.js`, `tests/security/media.security.test.js` |
| No se eliminan archivos en uso (borrador, revisión, aprobado, publicado); referencias solo de la propia sección; nada se envía ni publica con archivos eliminados | `modules/media`, migración 006 | `tests/integration/media.test.js`, `schema.test.js` |
| Imágenes del cuerpo solo de la biblioteca (`mediaId`, sin URL libre) | `modules/contents/body.js` | `tests/unit/contents-body.test.js` |
| Renderizado con tabla cerrada de nodos, escapado contextual, sin `style` ni manejadores, `rel=noopener` con `_blank` | `modules/contents/render.js` | `tests/unit/contents-render.test.js` |
| Panel: CSP sin nada en línea, sin marcos ni objetos; archivos de una lista cerrada (sin path traversal ni ocultos); token CSRF solo en memoria, nada en `localStorage`; datos insertados como texto | `middleware/static.js`, `frontend/admin/` | `tests/security/media.security.test.js`, `tests/unit/static.test.js`; navegador real sin violaciones de CSP |
| Sitio público: solo lo publicado (secciones activas con ancestros activos, versión publicada) y `404` idéntico al de lo inexistente; archivos públicos solo si los usa un contenido publicado y visible | `modules/public` | `tests/integration/public-site.test.js`, `tests/security/public.security.test.js` |
| Sitio público sin JavaScript: plantillas del sistema con escapado contextual, CSP sin scripts (también en los `304`); una sola cookie, de preferencia de modo (`HttpOnly`, `SameSite=Lax`, sin datos personales) | `modules/public/views.js`, `index.js` | idem; navegador real sin violaciones de CSP |
| Rutas públicas validadas por segmentos (sin path traversal); la barra final y las redirecciones solo llevan a rutas propias (sin redirección abierta) | `modules/public/index.js` | `tests/security/public.security.test.js` |
| Paletas: solo colores `#rrggbb` validados, nunca CSS libre; solo ids del catálogo en la API; contraste WCAG AA obligatorio (si no, el servidor no arranca); la vuelta del selector de modo solo admite páginas públicas (sin redirección abierta); el panel pinta las muestras sin atributos `style` | `modules/themes`, `modules/settings`, `modules/public/index.js` | `tests/unit/themes.test.js`, `tests/integration/themes.test.js`; navegador real sin violaciones de CSP |
| Contenidos y subsecciones no comparten URL; redirecciones registradas por la base | migración 007 | `tests/integration/schema.test.js`, `sections.test.js` |
| Auditoría inmodificable (sin rutas de escritura, triggers) y verificable: cadena de huellas SHA-256 con anclas en las copias | `modules/audit`, migración 008 | `tests/integration/audit.test.js`, `backups.test.js` |
| Copias de seguridad coherentes (API de backup de SQLite), con manifiesto y huellas; verificación completa; rutas del manifiesto validadas; sin enlaces simbólicos | `modules/backups/service.js` | `tests/integration/backups.test.js`, `tests/security/maintenance.security.test.js` |
| Restauración solo con el servidor detenido (bloqueo), de copias verificadas y de esquema compatible, con copia previa, revocación de sesiones y auditoría | `modules/backups/restore.js`, `server.js` | `tests/integration/backups.test.js`; prueba con el servidor real |
| Purga de archivos en dos pasos, revalidada y nunca de archivos en uso (también por trigger) | `modules/media/purge.js`, migración 008 | `tests/integration/maintenance.test.js` |
| Auditoría, copias, purga y configuración solo para `general_admin`; mismo origen y CSRF en las que modifican estado | rutas de cada módulo | `tests/security/maintenance.security.test.js` |
| Límite general de peticiones por IP (todas y escrituras), con `Retry-After` y un aviso por ventana en el registro | `backend/app.js` | `tests/security/routes.security.test.js` |
| Inventario de rutas revisado: solo las públicas sin sesión, rol o autorización por sección en el resto, CSRF y origen en toda escritura, ninguna espera un cuerpo por encima de su límite | `middleware/router.js`, `app.js` | `tests/security/routes.security.test.js` |
| Errores fatales registrados, con cierre del proceso para que el supervisor lo reinicie | `backend/server.js` | `tests/integration/processes.test.js` (arranque y bloqueo) |
| Despliegue: HTTPS en el proxy, escucha local, servicio sin privilegios y endurecido, copias externas cifradas | `deploy/`, `scripts/check-env.js` | `tests/unit/deploy-config.test.js`, `processes.test.js` |
| Dependencias del editor fijadas, con más de dos semanas de antigüedad, solo de desarrollo; bundle local (sin CDN) verificado contra ellas | `package.json`, `scripts/build-editor.js` | `tests/unit/editor-schema.test.js` |

## Planificado

Nada: todas las medidas previstas están implementadas. Las limitaciones conocidas están en [README.md](../README.md#limitaciones-conocidas).

## Principios

- Nunca confiar en datos ni permisos enviados por el navegador.
- Nunca almacenar tokens de autenticación en `localStorage`.
- Nunca registrar ni exponer contraseñas, tokens, secretos o claves.
- Sin puertas traseras ni accesos ocultos, tampoco para `general_admin`.
- Los administradores no pueden introducir código ejecutable en contenidos, plantillas o configuración.

## Reporte de vulnerabilidades

Notificar de forma privada al responsable del repositorio; no abrir issues públicos con detalles explotables.
