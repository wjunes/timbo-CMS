# Sitio público

Implementado en el Bloque 09. Código en [`backend/modules/public/`](../backend/modules/public/); estilos en [`frontend/public/assets/site.css`](../frontend/public/assets/site.css); reglas de la base en la migración [007](../backend/database/migrations/007_public_site.sql).

## Cómo se genera (D-054)

- El servidor genera el HTML con plantillas del sistema ([`views.js`](../backend/modules/public/views.js)). Los administradores eligen la presentación de un catálogo cerrado (D-027), pero no pueden editar plantillas ni subir código.
- Todo dato se escapa: títulos, resúmenes, nombres y descripciones de secciones y ajustes del sitio. El cuerpo lo genera `renderBody` desde la lista blanca, también escapado.
- **Sin JavaScript.** El acordeón usa `<details>` y la navegación se adapta solo con CSS. La CSP pública no permite scripts:

  ```text
  default-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
  ```

- **Diseño:** adaptable (sin desplazamiento horizontal a 375 px; las tablas anchas se desplazan dentro de su contenedor), con modo oscuro según el sistema y estilos de impresión.
- **Accesibilidad:** enlace «Saltar al contenido», regiones y migas de pan con `aria-current`, foco visible y `lang="es"`.
- **Sin cookies:** el sitio público no lee ni fija ninguna.

## Rutas

| Ruta | Respuesta |
| --- | --- |
| `/` | Portada: nombre y descripción del sitio, las últimas 6 publicaciones de las secciones de tipo noticias y artículos, y las secciones principales |
| `/<ruta-de-sección>` | La sección con su presentación, con paginación `?pagina=N` |
| `/<ruta-de-sección>/<slug>` | Un contenido |
| `/media/<id>` | Un archivo usado por un contenido publicado |
| `/sitemap.xml`, `/robots.txt` | Mapa del sitio (solo lo visible) e instrucciones para buscadores (excluye `/admin/` y `/api/`) |
| `/favicon.ico` | `204`, hasta que haya un icono propio (D-057) |
| `/assets/…` | Hoja de estilos, desde una lista cerrada de archivos |

- **Formato de la ruta:** cada segmento debe ser un slug (`[a-z0-9]` con guiones simples), con 4 segmentos como máximo (3 niveles de sección y el contenido). Cualquier otra forma da `404`, incluidos los intentos de path traversal y las mayúsculas.
- **Barra final:** `/noticias/` responde `301` a `/noticias`. Solo se redirige si todos los segmentos son válidos, así que el destino nunca puede ser `//otro-dominio`.
- **Métodos:** el sitio solo admite `GET` y `HEAD` (`405` en otro caso). `/api/…` y `/admin/…` no pasan por aquí.

## Qué es visible

- **Secciones:** las `active` cuyos ancestros también están todos `active`.
- **Contenidos:** los `published` de esas secciones, y siempre la versión del puntero `published_version_id`. Un borrador, una versión en revisión o una aprobada sin publicar no aparecen nunca, aunque el contenido tenga otra versión publicada.
- **Archivos:** solo los que usa la versión publicada de un contenido visible. Al despublicar o desactivar la sección, dejan de servirse.
- **Lo demás no existe:** cualquier otra cosa responde `404` con la misma página que una ruta inexistente, así que no se revela si existe.

## Presentaciones

| Presentación | Orden | Por página | Qué muestra |
| --- | --- | --- | --- |
| `list` | Fecha de publicación, de la más reciente | 10 | Título, fecha y resumen |
| `grid` | Igual | 12 | Tarjetas con la primera imagen del contenido |
| `document_list` | Igual | 10 | Cada contenido con sus documentos: nombre, tipo y tamaño |
| `page` | Orden del contenido | todos | El primero completo y enlaces a los demás |
| `accordion` | Orden del contenido | todos | Cada contenido como pregunta desplegable, con enlace permanente |

- **Paginación:** una página fuera de rango o un `?pagina=` mal formado responden `404`.
- **Subsecciones:** las visibles se listan al pie de su sección.
- **Fecha:** la página de un contenido la muestra en las presentaciones fechadas (`list`, `grid` y `document_list`).
- **Texto alternativo:** una imagen sin `alt` en el cuerpo usa el de la biblioteca.

## URL estables (D-039, D-055)

- **Colisiones de slug:** un contenido y una subsección de la misma sección no pueden tener el mismo slug, porque tendrían la misma URL. Se rechaza en los dos sentidos con `409 slug_taken`, en la aplicación y en la base (migración 007). El slug que se genera para un contenido evita los de las subsecciones.
- **Redirecciones:** al cambiar el slug de un contenido, o el slug o el padre de una sección, triggers de la base registran la ubicación antigua en la misma transacción (`section_redirects`, `content_redirects`).
  - Una ruta antigua responde `301` a la actual, y se conserva la consulta (`?pagina=`).
  - Si se movió una sección, también se redirigen sus subsecciones y contenidos.
  - Solo se redirige a destinos visibles; si no lo son, `404`.
  - Una ruta real tiene prioridad sobre una redirección: si otra sección o contenido ocupa después la ruta antigua, se muestra ese.

## Caché

Las páginas, el sitemap y los archivos llevan `ETag` y `Cache-Control: no-cache`. El navegador revalida siempre (`304` si nada cambió), así que despublicar tiene efecto inmediato. El `304` repite las cabeceras propias de la respuesta: el navegador actualiza con ellas la copia guardada, y con la CSP base la página perdería los estilos y las imágenes. Este fallo se detectó en la prueba con navegador real y tiene una prueba de regresión.

## Ajustes del sitio (D-056)

`site.name` y `site.description` se guardan en `settings` (valores JSON). La migración 007 los crea con un valor por defecto. Se cambian en el panel, en **Sistema → Configuración** (`PATCH /api/settings`, Bloque 10), y cada cambio se audita.

## Limitaciones conocidas

- Las fechas se muestran en la zona horaria del servidor.
- El sitio no tiene búsqueda ni feeds RSS: no están en la especificación.
- El árbol de secciones se lee en cada petición. Es pequeño (3 niveles) y el rendimiento medido es suficiente (ver [ROADMAP.md](ROADMAP.md#bloque-11--detalle)); no se configura caché intermedia (ver `deploy/Caddyfile`).
