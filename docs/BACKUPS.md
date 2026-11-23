# Copias de seguridad y restauración

Implementado en el Bloque 10. Código en [`backend/modules/backups/`](../backend/modules/backups/) y [`scripts/backup.js`](../scripts/backup.js). Decisiones D-060 y D-063.

## Contenido de una copia

Cada copia es un directorio `STORAGE_DIR/backups/<id>/`. El id es la fecha UTC en formato `AAAAMMDDhhmmss`; si coinciden dos en el mismo segundo, el segundo id avanza.

| Archivo | Contenido |
| --- | --- |
| `database.sqlite` | Copia coherente de la base hecha con la API de backup de SQLite, en un solo archivo (sin `-wal`). Nunca se copia el archivo en uso. |
| `media/<clave>` | Los archivos multimedia que figuran en esa copia de la base, excepto los purgados |
| `private/…` | El directorio privado, si existe. Los enlaces simbólicos y los nombres no admitidos no se copian y quedan como aviso. |
| `manifest.json` | Formato y versión, id, fecha, tipo (`manual`, `automatic` o `pre_restore`), autor, versión de la aplicación, migraciones del esquema con su checksum, última huella de la auditoría, y tamaño y SHA-256 de cada archivo |

- **Escritura atómica:** la copia se escribe en un directorio temporal, se verifica entera y solo entonces se renombra. Una copia interrumpida nunca aparece en la lista; sus restos se borran en la siguiente copia.
- **Una sola a la vez:** un bloqueo en `backups/.lock` impide dos copias simultáneas, también entre el servidor y la línea de órdenes. La purga de archivos usa el mismo bloqueo.
- **Archivos que faltan:** si falta el archivo de un registro de la base, la copia se hace igualmente con el aviso `media_file_missing`. El panel muestra los avisos.

## Verificación

La verificación no modifica nada y comprueba:

- que el manifiesto es válido y que todas sus rutas tienen la forma admitida (`database.sqlite`, `media/<clave>` o `private/…`, sin `..` ni rutas absolutas);
- el tamaño y el SHA-256 de cada archivo, y que no falta ni sobra ninguno;
- la base copiada:
  - `integrity_check` y `foreign_key_check`;
  - sus migraciones y su última huella de auditoría coinciden con las del manifiesto;
  - todos sus archivos multimedia están en la copia.

La base copiada se abre en solo lectura y con `trusted_schema=OFF`.

## Copias automáticas y retención

- **Automáticas:** el servidor comprueba cada 15 minutos (la primera vez, 1 minuto después de arrancar) si la última copia automática tiene más de `BACKUP_INTERVAL_HOURS` horas (24 por defecto). Si es así, crea una. Reiniciar el servidor no provoca copias de más.
- **Retención:** tras cada copia automática se conservan las `BACKUP_KEEP` automáticas más recientes (14 por defecto). Las manuales y las `pre_restore` solo se borran a mano.
- **Desactivarlas:** `BACKUP_INTERVAL_HOURS=0`. También se pueden programar con el programador del sistema: `npm run backup:create` y `npm run backup:prune`.

## Línea de órdenes

| Orden | Qué hace |
| --- | --- |
| `npm run backup:create` | Crea una copia manual. Funciona con el servidor en marcha. |
| `npm run backup:list` | Lista las copias. |
| `npm run backup:verify -- <id>` | Verifica una copia (código de salida 1 si no la supera). |
| `npm run backup:verify-dir -- <ruta>` | Verifica una copia en cualquier ruta, por ejemplo recuperada de fuera del servidor. |
| `npm run backup:prune` | Aplica la retención. |
| `npm run backup:restore -- <id> --confirm` | Restaura una copia, con el servidor detenido. |

## API

Todas exigen sesión de `general_admin` y, para escribir, `X-CSRF-Token`. El `<id>` son los 14 dígitos de la copia; cualquier otro valor responde `404`.

