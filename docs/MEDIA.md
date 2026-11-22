# Editor enriquecido, multimedia y panel

Implementado en el Bloque 08. Código:

- multimedia: [`backend/modules/media/`](../backend/modules/media/); reglas de la base en la migración [006](../backend/database/migrations/006_media.sql);
- renderizado seguro: [`backend/modules/contents/render.js`](../backend/modules/contents/render.js);
- panel: [`frontend/admin/`](../frontend/admin/), servido por [`backend/middleware/static.js`](../backend/middleware/static.js);
- editor: [`frontend/components/editor/entry.js`](../frontend/components/editor/entry.js), empaquetado en `frontend/admin/assets/editor.bundle.js`.

## Archivos

### Tipos admitidos (D-048)

| Tipo | Extensiones | Clase | Qué se comprueba |
| --- | --- | --- | --- |
| `image/png` | `png` | imagen | Firma, todos los bloques con su CRC, `IHDR` primero, `IDAT` y `IEND`; ningún bloque crítico desconocido |
| `image/jpeg` | `jpg`, `jpeg` | imagen | Firma, todos los segmentos con su longitud, `SOF` antes de `SOS`, datos comprimidos hasta `EOI` |
| `image/webp` | `webp` | imagen | Cabecera RIFF, cada bloque dentro del tamaño declarado, al menos un bloque de imagen |
| `application/pdf` | `pdf` | documento | Cabecera `%PDF-1.x`/`2.x`, `%%EOF` al final y ausencia de contenido activo |

SVG no se admite (puede contener scripts) y GIF tampoco. Se rechaza todo lo demás con `415`.

### Validación de una subida

1. **Permiso y sección:** la sección debe ser visible (si no, `404`), el usuario debe tener `media.upload` (si no, `403` auditado) y la sección no puede estar archivada.
2. **Tipo declarado:** el `Content-Type` debe ser uno de los admitidos. La extensión del nombre original debe corresponder a ese tipo (`400 extension_mismatch`).
3. **Nombre original:** llega en `X-File-Name`, codificado como URI. Se rechaza si contiene `/`, `\` o caracteres de control, o si no tiene extensión. Nunca se usa para el disco.
4. **Tamaño:** como máximo `MEDIA_MAX_BYTES` (10 MiB por defecto). El límite se aplica tanto al `Content-Length` declarado como a los bytes que llegan (`413`).
5. **Contenido real** ([`inspect.js`](../backend/modules/media/inspect.js)):
   - la firma debe coincidir con el tipo declarado (`content_mismatch`);
   - se recorre la estructura completa (`file_corrupt`);
   - las imágenes no pueden superar 20 000 px por lado ni 50 megapíxeles (`image_too_large`).

   Si falla, la respuesta es `422 file_rejected` con `reason`, y el rechazo queda auditado.
6. **Metadatos (D-049):** se eliminan sin recodificar la imagen:
   - EXIF (incluido el GPS), XMP, IPTC, comentarios y bloques de texto;
   - todo byte posterior al final del formato, donde suelen esconderse archivos políglotas.

   De EXIF solo se conserva la orientación, en un bloque mínimo, para que las fotos de móvil no se vean giradas. Las dimensiones guardadas son las visibles.
7. **PDF (D-051):** se rechazan los que contienen `/JavaScript`, `/JS`, `/Launch`, archivos incrustados, `/RichMedia`, `/XFA`, `/SubmitForm`, `/ImportData`, `/Sound` o `/Movie`. El análisis:
   - interpreta los escapes `#xx` en los nombres;
   - revisa también los flujos comprimidos con FlateDecode;
   - limita la descompresión a 128 MiB en total (`pdf_too_complex`).

   Es una defensa de mejor esfuerzo; la principal es cómo se sirve el archivo (más abajo).
8. **Guardado:**
   - el archivo se escribe en `STORAGE_DIR/media/<clave>`, donde la clave son 128 bits aleatorios en hexadecimal, sin extensión;
   - la escritura usa un archivo temporal exclusivo, `fsync` y un renombrado atómico;
   - se calcula el SHA-256;
   - el registro y su auditoría se guardan en una transacción; si falla, el archivo se borra.

Hay como máximo 4 subidas simultáneas, porque cada una se procesa en memoria; las demás reciben `503 uploads_busy`.

### Servir los archivos al panel

`GET /api/media/:id/file` exige sesión y que la sección sea visible. Responde con:

