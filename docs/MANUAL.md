# Guía de uso del panel

Esta guía es para quien gestiona el sitio desde el panel: la **administración general** y la **administración de sección**. No hace falta conocimiento técnico. Lo que necesita una consola, como el despliegue o la restauración de copias, está en [DEPLOYMENT.md](DEPLOYMENT.md) y [BACKUPS.md](BACKUPS.md).

El panel está en `https://<su-dominio>/admin/` y el sitio público en `https://<su-dominio>/`.

## Quién puede hacer qué

| | Administración general | Administración de sección |
| --- | --- | --- |
| Secciones | Todas; las crea y las configura | Solo las que tiene asignadas |
| Contenidos y archivos | Todo | Lo que permitan sus permisos en cada sección |
| Aprobar publicaciones | Sí | No |
| Usuarios y permisos | Sí | No |
| Sistema: configuración, auditoría, copias y purga | Sí | No |

**Permisos de un administrador de sección.** Se asignan por sección:

| Permiso | Permite |
| --- | --- |
| Crear contenidos y borradores | Crear contenidos y editar sus propios borradores |
| Editar borradores de cualquier contenido | Editar los borradores de otras personas y crear versiones nuevas |
| Enviar versiones a revisión | En secciones con aprobación |
| Publicar contenidos | En secciones con aprobación, solo versiones ya aprobadas |
| Despublicar contenidos | Retirar del sitio público |
| Archivar y restaurar contenidos | |
| Eliminar contenidos | Borrado lógico; desaparece del panel |
| Subir archivos multimedia | También editar su texto alternativo |
| Eliminar archivos | Solo los que no están en uso |

Una sección asignada sin ningún permiso solo se puede consultar.

## Acceso y contraseña

- **Entrar:** con el usuario y la contraseña. Tras varios intentos fallidos el acceso se bloquea temporalmente (hasta 15 minutos).
- **Contraseña temporal:** la primera vez, o cuando la administración general le asigne una nueva, el panel le obliga a cambiarla antes de continuar. La nueva necesita al menos 12 caracteres y no puede contener su nombre de usuario.
- **Cambiar la contraseña:** en **Contraseña**. Al cambiarla se cierran sus otras sesiones abiertas.
- **Cierre automático:** la sesión se cierra tras 30 minutos de inactividad o 8 horas en total (valores por defecto). Use **Salir** al terminar, sobre todo en equipos compartidos.
- **Modo claro u oscuro del panel:** en la barra superior, **Modo: Automático / Claro / Oscuro**. Automático sigue el de su equipo. Se guarda en su perfil, así que se mantiene en cualquier equipo, y no afecta a nadie más ni al sitio público.

## Secciones

**Secciones** lista las secciones a las que tiene acceso, con su ruta en el sitio, su tipo de publicación y su estado. Al entrar en una hay dos pestañas: **Contenidos** y **Biblioteca multimedia**. La administración general ve también **Configuración**.

| Tipo de publicación | Funcionamiento |
| --- | --- |
| **Directa** | Quien tenga el permiso publica un borrador directamente |
| **Con aprobación** | El borrador se envía a revisión, la administración general lo aprueba o pide cambios, y solo entonces se publica |

## Contenidos

### Crear y editar

1. En la sección, escriba el título en **Título del contenido nuevo** y pulse **Crear borrador**. Se abre el editor.
2. Escriba el resumen (opcional) y el cuerpo.
3. Pulse **Guardar**. El estado indica «Sin cambios» cuando todo está guardado. Si intenta salir con cambios sin guardar, el panel avisa.
4. **Vista previa** muestra el contenido tal como se verá en el sitio.

**Barra del editor:**

