# Auditoría

El registro existe desde el Bloque 02 (tabla `audit_logs`, de solo inserción). En el Bloque 10 se añaden la consulta, la verificación de integridad y las operaciones que faltaban por registrar. Código en [`backend/modules/audit/`](../backend/modules/audit/).

## Qué se registra

| Ámbito | Acciones |
| --- | --- |
| Acceso | `auth.login` (correcto y fallido), `auth.logout`, `access.denied` |
| Usuarios | `user.create`, `user.update`, `user.status_change`, `user.password_reset`, `user.password_change`, `user.sessions_revoke` |
| Permisos | `permission.section_assign`, `permission.section_revoke`, `permission.set` |
| Secciones | `section.create`, `section.update`, `section.status_change`, `section.reorder`, `section.delete` |
| Contenidos | `content.create`, `content.update`, `content.delete`, `version.create`, `version.update`, `version.discard` |
| Flujo editorial | `version.submit`, `version.approve`, `version.request_changes`, `version.publish`, `content.unpublish`, `content.archive`, `content.restore` (ver [EDITORIAL.md](EDITORIAL.md)) |
| Multimedia | `media.upload`, `media.update`, `media.delete`, `media.purge` |
| Configuración | `settings.update`, con el valor anterior y el nuevo |
| Copias | `backup.create`, `backup.verify`, `backup.delete`, `backup.prune`, `backup.restore` (correctas y fallidas) |

- **Detalles:** pasan por la misma redacción que el registro de la aplicación: nunca contienen contraseñas, tokens, cookies ni hashes.
- **Sin modificación posible:** ni la API ni el panel tienen ninguna ruta que modifique o borre entradas, y la base lo impide con triggers (`audit_log_immutable`). No hay purga por antigüedad (D-063).

## Consulta

`GET /api/audit` (solo `general_admin`). De la entrada más reciente a la más antigua, 50 por página (hasta 200).

| Parámetro | Formato |
| --- | --- |
| `from`, `to` | Fecha `AAAA-MM-DD` (día completo) o instante ISO en UTC |
| `actor` | Id del usuario |
| `action` | Acción exacta (`auth.login`) o prefijo terminado en punto (`backup.`) |
| `outcome` | `success`, `failure` o `denied` |
| `entityType`, `entityId` | Entidad afectada (`entityId` exige `entityType`) |
| `section` | Id de la sección |
| `before`, `limit` | Paginación: `before` es el `nextBefore` de la página anterior |

Un parámetro desconocido, repetido o mal formado responde `400 validation_failed`.

## Integridad (D-059)

- **Cadena de huellas:** la tabla `audit_chain` (migración 008) guarda una huella por entrada, `SHA-256(huella anterior + "\n" + entrada)`. La primera huella parte de 64 ceros. La forma de la entrada es un array JSON con todas sus columnas en orden fijo.
- **Momento:** la huella se calcula en la misma transacción que la entrada. Si la entrada no se guarda, tampoco la huella.
- **Lo que garantiza la base:**
  - las huellas se añaden en orden y sin huecos (`audit_chain_order`);
  - no se modifican ni se borran.
- **Entradas anteriores a la migración 008:** se encadenan, en orden, la primera vez que se registra algo después de aplicarla.

`GET /api/audit/verify` recorre la cadena entera:

| Resultado | Significado |
| --- | --- |
| `hash_mismatch` | Una entrada se modificó, o se borró una de en medio |
| `gap` | Hay entradas sin huella antes de otras encadenadas |
| `anchor_mismatch`, `anchor_missing` | La cadena no coincide con la huella que guardó una copia de seguridad: se borraron entradas del final o se recalculó la cadena |
| `unchained` | Entradas del final todavía sin huella. Es informativo |

**Anclas:**

- Cada copia de seguridad guarda la última huella de su momento (`auditHead`). La verificación comprueba que todas siguen en la cadena.
- Después de una restauración, la historia continúa por otro camino. Por eso no cuentan las copias hechas entre la copia restaurada y la restauración, ni la del estado anterior a la restauración.

**Límite.** La huella no lleva clave. Quien pueda escribir en el archivo de la base y desactivar los triggers puede reescribir toda la cadena. Ese cambio solo se detecta comparando con las anclas de las copias, y únicamente si las copias no se manipularon también. Para resistir a alguien con ese acceso, las copias se guardan además fuera del servidor (ver [DEPLOYMENT.md](DEPLOYMENT.md#copias-de-seguridad)).

## Panel

En **Sistema → Auditoría** se consulta el registro con los mismos filtros, de 50 en 50, y se puede verificar la integridad. La pantalla es de solo lectura.