| Método y ruta | Respuesta |
| --- | --- |
| `GET /api/backups` | `200 { backups, schedule: { intervalHours, keep }, running }`. Cada copia: `id`, `createdAt`, `kind`, `createdBy`, `appVersion`, `schemaVersion`, `fileCount`, `mediaCount`, `sizeBytes`, `auditHead` y `warnings`. Las que tienen el manifiesto ilegible aparecen como `{ id, broken: true }`. |
| `POST /api/backups` | `201 { backup }`: crea y verifica una copia manual. `409 backup_in_progress` si hay otra en curso o una purga. |
| `GET /api/backups/<id>` | `200 { backup }` · `404 backup_not_found` |
| `POST /api/backups/<id>/verify` | `200 { ok, issues }`. Cada problema tiene `code` (`file_corrupt`, `file_missing`, `unexpected_file`, `manifest_invalid`, `database_corrupt`…) y, si aplica, `path` o `mediaId`. Se audita (`backup.verify`). |
| `DELETE /api/backups/<id>` | `204` · `404 backup_not_found`. Se audita (`backup.delete`). |

La API no ofrece rutas para restaurar ni para descargar copias (D-060). Ninguna respuesta incluye rutas del servidor ni el contenido de los archivos.

## Restauración controlada (D-060)

Solo se hace desde la línea de órdenes y con el servidor detenido. Mientras el servidor está en marcha mantiene el bloqueo `STORAGE_DIR/cms.lock`, y la restauración lo toma también: el servidor no puede arrancar a mitad de una restauración. Un bloqueo de un proceso que ya no existe se considera abandonado y se reemplaza.

1. Verifica la copia entera. Si no la supera, no toca nada.
2. **Esquema:** las migraciones de la copia deben coincidir, con el mismo checksum, con las primeras del código. Una copia de un esquema más nuevo se rechaza (`schema_newer`) y una de uno distinto también (`schema_mismatch`).
3. Crea una copia `pre_restore` del estado actual.
4. Prepara la base y los directorios al lado de los actuales y los intercambia con renombrados. Si un renombrado falla, deshace los anteriores.
5. Aplica las migraciones pendientes y revoca todas las sesiones restauradas.
6. Registra `backup.restore` en la auditoría de la base restaurada. Un fallo se registra en la base que haya quedado en su sitio.

**Consecuencias:**

- Lo ocurrido entre la copia y la restauración, también la auditoría, solo queda en la copia `pre_restore`.
- Todas las sesiones se cierran.

## Seguridad

- **Acceso:** solo `general_admin`. El panel lista, crea, verifica y elimina copias; no las restaura ni las descarga, porque contienen los hashes de las contraseñas.
- **Rutas:** `STORAGE_DIR` está fuera de lo público, y ninguna ruta HTTP sirve `backups/` ni `cms.lock`. Los ids se validan como 14 dígitos.
- **Archivos y permisos:** en sistemas POSIX los directorios se crean con modo `0700` y el manifiesto con `0600`. En Windows rigen los permisos de la carpeta.
- **Copias manipuladas:** la verificación detecta cambios accidentales o parciales. Quien pueda escribir en `backups/` puede rehacer una copia con un manifiesto coherente, así que el directorio debe protegerse igual que la base.
- **Copias fuera del servidor:** una copia en el mismo disco no protege si ese disco se pierde. Se llevan fuera, cifradas, con restic (D-065, ver [DEPLOYMENT.md](DEPLOYMENT.md#copias-de-seguridad)). `npm run backup:verify-dir -- <ruta>` verifica una copia en cualquier ruta, sin base ni configuración.

## Limitaciones conocidas

- La copia se hace en el propio servidor. Con muchos archivos multimedia ocupa tanto como ellos, y la verificación los lee todos.
- Las copias locales no se comprimen ni se cifran; las externas las cifra restic (D-065).
- La restauración sustituye la base y los archivos enteros. No hay restauración parcial de un contenido o de un archivo.