| Grupo | Botones |
| --- | --- |
| Historial | Deshacer y rehacer |
| Texto | Negrita, cursiva y subrayado |
| Bloques | Párrafo y encabezados de nivel 2 a 4 |
| Listas y citas | Lista con viñetas, lista numerada y cita |
| Alineación | Izquierda, centro, derecha y justificado |
| Enlaces e imágenes | **Enlace:** a otra web (`https://…`), a una página del sitio (`/ruta`), a un correo (`mailto:…`) o a un documento de la biblioteca. **Imagen de la biblioteca:** permite subirla en ese momento si tiene permiso. |
| Tablas | Insertar tabla, añadir o eliminar filas y columnas, y eliminar la tabla |

El editor no admite HTML, scripts ni estilos. Si pega texto de otro sitio, se conserva solo el formato que admite la barra.

**Texto alternativo:** cada imagen tiene uno, que describe la imagen para quien no puede verla. Si no se pone en el contenido, se usa el de la biblioteca.

### Versiones

Un contenido guarda su historial completo:

- **Borrador:** se puede editar.
- **En revisión** y **Aprobada:** solo en secciones con aprobación; ya no se pueden editar.
- **Publicada:** es la que se ve en el sitio.
- **Cambios solicitados:** la administración general la devolvió con un comentario, que se consulta en **Revisiones**.
- **Archivada:** una versión publicada que se sustituyó o se retiró.

Solo hay una versión en curso a la vez. Para cambiar un contenido ya publicado, o una versión con cambios solicitados, pulse **Nueva versión**. Se crea un borrador a partir de la versión anterior, y la publicada sigue en el sitio hasta que se publique la nueva. **Descartar** elimina un borrador que ya no se necesita.

### Publicar

- **Sección directa:** en el borrador, **Publicar**.
- **Sección con aprobación:**
  1. en el borrador, **Enviar a revisión**;
  2. la administración general lo ve en **Revisión** y pulsa **Aprobar** o **Solicitar cambios**, con un comentario obligatorio;
  3. una vez aprobada, **Publicar**.

  Lo que se aprueba es exactamente lo que se publica: una versión enviada ya no cambia. La administración general sigue el mismo camino, sin atajos.

### Retirar, archivar, restaurar y eliminar

| Acción | Efecto |
| --- | --- |
| **Despublicar** | Lo retira del sitio al instante. No requiere aprobación. |
| **Archivar** | Lo retira del sitio y lo deja en solo lectura. No es posible con una versión en revisión o aprobada. |
| **Restaurar** | Vuelve a ser un borrador editable. |
| **Eliminar** | Desaparece del panel; no es posible mientras está publicado. Solo se recupera restaurando una copia de seguridad, que hace la administración técnica. |

Cambiar el título no cambia la dirección del contenido, que depende de su *slug*. Si se cambia el slug o la sección padre, la dirección antigua redirige a la nueva.

## Biblioteca multimedia

**Biblioteca multimedia**, en cada sección:

- **Formatos:** se suben imágenes PNG, JPEG y WebP, y documentos PDF, con un máximo de 10 MiB por archivo (valor por defecto).
- **Comprobaciones al subir:** el servidor examina el contenido real del archivo. A las imágenes les quita los metadatos (EXIF, ubicación GPS…) y rechaza los PDF con contenido activo (JavaScript, adjuntos o formularios).
- **Texto alternativo:** cada imagen tiene uno, editable.
- **Archivos en uso:** no se pueden eliminar si los usa algún borrador o alguna versión en revisión, aprobada o publicada. El mensaje indica dónde se usan.
- **Archivos eliminados:** desaparecen de la biblioteca, pero se conservan en el servidor hasta que la administración general los purga.

## Administración general

### Revisión

**Revisión** lista las versiones pendientes de aprobar. Abra cada una, revísela con **Ver** o la vista previa, y pulse **Aprobar** o **Solicitar cambios**.

### Usuarios

**Usuarios** lista todas las cuentas.