- el MIME guardado en la base, nunca uno deducido;
- `X-Content-Type-Options: nosniff`;
- `Content-Security-Policy: default-src 'none'; sandbox`: aunque un navegador abriera el archivo como documento, no ejecuta nada ni accede al origen;
- `Content-Disposition: attachment` para los documentos e `inline` para las imágenes;
- `Cache-Control: private, no-store`.

El servidor nunca interpreta ni ejecuta los archivos; `storage/` no se sirve por ninguna otra ruta. El sitio público (Bloque 09) servirá solo los archivos de contenidos publicados.

### Eliminar (D-047)

- El borrado es lógico: el registro pasa a `deleted` y el archivo físico se conserva.
- Se rechaza con `409 media_in_use`, con la lista de usos, si lo usa alguna versión en borrador, en revisión, aprobada o publicada de un contenido no eliminado.
- Las versiones archivadas o con cambios solicitados no lo impiden. Por eso se conserva el archivo: el historial sigue siendo consultable.
- La purga física controlada es del Bloque 10.

## Imágenes y documentos en el cuerpo (D-050)

- **Imagen:** un nodo `image` con `mediaId` y `alt` (hasta 500 caracteres, sin caracteres de control), sin URL. Se admite en el documento, en citas y en celdas de tabla.
- **Documento o imagen enlazados:** un enlace con `href` exacto `/media/<id>`. Cualquier otra ruta bajo `/media` se rechaza (`media_href_invalid`). Esa ruta será la pública del Bloque 09; en la vista previa del panel se resuelve a `/api/media/<id>/file`.
- **Al crear o guardar un borrador**, cada referencia debe ser un archivo activo de la misma sección, y una imagen debe ser una imagen. Si no, la respuesta es `400 validation_failed` con `fields.body` igual a `media_not_available` o `media_not_image`, junto con `bodyPath` y `mediaId`. Las referencias se registran en `content_media` en la misma transacción.
- **Una versión nueva** hereda las referencias de su versión de origen.
- **Al enviar a revisión o publicar** se vuelve a comprobar, con `409 media_not_available` si un archivo ya no está disponible. Puede ocurrir con un borrador creado a partir de una versión archivada cuyo archivo se eliminó después.

## Vista previa

`POST /api/contents/:id/preview` con `{ body }` valida el cuerpo igual que al guardar y devuelve `{ html }`. No guarda nada. El HTML lo genera `renderBody`, el renderizador que usará el sitio público:

- trabaja con una tabla cerrada de nodos y marcas;
- escapa todo el texto y todos los atributos;
- no emite atributos `style` ni manejadores: la alineación es una clase (`align-center`, `align-right`, `align-justify`);
- en los enlaces con `target=_blank` añade siempre `rel="noopener noreferrer"`.

## API

Todas las rutas requieren sesión. Las que modifican estado requieren además el origen del sitio y `X-CSRF-Token`.

| Método y ruta | Cuerpo | Respuesta | Requisito |
| --- | --- | --- | --- |
| `GET /api/sections/:id/media` | — | `200 { media }` (activos, del más reciente) | ver la sección |
| `POST /api/sections/:id/media` | el archivo en bruto; `Content-Type`; `X-File-Name` | `201 { media }` | `media.upload` |
| `GET /api/media/:id` | — | `200 { media, usage }` | ver la sección |
| `PATCH /api/media/:id` | `{ altText }` (≤ 500) | `200 { media }` | `media.upload` |
| `DELETE /api/media/:id` | — | `204` · `409 media_in_use { usage }` | `media.delete` |
| `GET /api/media/:id/file` | — | el archivo | ver la sección |
| `POST /api/contents/:id/preview` | `{ body }` | `200 { html }` | ver la sección |

```json
{ "id": 4, "sectionId": 2, "kind": "image", "originalName": "Fachada.jpg", "mimeType": "image/jpeg",
  "extension": "jpg", "sizeBytes": 183422, "sha256": "…", "width": 1200, "height": 800, "altText": "Fachada",
  "status": "active", "uploadedBy": { "id": 3, "displayName": "…" }, "createdAt": "…", "fileUrl": "/api/media/4/file" }
```

`usage` es una lista de `{ content: { id, slug, status }, version: { id, versionNumber, status, title } }`.

La clave de almacenamiento y las rutas del disco no se exponen nunca. Editar el texto alternativo usa `media.upload` (D-052): quien añade archivos mantiene sus metadatos.

**Auditoría:**

