# Contenidos y versionado

Implementado en el Bloque 06. Código en [`backend/modules/contents/`](../backend/modules/contents/); esquema en las migraciones [001](../backend/database/migrations/001_initial_schema.sql) y [004](../backend/database/migrations/004_contents.sql).

Las transiciones editoriales (enviar a revisión, aprobar, solicitar cambios, publicar, despublicar, archivar) son del **Bloque 07**. El editor Tiptap y las imágenes, del **Bloque 08**. El renderizado público, del **Bloque 09**. En este bloque los contenidos se crean y editan en borrador.

## Modelo

Un **contenido** (`contents`) pertenece a una sección y tiene un slug único dentro de ella. Su estado general es independiente del de sus versiones:

| Estado del contenido | Significado |
| --- | --- |
| `draft` | Nunca publicado, o despublicado (Bloque 07). |
| `published` | Tiene una versión publicada (`published_version_id`). |
| `archived` | Retirado; no admite edición (Bloque 07). |
| `deleted` | Eliminado lógicamente; conserva su historial. |

Cada **versión** (`content_versions`) guarda título, resumen y cuerpo, con número correlativo, versión de origen (`based_on_version_id`) y autoría: quién la creó, la modificó, la envió, la aprobó y la publicó.

| Estado de la versión | Editable | Quién la lleva a ese estado |
| --- | --- | --- |
| `draft` | sí (con `revision`) | Bloque 06 (alta) |
| `pending_review`, `approved` | no | Bloque 07 |
| `changes_requested` | no (se crea una versión nueva a partir de ella) | Bloque 07 |
| `published`, `archived` | no | Bloque 07 |

Invariantes garantizadas por la base:

- Como máximo **una versión publicada** y **una en curso** (`draft`, `pending_review` o `approved`) por contenido.
- Una versión que salió de borrador no se modifica ni vuelve a borrador; solo se eliminan borradores.
- Las versiones nacen siempre como borrador (`version_must_start_as_draft`).
- Un contenido no cambia de sección (`content_section_immutable`, D-034) ni se borra físicamente (`content_delete_forbidden`, D-035).
- No se crean contenidos ni versiones, ni se editan borradores, en una sección archivada (`section_archived`) ni en un contenido archivado o eliminado (`content_not_editable`).

## Editar sin tocar lo publicado

```text
v1 (published) ──based_on──> v2 (draft) ──edición──> v2 (draft, revision n)
       ▲                                                   │
       └──── sigue publicada hasta que v2 se publique (Bloque 07)
```

1. `POST /api/contents/:id/versions` crea un borrador copiado de la versión publicada (o, si no hay, de la última). Con `basedOnVersionId` se parte de otra versión del mismo contenido: una rechazada (`changes_requested`) o una anterior (para recuperarla).
2. El borrador se guarda con `PATCH …/versions/:versionId`, enviando la `revision` que tiene el cliente. Si alguien guardó antes, la respuesta es `409 revision_conflict` con `currentRevision`, y no se pierde nada de lo guardado. Un guardado sin cambios no incrementa la revisión.
3. La versión publicada no cambia en ningún momento.

Un borrador puede descartarse (`DELETE …/versions/:versionId`) salvo que sea la única versión: en ese caso se elimina el contenido (D-038). El número de un borrador descartado puede volver a usarse; la auditoría conserva el rastro.

## Cuerpo (Tiptap JSON)

El backend valida el cuerpo en cada guardado con una lista blanca estricta y **rechaza** lo que no encaja, sin corregirlo en silencio (D-033). El error indica el código y la ruta del problema (JSON Pointer):

```json
{ "error": "validation_failed", "fields": { "body": "link_href_not_allowed" }, "bodyPath": "/content/0/content/0/marks/0/attrs/href" }
```

| Nodo | Atributos | Contenido |
| --- | --- | --- |
| `doc` | — | bloques: `paragraph`, `heading`, `bulletList`, `orderedList`, `blockquote`, `table` |
| `paragraph` | `textAlign` (`null`, `left`, `center`, `right`, `justify`) | `text`, `hardBreak` |
| `heading` | `level` (2, 3 o 4; obligatorio), `textAlign` | `text`, `hardBreak` |
| `bulletList` | — | `listItem` (≥ 1) |
| `orderedList` | `start` (1–100 000), `type` (`null`, `1`, `a`, `A`, `i`, `I`) | `listItem` (≥ 1) |
| `listItem` | — | `paragraph` primero; luego `paragraph` o listas |
| `blockquote` | — | `paragraph`, `heading`, listas (≥ 1) |
| `table` / `tableRow` | — | `tableRow` / `tableHeader`, `tableCell` (≥ 1) |
| `tableHeader`, `tableCell` | `colspan` (1–20), `rowspan` (1–100), `colwidth` (`null` o lista de enteros) | `paragraph`, listas (≥ 1) |
| `hardBreak` | — | — |
| `text` | `marks` | texto no vacío, sin caracteres de control (salvo tabulador y salto de línea) |

| Marca | Atributos |
| --- | --- |
| `bold`, `italic`, `underline` | — |
| `link` | `href` (obligatorio), `target` (`null` o `_blank`), `rel` (`null` o combinación de `noopener`, `noreferrer`, `nofollow`), `class` (solo `null`) |