- **Alta:** usuario, nombre, correo y contraseña temporal (mínimo 12 caracteres). Comunique la contraseña por un canal seguro: el panel no la vuelve a mostrar.
- **En la ficha de cada usuario:**
  - **Datos:** nombre visible y correo.
  - **Cuenta:**
    - **Suspender** bloquea el acceso y cierra sus sesiones, y **Reactivar** lo devuelve;
    - **Cerrar todas sus sesiones**;
    - **Asignar contraseña temporal**;
    - **Desactivar definitivamente**, que es irreversible.
  - **Secciones y permisos:** **Asignar sección**, marcar los permisos y **Guardar permisos**. **Retirar sección** quita la sección y sus permisos.

La cuenta de administración general no se gestiona desde el panel. Si se pierde su contraseña, se restablece en el servidor con `npm run admin:reset-password`.

### Secciones

- **Nueva sección** (al pie de la lista de secciones): nombre, tipo, sección padre (hasta tres niveles), slug (opcional; se genera del nombre), presentación y tipo de publicación.
- **Configuración** de cada sección: edita esos datos y la descripción.
  - **Activar:** visible en el sitio.
  - **Desactivar:** fuera del sitio, pero se puede seguir preparando.
  - **Archivar:** fuera del sitio y en solo lectura.
  - **Subir** y **Bajar:** cambian el orden.
  - **Eliminar:** solo si está vacía.
- **Secciones del sistema:** las predefinidas no se archivan ni se eliminan.
- **Presentaciones:**
  - **Página:** el primer contenido completo;
  - **Lista** de noticias;
  - **Cuadrícula** con imágenes;
  - **Acordeón** de preguntas;
  - **Lista de documentos.**

### Sistema

| Pestaña | Uso |
| --- | --- |
| **Configuración** | Nombre y descripción del sitio, en texto plano, y la **paleta de colores**. Cada paleta muestra cómo se ve en modo claro y en oscuro. Las marcadas «Exclusiva» son las preparadas para su institución. Al pulsar **Guardar** el sitio cambia de colores al instante. |
| **Auditoría** | Registro de todas las operaciones importantes: accesos, cambios, publicaciones, copias… Se filtra por fecha, acción (por ejemplo `auth.login`, o `backup.` para todas las de copias), resultado y autor. **Verificar la integridad** comprueba que nadie lo ha alterado. Es de solo lectura. |
| **Copias de seguridad** | **Crear copia ahora**, **Verificar** y **Eliminar**. Las automáticas se hacen solas (por defecto cada 24 h; se conservan 14). La restauración la hace la administración técnica, con el servidor detenido (ver [BACKUPS.md](BACKUPS.md)). |
| **Purga de archivos** | Borra definitivamente del servidor los archivos eliminados que nada usa, y los restos de subidas interrumpidas. Primero muestra la lista y después pide confirmación. Las copias anteriores los conservan. |

**Lo que ve el visitante.** En la cabecera del sitio público, **Modo: Automático · Claro · Oscuro**. Cada visitante elige el suyo, y el navegador lo recuerda. Sin elegir, se usa el de su dispositivo. La paleta la decide la administración general; el visitante solo cambia entre claro y oscuro.

## Mensajes frecuentes

| Mensaje | Qué hacer |
| --- | --- |
| «Otra persona guardó cambios en este borrador» | Recargue para ver la versión actual antes de seguir |
| «Ya hay una versión en curso para este contenido» | Continúe con esa versión o descártela |
| «En esta sección hay que enviar a revisión…» | La sección es con aprobación: use **Enviar a revisión** |
| «El archivo se usa en contenidos y no se puede eliminar» | Quítelo antes de esos contenidos |
| «Ese identificador (slug) ya está en uso» | Elija otro slug: lo usa otro contenido o subsección |
| «Demasiados intentos» | Demasiados accesos fallidos: espere hasta 15 minutos |
| «Demasiadas peticiones seguidas» | Espere un minuto |
| «La sesión ha terminado» | Vuelva a entrar |
