# Usuarios, roles y permisos

Implementado en el Bloque 04. Código en [`backend/modules/users/`](../backend/modules/users/) y [`backend/modules/permissions/`](../backend/modules/permissions/).

## Roles

| Rol | Cómo se crea | Alcance |
| --- | --- | --- |
| `general_admin` | Solo por consola: `npm run admin:create` (D-018). Hay exactamente uno. | Todos los permisos en todas las secciones, por su rol. Administra usuarios y permisos. |
| `section_admin` | Lo crea el `general_admin` por la API, con contraseña temporal. | Solo las secciones asignadas y, en cada una, solo los permisos concedidos. |

El rol y el nombre de usuario no se pueden cambiar después de crear la cuenta (trigger en la base).

## Estados

```text
active ⇄ suspended
active | suspended → disabled   (final)
```

- **Suspender** o **desactivar** revoca todas las sesiones del usuario. Además, las sesiones se invalidan en cada petición si el usuario no está `active`.
- `disabled` no se puede revertir (trigger `user_disabled_terminal`). El `general_admin` siempre está `active`.

## Catálogo de permisos

Los permisos se conceden **por sección**. El catálogo es parte del sistema: añadir o retirar un permiso requiere una migración y el código que lo exige (D-022).

| Código | Permite | Se aplica en |
| --- | --- | --- |
| `content.create` | Crear contenidos y borradores | Bloque 06 |
| `content.edit` | Editar borradores de cualquier contenido de la sección | Bloque 06 |
| `content.submit` | Enviar a revisión (flujo `approval`) | Bloque 07 |
| `content.publish` | Publicar directamente (solo flujo `direct`) | Bloque 07 |
| `content.unpublish` | Despublicar | Bloque 07 |
| `content.archive` | Archivar y restaurar | Bloque 07 |
| `content.delete` | Eliminar (borrado lógico) | Bloque 06 |
| `media.upload` | Subir archivos | Bloque 08 |
| `media.delete` | Eliminar archivos no usados | Bloque 08 |

## Autorización

`createAuthorizer(db)` → `{ can(user, code, sectionId), require(user, code, sectionId) }` ([authorizer.js](../backend/modules/permissions/authorizer.js)) es el **punto único** de decisión que usarán los Bloques 05–08:

- Del objeto `user` solo usa el `id`: el rol y el estado se vuelven a leer de la base. Nunca se confía en datos del cliente.
- Un `general_admin` activo tiene todos los permisos.
- Un `section_admin` necesita estar activo, tener la sección asignada y tener el permiso concedido en ella.
- `require` lanza `403 forbidden`. Un código de permiso inexistente lanza `TypeError`, porque es un error de programación y no un «no autorizado».

Las rutas declaran el rol que exigen (`role: 'general_admin'`) y `app.js` lo comprueba antes del manejador. Si se deniega, responde `403 forbidden` y lo registra en la auditoría (`access.denied`).

## Contraseña temporal

- El alta y el restablecimiento por el `general_admin` fijan una contraseña temporal (con la misma política) y marcan `must_change_password`.
- Mientras esté pendiente, la sesión solo puede usar `GET /api/auth/session`, `POST /api/auth/password` y `POST /api/auth/logout`. El resto responde `403 password_change_required`.
- `POST /api/auth/password` exige la contraseña actual, aplica la política, no admite repetir la actual y revoca las demás sesiones del usuario (conserva la actual). Los intentos con la contraseña actual incorrecta están limitados.

## API (todas exigen `general_admin`, sesión y, para escribir, `X-CSRF-Token`)

| Método y ruta | Cuerpo | Respuesta / errores |
| --- | --- | --- |
| `GET /api/users` | — | `200 { users: [...] }` |
| `POST /api/users` | `{ username, email, displayName, temporaryPassword }` | `201 { user }` · `400 validation_failed` · `409 username_or_email_taken` |
| `GET /api/users/:id` | — | `200 { user }` · `404` |
| `PATCH /api/users/:id` | `{ displayName?, email? }` | `200 { user }` · `400` · `403 target_protected` · `409` |
| `POST /api/users/:id/suspend` · `/reactivate` · `/disable` | — | `200 { user, revokedCount }` · `409 invalid_status_transition` |
| `POST /api/users/:id/password` | `{ temporaryPassword }` | `200 { user, revokedCount }` · `409 user_disabled` |
| `POST /api/users/:id/sessions/revoke` | — | `200 { revokedCount }` |
| `GET /api/permissions` | — | `200 { permissions: [{ code, description }] }` |
| `PUT /api/users/:id/sections/:sectionId` | — | `201` (asignada) · `200` (ya lo estaba) · `404 section_not_found` · `409 user_disabled` / `section_archived` |
| `DELETE /api/users/:id/sections/:sectionId` | — | `204` · `404 assignment_not_found` (retira también sus permisos) |
| `PUT /api/users/:id/sections/:sectionId/permissions` | `{ permissions: [códigos] }` (reemplaza el conjunto) | `200 { permissions, changed }` · `409 section_not_assigned` |

- `user` = `{ id, username, email, displayName, role, status, mustChangePassword, passwordChangedAt, createdAt, updatedAt, sections: [{ id, slug, name, status, assignedAt, permissions }] }`. Nunca incluye el hash.
- **Validación estricta:** los campos desconocidos se rechazan (`unknown_field`), así que no se puede enviar, por ejemplo, `role` o `status` en un `POST`/`PATCH`. Los errores incluyen `fields: { campo: código }`.
- **El `general_admin` no se gestiona por la API:** se puede leer, pero cualquier escritura sobre él devuelve `403 target_protected`.
- Los parámetros `:id` y `:sectionId` solo admiten enteros positivos. Cualquier otro valor responde `404`.

## Auditoría

| Acción | Detalles |
| --- | --- |
| `user.create` | `{ role, username }` |
| `user.update` | `{ fields: [...] }` |
| `user.status_change` | `{ from, to, revokedCount }` |
| `user.password_reset` | `{ revokedCount, via: "api" }` (CLI: `auth.password_reset`, `via: "cli"`) |
| `user.password_change` | `success { revokedCount }` · `failure { reason: "bad_current" }` |
| `user.sessions_revoke` | `{ revokedCount }` |
| `permission.section_assign` | `section_id` |
| `permission.section_revoke` | `{ before }` |
| `permission.set` | `{ before, after, added, removed }` |
| `access.denied` | `{ method, path, requiredRole }` |

Ninguna entrada contiene contraseñas, temporales ni definitivas.