**Enlaces admitidos:** `http://` y `https://` con dominio y sin credenciales, `mailto:`, rutas del propio sitio que empiezan por `/` (no `//`) y anclas `#id`. Se rechazan `javascript:`, `data:`, `vbscript:`, `file:` y cualquier otro esquema, los destinos con espacios, controles, comillas o `\`, y los relativos sin `/`.

**Límites:** profundidad 16, 20 000 nodos, 20 000 caracteres por texto, 1 000 000 en total, 2 MiB serializado (UTF-8) y 2 MiB + 256 KiB por petición.

El texto con marcado (por ejemplo `<script>`) se guarda como texto: el documento nunca contiene HTML, y el sitio público (Bloque 09) escapará todo al generar el HTML desde esta misma lista. Las imágenes se añadirán con la multimedia (Bloque 08).

## Autorización

Siempre en el backend con el autorizador único (D-022), que relee rol, estado y permisos de la base.

| Operación | Requisito |
| --- | --- |
| Ver contenidos, historial y versiones | Tener la sección asignada (`canView`) |
| Crear | `content.create` |
| Editar o descartar un borrador | `content.edit`, o `content.create` si el borrador es del propio usuario (D-036) |
| Crear una versión nueva, cambiar slug u orden | `content.edit` |
| Eliminar | `content.delete` |

- El `general_admin` activo puede todo.
- Si la sección no existe o el usuario no la tiene asignada, todas las rutas responden `404` (no se revela su existencia).
- Si la ve pero no tiene el permiso, la respuesta es `403 forbidden` y se audita como `access.denied` con el permiso que faltaba.
- Sección archivada: solo lectura. Sección inactiva: editable.

## API

| Método y ruta | Uso | Respuesta |
| --- | --- | --- |
| `GET /api/sections/:id/contents` | Contenidos no eliminados de la sección, en orden | `200 { contents }` |
| `POST /api/sections/:id/contents` | Crear: `{ title, summary?, slug?, body? }` | `201 { content, version }` |
| `GET /api/contents/:id` | Ver un contenido | `200 { content }` |
| `PATCH /api/contents/:id` | `{ slug?, sortOrder? }` | `200 { content }` |
| `DELETE /api/contents/:id` | Borrado lógico | `204` |
| `GET /api/contents/:id/versions` | Historial, de la más reciente a la más antigua, sin cuerpo | `200 { content, versions }` |
| `POST /api/contents/:id/versions` | Nueva versión: `{ basedOnVersionId? }` | `201 { content, version }` |
| `GET /api/contents/:id/versions/:versionId` | Una versión con su cuerpo | `200 { version }` |
| `PATCH /api/contents/:id/versions/:versionId` | Guardar borrador: `{ revision, title?, summary?, body? }` | `200 { version }` |
| `DELETE /api/contents/:id/versions/:versionId` | Descartar borrador | `204` |

Sin `slug`, se genera a partir del título (como en las secciones) y, si ya existe en la sección, se añade `-2`, `-3`… Un slug explícito repetido responde `409 slug_taken`. Un contenido eliminado libera su slug.

Contenido:

```json
{
  "id": 1, "sectionId": 2, "slug": "convocatoria-2027", "status": "published", "sortOrder": 10,
  "title": "Convocatoria 2027 (ampliada)", "versionCount": 2, "latestVersionNumber": 2,
  "openVersion": { "id": 2, "versionNumber": 2, "status": "draft", "revision": 3 },
  "publishedVersion": { "id": 1, "versionNumber": 1 },
  "createdBy": 2, "createdAt": "…", "updatedAt": "…"
}
```

`title` es el de la versión más reciente. Una versión incluye `id`, `contentId`, `versionNumber`, `basedOnVersionId`, `status`, `title`, `summary`, `bodyFormat`, `revision`, las marcas de autoría (`createdBy`, `updatedBy`, `submittedBy`, `approvedBy`, `publishedBy` como `{ id, displayName }` o `null`) con sus fechas y, en la consulta individual, `body`.

### Errores

| Código | Estado | Cuándo |
| --- | --- | --- |
| `validation_failed` | 400 | Campos inválidos o desconocidos; cuerpo no admitido (con `bodyPath`) |
| `forbidden` | 403 | Falta el permiso (auditado) |
| `not_found` | 404 | Sección, contenido o versión inexistentes, eliminados o no visibles |
| `payload_too_large` | 413 | Petición mayor que el límite |
| `slug_taken` | 409 | Slug en uso en la sección |
| `section_archived` | 409 | Escritura en una sección archivada |
| `content_not_editable` | 409 | Contenido archivado |
| `version_not_editable` | 409 | La versión no es un borrador |
| `revision_conflict` | 409 | Revisión desactualizada (con `currentRevision`) |
| `open_version_exists` | 409 | Ya hay una versión en curso (con `openVersionId`) |
| `only_version` | 409 | Descartar la única versión |
| `content_published` | 409 | Eliminar un contenido publicado (despublicar antes, Bloque 07) |
| `content_in_review` | 409 | Eliminar un contenido con una versión en revisión o aprobada (D-037) |

## Auditoría

Cada escritura se audita en la misma transacción (entidad `content`):

| Acción | Detalles |
| --- | --- |
| `content.create` | `slug`, `versionId`, `versionNumber` |
| `content.update` | `changes: { campo: { from, to } }` |
| `content.delete` | `slug`, `from` (estado anterior), `versionCount` |
| `version.create` | `versionId`, `versionNumber`, `basedOnVersionId` |
| `version.update` | `versionId`, `versionNumber`, `revision` (nueva), `fields` (campos cambiados; nunca el cuerpo) |
| `version.discard` | `versionId`, `versionNumber` |

## Pendiente en otros bloques

- Transiciones editoriales y restauración de contenidos archivados (07).
- Editor Tiptap, imágenes y su relación con las versiones (`content_media`) (08).
- Renderizado público, colisiones de slug entre contenidos y subsecciones de una misma sección y redirecciones al cambiar slugs (09, D-039).
- Consulta y restauración de contenidos eliminados: sin bloque asignado todavía (se propondrá en el Bloque 07 o en el 10).
