# Flujos editoriales y aprobaciones

Implementado en el Bloque 07. Código en [`backend/modules/editorial/`](../backend/modules/editorial/); reglas de la base en la migración [005](../backend/database/migrations/005_editorial.sql). El modelo de contenidos y versiones está en [CONTENTS.md](CONTENTS.md).

## Flujo de una versión

```text
                  submit                approve                 publish
  draft ─────────────────> pending_review ───────> approved ─────────────> published ──> archived
    │                            │                                          ▲      (al reemplazarla,
    │                            └─ request-changes ─> changes_requested    │       despublicar o archivar)
    └─────────────── publish (solo secciones 'direct') ────────────────────┘
```

| Transición | Desde → hacia | Requisito |
| --- | --- | --- |
| Enviar a revisión | `draft` → `pending_review` | `content.submit`; solo en secciones `approval`; `revision` actual del borrador |
| Aprobar (comentario opcional) | `pending_review` → `approved` | solo `general_admin` |
| Solicitar cambios (comentario obligatorio) | `pending_review` → `changes_requested` | solo `general_admin` |
| Publicar | `approved` → `published` (ambos flujos); `draft` → `published` (solo `direct`, con `revision`) | `content.publish` |

- `changes_requested` y `archived` son finales: se continúa con una versión nueva (`POST /api/contents/:id/versions` con `basedOnVersionId`).
- Una versión se revisa **una sola vez**, y la revisión queda ligada a ella (`publication_reviews`, solo inserción). Lo que se aprueba es exactamente lo que se publica: una versión enviada es inmutable.
- Al publicar, la versión publicada anterior pasa a `archived` en la misma transacción. Conserva su autoría y queda en el historial.
- Antes de enviar y de publicar se vuelve a validar el cuerpo con la lista blanca (D-033). Si un cuerpo guardado ya no la cumple, la respuesta es `409 body_invalid` con `bodyPath`.
- El `general_admin` sigue el mismo camino en las secciones `approval`: envía, aprueba y publica, sin atajos (D-041).

## Flujo del contenido

| Operación | Efecto | Requisito |
| --- | --- | --- |
| Despublicar | La versión publicada pasa a `archived`; el contenido, a `draft` | `content.unpublish` |
| Archivar | El contenido pasa a `archived` y, si estaba publicado, se despublica en el mismo paso. No se permite con una versión `pending_review` o `approved` (`content_in_review`) | `content.archive` |
| Restaurar | `archived` → `draft`; vuelve a ser editable | `content.archive` |

Despublicar y archivar retiran contenido y **no requieren aprobación**, tampoco en secciones `approval` (D-042). Un borrador abierto se conserva al archivar y vuelve a ser editable al restaurar.

## Reglas comunes

- **Visibilidad y permisos:** igual que en contenidos (D-022). Si la sección no existe o no está asignada, la respuesta es `404`. Si falta el permiso, `403`, auditado como `access.denied`, con el permiso que faltaba (`permission`) o el rol exigido (`requiredRole`).
- **Secciones:** una sección archivada no admite transiciones (`section_archived`); una inactiva, sí. Un contenido archivado no admite transiciones de versión (`content_not_editable`) hasta restaurarlo. Uno eliminado responde `404`.
- **Concurrencia:** cada transición vuelve a leer el estado dentro de su transacción (`BEGIN IMMEDIATE`) y lo actualiza con el estado de origen como condición. Si algo cambió entre medias, la respuesta es `409 state_changed` (o el error concreto) y no se aplica nada.
- **Cambio de flujo de la sección:** no se puede pasar a `direct` con versiones pendientes de revisión (D-031). Una versión ya aprobada puede publicarse después en una sección `direct`.

## API

Todas las rutas requieren sesión; las que modifican estado requieren además el origen del sitio y `X-CSRF-Token`. El cuerpo, cuando lo hay, es JSON estricto (los campos desconocidos se rechazan).

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `POST /api/contents/:id/versions/:versionId/submit` | `{ revision }` | `200 { content, version }` |
| `POST /api/contents/:id/versions/:versionId/approve` | `{ comment? }` (≤ 5000) | `200 { content, version }` (solo `general_admin`) |
| `POST /api/contents/:id/versions/:versionId/request-changes` | `{ comment }` (1–5000) | `200 { content, version }` (solo `general_admin`) |
| `POST /api/contents/:id/versions/:versionId/publish` | `{ revision? }` (obligatoria si es un borrador) | `200 { content, version }` |
| `GET /api/contents/:id/versions/:versionId/reviews` | — | `200 { reviews }` |
| `POST /api/contents/:id/unpublish` | — | `200 { content }` |
| `POST /api/contents/:id/archive` | — | `200 { content }` |
| `POST /api/contents/:id/restore` | — | `200 { content }` |
| `GET /api/reviews/pending` | — | `200 { pending }` (solo `general_admin`) |

