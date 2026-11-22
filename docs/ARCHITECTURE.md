# Arquitectura

## Visión general

Monolito modular sobre Node.js 24 nativo (`node:http`, `node:sqlite`, `node:crypto`), sin frameworks de servidor ni de frontend. Un único proceso sirve:

- **Sitio público**: contenidos publicados, navegación por secciones, URLs jerárquicas.
- **Panel administrativo**: acceso autenticado para `general_admin` y administradores de sección.

Toda autorización se decide en el backend.

## Estado implementado (Bloques 01–09)

```text
backend/
  config/index.js     Carga y validación de configuración (función pura, falla rápido)
  utils/logger.js     Logger JSON por línea con redacción de claves sensibles
  utils/validation.js Validación estricta de cuerpos JSON (campos desconocidos rechazados)
  middleware/http.js  Errores HTTP, cookies, cuerpo JSON, IP del cliente, validación de origen
  middleware/router.js  Enrutador: rutas exactas y parámetros numéricos (:id)
  middleware/static.js  Archivos estáticos desde una lista cerrada: panel (/admin/) y recursos públicos (/assets/)
  modules/
    auth/             Contraseñas (Argon2id), sesiones, límite de intentos, rutas /api/auth/* (ver docs/AUTH.md)
    audit/audit.js    Escritura en audit_logs (detalles redactados)
    users/            Repositorio y API de administración de usuarios (ver docs/USERS.md)
    permissions/      Repositorio, autorizador único (can/canView/require) y API de asignación de secciones y permisos
    sections/         Repositorio, slugs y API de administración de secciones (ver docs/SECTIONS.md)
    contents/         Repositorio, validación del cuerpo Tiptap, renderizado seguro, vista previa y API de contenidos y versiones (ver docs/CONTENTS.md)
    editorial/        Transiciones editoriales, revisiones y cola de revisión (ver docs/EDITORIAL.md)
    media/            Verificación de archivos, almacenamiento, biblioteca y referencias desde el cuerpo (ver docs/MEDIA.md)
    public/           Sitio público: rutas, visibilidad, plantillas HTML, archivos públicos y sitemap (ver docs/PUBLIC.md)
  database/
    connection.js     Apertura segura de SQLite (WAL, FK, defensivo, busy_timeout)
    transaction.js    withTransaction: BEGIN IMMEDIATE / SAVEPOINT anidado
    migrator.js       Migraciones versionadas con checksum, solo hacia delante
    errors.js         Clasificación de errores de SQLite (UNIQUE, triggers)
    migrations/       001_initial_schema.sql, 002_users_permissions.sql, 003_sections.sql, 004_contents.sql, 005_editorial.sql, 006_media.sql, 007_public_site.sql (ver docs/DATABASE.md)
  app.js              Servidor HTTP (sin arrancarlo): cabeceras, enrutado, origen, sesión, CSRF, errores
  server.js           Punto de entrada: config → logger → BD + esquema al día → listen → cierre ordenado
scripts/
  check-env.js        Verificación de entorno (Node, node:sqlite, node:crypto, configuración, estado de la BD)
  db.js               CLI: migrate | status
  admin.js            CLI: create | reset-password del general_admin
  build-editor.js     Empaqueta el editor (esbuild); --check verifica el bundle versionado
frontend/
  components/editor/  Configuración de Tiptap (fuente del bundle; no se sirve)
  admin/              Panel servido en /admin/: index.html, js/ (módulos ES sin frameworks), assets/ (CSS, editor.bundle.js)
  public/assets/      Hoja de estilos del sitio público, servida en /assets/
storage/media/        Archivos subidos (STORAGE_DIR), no versionado ni servido directamente
database/             cms.db (+ -wal/-shm) en tiempo de ejecución, no versionado
tests/
  helpers/            utilidades compartidas (BD en memoria migrada, datos de ejemplo)
  helpers/http.js     aplicación completa en puerto efímero para pruebas HTTP
  unit/               config, logger, migrator, transaction, password, sessions, http, router-validation, authorizer, sections-slug, contents-body, contents-render, media-inspect, media-names, static, editor-schema
  integration/        servidor HTTP, esquema, conexión a archivo, CLI, arranque, auth, CLI de administración, usuarios y permisos, secciones, contenidos, flujo editorial, multimedia
  security/           sesiones, fuerza bruta, enumeración, escalada de privilegios, contraseña temporal, secciones, contenidos, flujo editorial, multimedia y panel
docs/                 Documentación del proyecto
```

### Flujo de arranque

1. `node --env-file-if-exists=.env` carga `.env` sin sobrescribir variables reales.
2. `loadConfig(process.env)` valida y congela la configuración; si falla, sale con código 1.
3. Se crea el logger con el nivel configurado (sin stack traces en producción).
4. `openDatabase(DATABASE_PATH, { create: false })` y `assertSchemaCurrent()`: si la base no existe o hay migraciones pendientes o modificadas, sale con código 1 (no migra automáticamente).
5. `createServer()` aplica cabeceras de seguridad, sirve el panel (`/admin/…`) y los recursos públicos (`/assets/…`) desde listas cerradas con su CSP, enruta la API (404/405); lo que no es de la API lo atiende el sitio público (HTML, solo GET/HEAD); exige mismo origen en métodos que modifican estado, resuelve la sesión en rutas autenticadas (401) y exige `X-CSRF-Token` si modifican estado. Con contraseña temporal solo se permiten las rutas marcadas `allowDuringPasswordChange`, y si la ruta exige un rol se comprueba aquí (403 auditado). Cada 15 min se purgan las sesiones caducadas.
6. `SIGINT`/`SIGTERM` cierran el servidor de forma ordenada (máx. 10 s) y la base de datos (checkpoint del WAL).

## Estructura planificada (bloques posteriores)

Los directorios se crean cuando tienen contenido real (no se generan carpetas o archivos vacíos):

```text
backend/
  database/repositories/                Bloques 03+ (un repositorio por módulo, en su bloque)
  modules/audit, settings               Bloques 04+ / 10
  services/                             según necesidad
storage/private, backups               Bloque 10 (fuera de lo público, no versionado)
```

## Entorno de datos

La base de datos SQLite (modo WAL) debe estar en un disco local, nunca en carpetas sincronizadas ni en unidades de red. El riesgo de OneDrive detectado en el Bloque 01 está resuelto. Ver [DECISIONS.md](DECISIONS.md#d-006).
