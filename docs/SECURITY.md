# Seguridad

La seguridad forma parte del diseño desde el Bloque 01. Este documento distingue entre lo **implementado y verificado** y lo **planificado**.

## Implementado (Bloques 01–04)

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
| Presentaciones y flujos de sección limitados a valores del sistema (sin plantillas arbitrarias) | migración 001 | idem |
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

## Planificado

| Medida | Bloque |
| --- | --- |
| Consultas SQL parametrizadas en todos los repositorios (restricciones e integridad referencial: hechas en el Bloque 02) | 03+ |
| Aplicación del autorizador en secciones, contenidos y multimedia | 05–08 |
| Validación y sanitización del contenido estructurado (Tiptap) | 06–08 |
| Validación real de archivos (firma, MIME, extensión, tamaño), nombres aleatorios, sin ejecución | 08 |
| CSP específica para sitio público y panel | 08–09 |
| Registro de operaciones críticas en la auditoría (tabla de solo inserción: hecha en el Bloque 02); verificación de integridad (cadena de hashes) | 04+ / 10 |
| Backups consistentes (`node:sqlite` `backup()`), manifiesto, verificación de integridad | 10 |
| HTTPS en producción (terminación TLS / proxy inverso), revisión final | 11 |

## Principios

- Nunca confiar en datos ni permisos enviados por el navegador.
- Nunca almacenar tokens de autenticación en `localStorage`.
- Nunca registrar ni exponer contraseñas, tokens, secretos o claves.
- Sin puertas traseras ni accesos ocultos, tampoco para `general_admin`.
- Los administradores no pueden introducir código ejecutable en contenidos, plantillas o configuración.

## Reporte de vulnerabilidades

Notificar de forma privada al responsable del repositorio; no abrir issues públicos con detalles explotables.
