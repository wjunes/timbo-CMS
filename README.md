# CMS-MULTISECCION

CMS web de sitio único con múltiples secciones independientes, administración centralizada (`general_admin`) y administradores delegados por sección, con flujo editorial, versionado y gestión multimedia.

> **Estado actual:** Bloques 01–11 aprobados: el desarrollo previsto está completo. Siguiente paso: despliegue en producción (ver [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
> Hay base de datos, autenticación y API de usuarios, permisos, secciones, contenidos con versionado y flujo editorial (revisión, aprobación y publicación); además, multimedia con validación real de archivos y el núcleo del panel de administración (`/admin/`) con el editor Tiptap. También hay sitio público (HTML generado en el servidor, sin JavaScript) que muestra solo lo publicado. Ver [docs/ROADMAP.md](docs/ROADMAP.md).

## Requisitos

- Node.js **24.7** o superior, rama 24 LTS (`node --version`); se requiere `crypto.argon2`.
- npm 10+.
- Sin dependencias externas en esta fase.

## Instalación

```bash
npm install            # solo dependencias de desarrollo (Tiptap y esbuild, para regenerar el editor y sus pruebas).
                       # El servidor no tiene dependencias de ejecución: en producción basta con `npm ci --omit=dev`.
cp .env.example .env   # opcional en desarrollo
npm run db:migrate     # crea/actualiza la base de datos (obligatorio antes de arrancar)
npm run admin:create   # crea la cuenta general_admin (contraseña oculta; solo una vez)
npm run check          # verifica Node.js, APIs nativas, configuración y estado de la BD
```

## Ejecución

| Script | Descripción |
| --- | --- |
| `npm start` | Inicia el servidor (carga `.env` si existe). |
| `npm run dev` | Inicia con recarga automática al cambiar `backend/`. |
| `npm run check` | Verifica el entorno, la configuración y el estado de la base de datos. |
| `npm run db:migrate` | Aplica las migraciones pendientes. |
| `npm run db:status` | Muestra migraciones aplicadas y pendientes (no modifica nada). |
| `npm run admin:create` | Crea el administrador general (falla si ya existe). |
| `npm run backup:create` | Crea una copia de seguridad (también con el servidor en marcha). |
| `npm run backup:list` / `npm run backup:verify -- <id>` | Lista o verifica las copias. |
| `npm run backup:verify-dir -- <ruta>` | Verifica una copia en cualquier ruta (p. ej. recuperada de fuera del servidor). |
| `npm run backup:prune` | Aplica la retención a las copias automáticas. |
| `npm run backup:restore -- <id> --confirm` | Restaura una copia **con el servidor detenido** (ver [docs/BACKUPS.md](docs/BACKUPS.md)). |
| `npm run build:editor` | Regenera el bundle del editor (`frontend/admin/assets/editor.bundle.js`, versionado) tras cambiar Tiptap o `frontend/components/editor/`. |
| `npm run admin:reset-password` | Cambia la contraseña del administrador general y revoca sus sesiones. |
| `npm run test:security` | Ejecuta las pruebas de seguridad. |
| `npm run test:coverage` | Ejecuta todas las pruebas con informe de cobertura. |
| `npm run test:browser` | Prueba en Chrome sin interfaz: sitio público y panel (necesita Chrome; `CHROME_PATH` si no está en la ruta habitual). |
| `npm run bench` | Medida de rendimiento orientativa con una base temporal. |
| `npm test` | Ejecuta todas las pruebas (`node:test`). |
| `npm run test:unit` / `npm run test:integration` | Ejecuta un subconjunto. |

Con la configuración por defecto el servidor escucha en `http://127.0.0.1:3000`.
Endpoints: `GET /health`, la API de autenticación (`/api/auth/*`, ver [docs/AUTH.md](docs/AUTH.md)), la de administración de usuarios y permisos (`/api/users`, `/api/permissions`, ver [docs/USERS.md](docs/USERS.md)) la de secciones (`/api/sections`, `/api/section-types`, `/api/presentations`, ver [docs/SECTIONS.md](docs/SECTIONS.md)) la de contenidos y versiones (`/api/sections/:id/contents`, `/api/contents`, ver [docs/CONTENTS.md](docs/CONTENTS.md)), la del flujo editorial (transiciones en `/api/contents/:id/…`, `/api/reviews/pending`, ver [docs/EDITORIAL.md](docs/EDITORIAL.md)) la multimedia (`/api/sections/:id/media`, `/api/media`, ver [docs/MEDIA.md](docs/MEDIA.md)), y la de auditoría, copias y configuración (`/api/audit`, `/api/backups`, `/api/settings`, ver [docs/AUDIT.md](docs/AUDIT.md) y [docs/BACKUPS.md](docs/BACKUPS.md)). El panel está en `/admin/` y el sitio público en `/` (ver [docs/PUBLIC.md](docs/PUBLIC.md)).
El servidor **no arranca** si la base de datos no existe o tiene migraciones pendientes: ejecute antes `npm run db:migrate`.

## Configuración

Variables admitidas (ver [.env.example](.env.example)):

| Variable | Defecto | Notas |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` o `production`. |
| `HOST` | `127.0.0.1` | Interfaz de escucha. |
| `PORT` | `3000` | 1–65535. |
| `APP_BASE_URL` | derivada | Obligatoria y `https` en producción. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. |
| `DATABASE_PATH` | `database/cms.db` | Relativa a la raíz del proyecto o absoluta. Disco local (no OneDrive/red). Fuera de `frontend/`. `:memory:` solo fuera de producción. |
| `STORAGE_DIR` | `storage` | Archivos subidos, privados y copias de seguridad. Fuera de `frontend/`. |
| `MEDIA_MAX_BYTES` | `10485760` | Tamaño máximo de cada archivo subido (1 KiB–50 MiB). |
| `SESSION_TTL_HOURS` | `8` | Duración máxima de la sesión (1–72). |
| `SESSION_IDLE_MINUTES` | `30` | Cierre por inactividad (5–1440, no mayor que la duración máxima). |
| `BACKUP_INTERVAL_HOURS` | `24` | Copias automáticas cada N horas (0–720; 0 las desactiva). |
| `BACKUP_KEEP` | `14` | Copias automáticas que se conservan (1–365). Las manuales no se borran solas. |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `1200` | Peticiones por minuto e IP (60–100000). |
| `RATE_LIMIT_WRITES_PER_MINUTE` | `120` | Escrituras por minuto e IP (10–10000). |
| `TRUST_PROXY` | `false` | `true` solo detrás de un proxy inverso propio que sobrescriba `X-Forwarded-For`. |

Si la configuración es inválida, el servidor no arranca e informa de todos los problemas.

## Documentación

- [Guía de uso del panel](docs/MANUAL.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Base de datos](docs/DATABASE.md)
- [Autenticación y sesiones](docs/AUTH.md)
- [Usuarios, roles y permisos](docs/USERS.md)
- [Secciones](docs/SECTIONS.md)
- [Contenidos y versionado](docs/CONTENTS.md)
- [Flujos editoriales y aprobaciones](docs/EDITORIAL.md)
- [Editor, multimedia y panel](docs/MEDIA.md)
- [Sitio público](docs/PUBLIC.md)
- [Auditoría](docs/AUDIT.md)
- [Copias de seguridad y restauración](docs/BACKUPS.md)
- [Despliegue](docs/DEPLOYMENT.md)
- [Hoja de ruta](docs/ROADMAP.md)
- [Decisiones técnicas](docs/DECISIONS.md)
- [Seguridad](docs/SECURITY.md)

## Producción

Ver [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Linux con Caddy (HTTPS automático) y `systemd`, configuraciones de ejemplo en [`deploy/`](deploy/), comprobación con `NODE_ENV=production npm run check` y copias fuera del servidor con restic.

## Limitaciones conocidas

- **Un solo proceso:** SQLite con un único escritor, límites de peticiones en memoria y bloqueo de archivo. No admite varias instancias a la vez (D-019).
- **Auditoría y copias:** la huella de la auditoría no lleva clave; quien pueda escribir en la base y en las copias puede reescribirlas. Por eso las copias se guardan también fuera del servidor ([AUDIT.md](docs/AUDIT.md)).
- **Restauración:** solo por línea de órdenes, con el servidor detenido, y de todo o nada ([BACKUPS.md](docs/BACKUPS.md)).
- **Contenidos eliminados:** no se consultan ni se restauran desde el panel; se recuperan con una copia (D-063).
- **Sin paginar:** la biblioteca multimedia y los contenidos de una sección en el panel ([MEDIA.md](docs/MEDIA.md)).
- **Sitio público:**
  - fechas en la zona horaria del servidor;
  - sin búsqueda ni RSS, porque no están en la especificación ([PUBLIC.md](docs/PUBLIC.md)).
- **Despliegue sin probar en un servidor real:** las configuraciones de `deploy/` se validan en la puesta en marcha (D-065).

## Licencia

[MIT](LICENSE)