`content` y `version` tienen el formato de [CONTENTS.md](CONTENTS.md), sin cuerpo.

Revisión:

```json
{ "id": 3, "versionId": 7, "decision": "changes_requested", "comment": "Falta la fecha",
  "reviewer": { "id": 1, "displayName": "Administración" }, "createdAt": "…" }
```

Cola de revisión, de la más antigua a la más reciente:

```json
{ "pending": [ {
  "section": { "id": 2, "name": "Noticias" },
  "content": { "id": 5, "slug": "convocatoria-2027", "status": "published" },
  "version": { "id": 7, "versionNumber": 2, "title": "…", "submittedBy": { "id": 4, "displayName": "…" }, "submittedAt": "…" }
} ] }
```

El comentario se guarda y se devuelve como texto plano (JSON). La interfaz deberá mostrarlo escapado.

### Errores

| Código | Estado | Cuándo |
| --- | --- | --- |
| `validation_failed` | 400 | Campos inválidos o desconocidos; falta `revision` o `comment` |
| `forbidden` | 403 | Falta el permiso o el rol (auditado) |
| `not_found` | 404 | Contenido o versión inexistentes, eliminados, de otro contenido o no visibles |
| `invalid_transition` | 409 | La versión o el contenido no están en el estado de origen (con `status` actual) |
| `approval_required` | 409 | Publicar un borrador en una sección `approval` |
| `review_not_required` | 409 | Enviar a revisión en una sección `direct` |
| `revision_conflict` | 409 | `revision` desactualizada (con `currentRevision`) |
| `body_invalid` | 409 | El cuerpo guardado no cumple la lista blanca (con `fields.body` y `bodyPath`) |
| `content_not_published` | 409 | Despublicar algo que no está publicado |
| `content_in_review` | 409 | Archivar con una versión en revisión o aprobada |
| `section_archived` | 409 | Sección archivada |
| `content_not_editable` | 409 | Transición de versión en un contenido archivado |
| `state_changed` | 409 | El estado cambió durante la operación; no se aplicó nada |

## Garantías de la base (migración 005)

| Regla | Código |
| --- | --- |
| Solo las transiciones del flujo (la vuelta a borrador ya la impedía la 001) | `version_invalid_transition` |
| Aprobar o solicitar cambios exige la revisión registrada con esa decisión; la aprobación la firma el revisor | `review_required` |
| Una revisión por versión | índice único `ux_reviews_one_per_version` |
| En secciones `approval` un borrador no pasa a publicado | `approval_required` |
| El revisor es el `general_admin` y la versión está pendiente (desde la 001) | `reviewer_must_be_general_admin`, `version_not_pending_review` |

La regla de que una sección archivada no admite transiciones la aplica solo la aplicación. Ponerla en la base habría exigido cambiar una prueba aprobada del Bloque 06, que publica en una sección ya archivada para comprobar otra regla.

## Auditoría

Cada transición se audita en su transacción (entidad `content`, con la sección). Los detalles nunca incluyen el cuerpo ni el comentario, que queda en `publication_reviews`.

| Acción | Detalles |
| --- | --- |
| `version.submit` | `versionId`, `versionNumber` |
| `version.approve`, `version.request_changes` | `versionId`, `versionNumber`, `reviewId` |
| `version.publish` | `versionId`, `versionNumber`, `from` (`draft` o `approved`), `replacedVersionId` |
| `content.unpublish` | `versionId`, `versionNumber` (la retirada) |
| `content.archive` | `from` (estado anterior), `unpublishedVersionId` |
| `content.restore` | — |

## Fuera de alcance

- Publicación programada y notificaciones: no están en la especificación.
- Interfaz del panel: Bloques 08–09.
- Consulta y restauración de contenidos eliminados: sigue sin bloque asignado.
