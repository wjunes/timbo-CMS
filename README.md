# CMS-MULTISECCION

CMS web de sitio único con múltiples secciones independientes, administración centralizada (`general_admin`) y administradores delegados por sección, con flujo editorial, versionado y gestión multimedia.

> **Estado actual:** Bloque 08 (editor enriquecido y multimedia) — aprobado. Siguiente: Bloque 09 (sitio público).
> Hay base de datos, autenticación y API de usuarios, permisos, secciones, contenidos con versionado y flujo editorial (revisión, aprobación y publicación); además, multimedia con validación real de archivos y el núcleo del panel de administración (`/admin/`) con el editor Tiptap. Todavía **no** hay sitio público. Ver [docs/ROADMAP.md](docs/ROADMAP.md).

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
| `npm run build:editor` | Regenera el bundle del editor (`frontend/admin/assets/editor.bundle.js`, versionado) tras cambiar Tiptap o `frontend/components/editor/`. |
| `npm run admin:reset-password` | Cambia la contraseña del administrador general y revoca sus sesiones. |
| `npm run test:security` | Ejecuta las pruebas de seguridad. |
| `npm test` | Ejecuta todas las pruebas (`node:test`). |
| `npm run test:unit` / `npm run test:integration` | Ejecuta un subconjunto. |

Con la configuración por defecto el servidor escucha en `http://127.0.0.1:3000`.
Endpoints: `GET /health`, la API de autenticación (`/api/auth/*`, ver [docs/AUTH.md](docs/AUTH.md)), la de administración de usuarios y permisos (`/api/users`, `/api/permissions`, ver [docs/USERS.md](docs/USERS.md)) la de secciones (`/api/sections`, `/api/section-types`, `/api/presentations`, ver [docs/SECTIONS.md](docs/SECTIONS.md)) la de contenidos y versiones (`/api/sections/:id/contents`, `/api/contents`, ver [docs/CONTENTS.md](docs/CONTENTS.md)), la del flujo editorial (transiciones en `/api/contents/:id/…`, `/api/reviews/pending`, ver [docs/EDITORIAL.md](docs/EDITORIAL.md)) y la multimedia (`/api/sections/:id/media`, `/api/media`, ver [docs/MEDIA.md](docs/MEDIA.md)). El panel está en `/admin/`.
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
| `STORAGE_DIR` | `storage` | Archivos subidos y backups. Fuera de `frontend/`. |
| `MEDIA_MAX_BYTES` | `10485760` | Tamaño máximo de cada archivo subido (1 KiB–50 MiB). |
| `SESSION_TTL_HOURS` | `8` | Duración máxima de la sesión (1–72). |
| `SESSION_IDLE_MINUTES` | `30` | Cierre por inactividad (5–1440, no mayor que la duración máxima). |
| `TRUST_PROXY` | `false` | `true` solo detrás de un proxy inverso propio que sobrescriba `X-Forwarded-For`. |

Si la configuración es inválida, el servidor no arranca e informa de todos los problemas.

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Base de datos](docs/DATABASE.md)
- [Autenticación y sesiones](docs/AUTH.md)
- [Usuarios, roles y permisos](docs/USERS.md)
- [Secciones](docs/SECTIONS.md)
- [Contenidos y versionado](docs/CONTENTS.md)
- [Flujos editoriales y aprobaciones](docs/EDITORIAL.md)
- [Editor, multimedia y panel](docs/MEDIA.md)
- [Hoja de ruta](docs/ROADMAP.md)
- [Decisiones técnicas](docs/DECISIONS.md)
- [Seguridad](docs/SECURITY.md)

## Licencia

[MIT](LICENSE)
