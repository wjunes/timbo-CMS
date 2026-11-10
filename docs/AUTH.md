# Autenticación y sesiones

Implementado en el Bloque 03. Código en [`backend/modules/auth/`](../backend/modules/auth/).

## Componentes

| Archivo | Responsabilidad |
| --- | --- |
| `modules/auth/password.js` | Argon2id nativo (formato PHC), verificación, actualización de hashes, política de contraseñas, límite de concurrencia. |
| `modules/auth/sessions.js` | Tokens, hash SHA-256, token CSRF, almacén de sesiones (crear, resolver, revocar, purgar). |
| `modules/auth/rate-limiter.js` | Limitador de intentos en memoria con número de claves acotado. |
| `modules/auth/index.js` | Login, logout, sesión actual, cookie y resolución de la sesión. |
| `modules/audit/audit.js` | Escritura en `audit_logs`, con los detalles redactados. |
| `modules/users/repository.js` | Consultas mínimas sobre `users` (el CRUD llega en el Bloque 04). |
| `middleware/http.js` | Errores HTTP, cookies, cuerpo JSON, IP del cliente y validación de origen. |
| `scripts/admin.js` | Alta y recuperación del `general_admin` por consola. |

## API

Todas las respuestas son JSON con `Cache-Control: no-store`. Los errores son genéricos, con la forma `{ "error": "<código>" }`.

| Método y ruta | Requisitos | Respuesta |
| --- | --- | --- |
| `POST /api/auth/login` | Mismo origen; cuerpo `application/json` `{ username, password }` (≤ 4 KiB) | `200 { user, access, csrfToken, expiresAt }` y cookie de sesión · `400` · `401 invalid_credentials` · `403 forbidden_origin` · `413` · `415` · `429 too_many_attempts` (`Retry-After`) · `503 service_busy` |
| `GET /api/auth/session` | Sesión | `200 { user, access, csrfToken, expiresAt }` · `401 unauthenticated` (borra la cookie si no es válida) |
| `POST /api/auth/logout` | Mismo origen, sesión y `X-CSRF-Token` | `204` y borra la cookie · `401` · `403 invalid_csrf_token` |
| `POST /api/auth/password` | Mismo origen, sesión, `X-CSRF-Token`; `{ currentPassword, newPassword }` | `200 { status, revokedCount }` · `400 validation_failed` (`policy`) · `403 invalid_current_password` · `429` (Bloque 04, ver [USERS.md](USERS.md)) |

`user` = `{ id, username, displayName, role, mustChangePassword }`. `access` = `{ scope: "all" }` para el `general_admin`, o `{ scope: "sections", sections: [{ id, slug, name, status, assignedAt, permissions }] }` para un administrador de sección. Es informativo para la interfaz: cada operación se vuelve a autorizar en el backend.

Con `mustChangePassword: true` solo se pueden usar `session`, `password` y `logout`.

## Contraseñas

- **Algoritmo:** Argon2id (`crypto.argon2`, Node ≥ 24.7) con 64 MiB, t=3, p=4, etiqueta de 32 bytes y sal aleatoria de 16 bytes. Es el perfil de RFC 9106 §4 para memoria limitada (~110 ms por cálculo). La corrección del algoritmo se comprueba con el vector oficial de RFC 9106.
- **Formato almacenado:** PHC, `$argon2id$v=19$m=65536,t=3,p=4$<sal>$<hash>`. El esquema de la base exige el prefijo `$argon2id$`.
- **Parámetros leídos de la base:** se acotan (m ≤ 256 MiB, t ≤ 10, p ≤ 16), para que un hash manipulado no provoque una denegación de servicio.
- **Actualización de hashes:** si un hash usa parámetros distintos de los vigentes, se recalcula de forma transparente en el siguiente login correcto.
- **Concurrencia:** como máximo 4 cálculos simultáneos y 64 en cola. Con la cola llena se responde `503`.
- **Política:** de 12 a 128 caracteres (NIST SP 800-63B). Sin reglas de composición; no puede contener el nombre de usuario, ser un único carácter repetido, estar formada solo por espacios ni contener caracteres de control. Se normaliza a Unicode NFC.

## Sesiones

