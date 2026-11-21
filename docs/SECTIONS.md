# Secciones

Implementado en el Bloque 05. Código en [`backend/modules/sections/`](../backend/modules/sections/); esquema en la migración [003](../backend/database/migrations/003_sections.sql).

## Modelo

- **Tipo** (`section_types`): define la naturaleza de la sección y su presentación por defecto. Hay 5: `institutional`, `news`, `articles`, `documents` y `faq`. Es un catálogo del sistema: no hay API para crear tipos, y el tipo de una sección no puede cambiarse después de crearla (trigger `section_type_immutable`).
- **Presentación** (`presentations`): cómo mostrará la sección el sitio público (Bloque 09). Hay 5: `page`, `list`, `grid`, `accordion` y `document_list`. También es un catálogo del sistema: los administradores eligen entre valores existentes, nunca suben plantillas ni código (D-027).
- **Flujo** (`workflow`): `approval` (por defecto; publica el `general_admin` tras revisión) o `direct` (publican los administradores autorizados). Se aplica en el Bloque 07.
- **Jerarquía**: como máximo **3 niveles**. La ruta de una sección es la concatenación de slugs (`institucional/memorias`) y será su URL pública.

Las 5 secciones predefinidas (`is_system = 1`) son: `institucional`, `noticias`, `articulos`, `biblioteca` y `preguntas-frecuentes`.

## Estados

| Estado | Sitio público (Bloque 09) | Edición de contenidos (Bloques 06–07) | Se puede asignar | Se puede editar la sección |
| --- | --- | --- | --- | --- |
| `active` | visible | sí | sí | sí |
| `inactive` | oculta | sí (preparar antes de mostrar) | sí | sí |
| `archived` | oculta | solo lectura | no | no (hay que reactivarla) |

```text
active ⇄ inactive
active | inactive → archived → active | inactive
```

Reglas garantizadas por la base (migración 003):

- Las secciones del sistema se pueden desactivar, pero **no archivar** ni borrar (`system_section_protected`).
- Una sección solo se archiva si todas sus subsecciones ya están archivadas (`section_has_active_children`).
- No se crea, mueve ni reactiva una sección bajo un padre archivado (`parent_archived`).
- Sin ciclos (`section_cycle`) y con un máximo de 3 niveles, también al mover subárboles (`section_depth_exceeded`).

## Borrado

Solo se borran físicamente las secciones **personalizadas sin subsecciones, contenidos ni archivos**. En cualquier otro caso la respuesta es `409 section_in_use` con `usage: { children, contents, media }` y la sección debe archivarse. Al borrar se eliminan sus asignaciones y permisos; la auditoría registra a qué usuarios afectó.

## Slugs

- `[a-z0-9]` en grupos separados por un único guion, hasta 100 caracteres. Únicos entre secciones hermanas.
- Si no se indica, se genera a partir del nombre: se quitan tildes y diacríticos (`Año Académico` → `ano-academico`, `ß` → `ss`) y cualquier otro carácter pasa a guion. Si no queda nada, la respuesta es `400` (`slug: required`).
- En el primer nivel no se admiten los prefijos reservados del sistema: `admin`, `api`, `assets`, `media`, `static`, `health`, `login` y `logout` (`slug: reserved`). La comprobación se repite al mover una sección a la raíz.
- Cambiar el slug o el padre cambia la URL pública. No hay redirecciones automáticas (deuda para el Bloque 09).

## Flujo editorial

Se puede cambiar en cualquier momento, salvo de `approval` a `direct` si la sección tiene versiones en `pending_review`: responde `409 pending_reviews_exist`, para no saltarse una revisión en curso (D-031). Primero hay que resolver esas revisiones.

## API

Escritura: solo `general_admin`, con sesión y `X-CSRF-Token`. Lectura: cualquier sesión; un administrador de sección solo ve sus secciones asignadas (las demás responden `404`).

| Método y ruta | Cuerpo | Respuesta / errores |
| --- | --- | --- |
| `GET /api/sections` | — | `200 { sections: [...] }` en orden jerárquico |
| `GET /api/sections/:id` | — | `200 { section }` · `404` |
| `POST /api/sections` | `{ name, type, slug?, description?, parentId?, presentation?, workflow? }` | `201 { section }` · `400 validation_failed` · `409 slug_taken` / `section_depth_exceeded` / `parent_archived` |
| `PATCH /api/sections/:id` | `{ name?, description?, slug?, parentId?, presentation?, workflow? }` | `200 { section }` · `400` · `409 section_archived` / `slug_taken` / `section_cycle` / `section_depth_exceeded` / `parent_archived` / `pending_reviews_exist` |
| `POST /api/sections/:id/activate` · `/deactivate` · `/archive` | — | `200 { section }` · `409 invalid_status_transition` / `system_section_protected` / `section_has_active_children` / `parent_archived` |
| `DELETE /api/sections/:id` | — | `204` · `409 system_section_protected` / `section_in_use` |
| `PUT /api/sections/order` | `{ parentId: número \| null, ids: [...] }` (todas las secciones de ese nivel, en el orden deseado) | `200 { parentId, ids, changed }` · `400` · `409 order_mismatch` |
| `GET /api/section-types` | — | `200 { types: [{ code, name, description, defaultPresentation }] }` |
| `GET /api/presentations` | — | `200 { presentations: [{ code, name, description }] }` |

`section` = `{ id, parentId, slug, path, depth, name, description, type, presentation, workflow, status, isSystem, sortOrder, createdAt, updatedAt }`.

- Validación estricta: los campos desconocidos se rechazan (`unknown_field`), así que no se pueden enviar `isSystem`, `status`, `sortOrder` ni `createdBy`. El tipo no se acepta en `PATCH`.
- `name` y `description` se guardan como texto. Se escaparán al mostrarlos (Bloque 09); nunca se interpretan como HTML.
- Las altas se colocan al final de su nivel; el orden se cambia con `PUT /api/sections/order`.

## Auditoría

| Acción | Detalles |
| --- | --- |
| `section.create` | `{ slug, type, parentId }` |
| `section.update` | `{ changes: { campo: { from, to } } }` (solo los campos que cambian) |
| `section.status_change` | `{ from, to }` |
| `section.delete` | `{ slug, name, removedAssignments: [ids de usuario] }` |
| `section.reorder` | `{ parentId, before, after }` |

Los intentos de un administrador de sección se registran como `access.denied` (D-025).

## Ampliar los catálogos

Una presentación o un tipo nuevos se añaden con una migración (`INSERT INTO presentations …` / `INSERT INTO section_types …`) junto con el código que los muestra en el sitio público. No requieren reconstruir tablas.