- `media.upload`, con `mimeType`, `sizeBytes` y `metadataRemoved`; los rechazos se registran con `outcome: failure` y su `reason`;
- `media.update`, con `fields`;
- `media.delete`, con `originalName` y `sha256`.

No se registra el contenido de los archivos.

## Editor (D-046)

Tiptap 3.33.0 con exactamente los nodos y las marcas de la lista blanca: párrafo, encabezados H2–H4, negrita, cursiva, subrayado, listas, cita, enlace, tabla, imagen de la biblioteca y salto de línea. Ofrece además alineación, deshacer y rehacer, y vista previa.

- **Esquema:** el contenido admitido de citas, elementos de lista y celdas es el mismo que el de la lista blanca, así que el editor no produce documentos que el backend rechazaría. Una prueba ([`editor-schema.test.js`](../tests/unit/editor-schema.test.js)) construye un documento con todos los nodos del esquema real y lo valida.
- **Sin estilos en línea:**
  - `injectCSS: false`, porque los estilos de ProseMirror están en `admin.css`;
  - la alineación se pinta como clase;
  - las tablas no tienen vista de nodo ni anchos en línea, y las celdas no llevan el atributo `align`.
- **Imágenes ajenas:** al pegar HTML, solo se reconocen las imágenes de la biblioteca (`img[data-media-id]`); el backend vuelve a comprobar la sección.
- **Bundle:**
  - se genera con `npm run build:editor` (esbuild) en un único módulo ES servido por el propio sitio, sin CDN;
  - se versiona en el repositorio, así que desplegar no exige compilar;
  - `editor.bundle.licenses.txt` reúne las licencias (MIT) de los 35 paquetes incluidos;
  - `node scripts/build-editor.js --check`, que se ejecuta en las pruebas, falla si el bundle no corresponde a las dependencias instaladas.
- **Dependencias:** todas son de desarrollo, con versión exacta: `@tiptap/*` 3.33.0 y `esbuild` 0.28.2. Se instalaron con `npm install --before=2026-11-08`, para que todo el árbol (también ProseMirror) tuviera más de dos semanas de antigüedad. El servidor sigue sin dependencias de ejecución. El `postinstall` de esbuild, que npm 12 bloquea, no es necesario: el binario de la plataforma llega como dependencia opcional.

## Panel (D-045)

Aplicación de una página en `/admin/`, con JavaScript y CSS propios, sin frameworks.

**Pantallas:**

- acceso;
- cambio de contraseña, también la obligatoria;
- secciones;
- contenidos de una sección;
- contenido, con sus versiones y las acciones editoriales;
- edición de un borrador;
- biblioteca multimedia;
- cola de revisión del `general_admin`.

**Seguridad:**

- **CSP del panel:** `default-src 'none'`; scripts, estilos, imágenes y peticiones solo de `'self'`; `frame-ancestors 'none'`, `object-src 'none'` y `base-uri 'none'`. Nada en línea: ni scripts, ni estilos, ni manejadores. Una prueba en un navegador real (Chrome) no registró ninguna violación.
- **Sesión:** la cookie de sesión es `HttpOnly`. El token CSRF se guarda solo en memoria y se vuelve a pedir al recargar con `GET /api/auth/session`. Nada se guarda en `localStorage` ni en `sessionStorage`; una prueba revisa todos los archivos del panel.
- **Datos en pantalla:** todos los datos se insertan como texto. La única inserción de HTML es la vista previa, que viene del servidor ya escapada y se monta a través de un `<template>`.
- **Archivos del panel:** se sirven desde una lista cerrada que se construye al arrancar, con solo extensiones conocidas y sin archivos ocultos. La ruta pedida nunca se convierte en una ruta del disco, así que no hay path traversal posible. Solo admite `GET` y `HEAD`.
- **Permisos:** los permisos que usa el panel para mostrar u ocultar acciones son informativos; el backend decide siempre.

Las pantallas de usuarios, permisos, secciones y configuración no forman parte de este bloque (ver [ROADMAP.md](ROADMAP.md)). Su API ya existe.

## Limitaciones conocidas

- **Subidas lentas:** el tiempo máximo de una petición se amplió a 120 s para que se pueda subir un archivo de 10 MiB con una conexión lenta (D-053).
- **Archivos huérfanos:** si el proceso se detiene entre el renombrado y el registro en la base, queda un archivo sin registro, y pueden quedar temporales `.tmp-*`. Su limpieza corresponde a la purga controlada del Bloque 10.
- **Listado de la biblioteca:** devuelve todos los archivos activos de la sección, sin paginar.