- **Token:** 256 bits aleatorios en base64url. En la base solo se guarda su SHA-256.
- **Validez en cada petición:**
  - no revocada;
  - no caducada (`SESSION_TTL_HOURS`, 8 h por defecto);
  - no inactiva (`SESSION_IDLE_MINUTES`, 30 min por defecto; al detectarla se revoca);
  - usuario `active`. Suspender a un usuario corta sus sesiones de inmediato.
- **`last_seen_at`:** se actualiza como mucho una vez por minuto.
- **Fijación de sesión:** el login siempre emite un token nuevo y revoca la sesión válida que el cliente presentara.
- **Purga:** cada 15 min se eliminan las sesiones caducadas o revocadas hace más de 24 h.

### Cookie

| Entorno | Nombre | Atributos |
| --- | --- | --- |
| `APP_BASE_URL` https (producción) | `__Host-cms_session` | `Path=/; SameSite=Strict; Max-Age=<TTL>; HttpOnly; Secure` (sin `Domain`) |
| `APP_BASE_URL` http (desarrollo local) | `cms_session` | igual, sin `Secure` |

El token nunca viaja en el cuerpo de las respuestas ni se puede leer desde JavaScript.

## CSRF (dos capas)

1. **Origen.** Todo `POST`/`PUT`/`PATCH`/`DELETE` exige que `Origin` coincida con el origen de `APP_BASE_URL`. Si el navegador no envía `Origin`, se exige `Sec-Fetch-Site: same-origin`. Sin ninguna de las dos, se responde `403`. Esta capa protege también el login.
2. **Token.** Las rutas autenticadas que modifican datos exigen `X-CSRF-Token = HMAC-SHA256(token de sesión, "cms-csrf-v1")`. Solo lo conocen el servidor y el cliente que tiene la cookie: no hace falta un secreto de servidor ni guardar nada más. El cliente lo obtiene de `/api/auth/login` o `/api/auth/session`.

Además, la cookie es `SameSite=Strict`.

## Fuerza bruta y enumeración

Límites de intentos **fallidos** por ventana de 15 minutos, en memoria (D-019):

| Clave | Máximo | Propósito |
| --- | --- | --- |
| usuario + IP | 5 | Adivinación dirigida desde un origen. |
| IP | 30 | Barrido de muchos usuarios desde un origen. |
| usuario (todas las IP) | 50 | Ataque distribuido contra una cuenta. |

- Un intento bloqueado responde `429` con `Retry-After` y no llega a ejecutar Argon2.
- Un login correcto restablece los contadores del usuario.
- No hay bloqueo permanente de cuentas, porque permitiría bloquear al `general_admin` a propósito. Como mucho puede bloquearse durante 15 min, y solo con 50 fallos.
- **Enumeración:** usuario inexistente, contraseña incorrecta y usuario inactivo devuelven el mismo `401`. En los tres casos se ejecuta Argon2 (sobre un hash ficticio si no hay usuario activo), así que el tiempo de respuesta no distingue los casos.
- **IP del cliente:** es la del socket. `X-Forwarded-For` solo se usa con `TRUST_PROXY=true` (y entonces la entrada más a la derecha), que debe activarse únicamente detrás de un proxy propio que sobrescriba esa cabecera.

## Auditoría

| Acción | Cuándo | Detalles |
| --- | --- | --- |
| `auth.login` `success` | Login correcto | — |
| `auth.login` `failure` | Login fallido | `reason`: `unknown_user`, `bad_password` o `inactive_user`. Si el usuario no existe, no se guarda el nombre probado. |
| `auth.logout` `success` | Logout | — |
| `user.create` `success` | Alta del `general_admin` por consola | `{ role, via: "cli" }` |
| `auth.password_reset` `success` | Cambio de contraseña del `general_admin` por consola | `{ via: "cli", revokedCount }` |

Las peticiones rechazadas por origen, CSRF o límite de intentos van al logger (`warn`), no a la auditoría, para que un atacante no autenticado no pueda inflar la tabla (D-020).

## Administrador general (consola)

```bash
npm run admin:create           # crea la única cuenta general_admin (falla si ya existe)
npm run admin:reset-password   # nueva contraseña + revocación de todas sus sesiones
```

- Requieren acceso al servidor; no hay equivalente por HTTP.
- La contraseña se pide oculta y nunca se acepta como argumento.
- Sin terminal interactiva, las respuestas se leen de stdin línea a línea (automatización).
