# Paletas de color y modo claro/oscuro

Implementado en el Bloque 12. Código en [`backend/modules/themes/`](../backend/modules/themes/). Decisiones D-068 a D-071.

| Quién | Qué elige | Dónde |
| --- | --- | --- |
| Administración general | La paleta de colores del sitio público | Panel, **Sistema → Configuración** |
| Visitante | Modo claro, oscuro o automático, solo para su navegador | Cabecera del sitio |
| Cada administrador | Modo claro, oscuro o automático del panel | Barra superior del panel; se guarda en su perfil |

## Paletas del sitio

Una paleta son **solo datos**: nueve colores `#rrggbb` para el modo claro y otros nueve para el oscuro. Nunca CSS libre.

| Color | Uso |
| --- | --- |
| `bg` | Fondo de la página |
| `surface` | Tarjetas, acordeón, cabeceras de tabla |
| `text` | Texto principal |
| `muted` | Fechas, resúmenes, migas de pan |
| `border` | Bordes y separadores |
| `accent` | Enlaces y foco del teclado |
| `accentStrong` | Enlaces al pasar el ratón |
| `headerBg` | Fondo de la cabecera |
| `headerText` | Texto de la cabecera, menú y selector de modo |

**Catálogo de serie:** `azul` (la predeterminada, que es el aspecto original del sitio), `verde`, `granate` y `grafito`. Son tonos genéricos, sin colores de ninguna institución.

**Cómo se aplica:**

- el servidor genera `/assets/palette.css` con las variables de la paleta elegida, en sus dos modos;
- `site.css` no define ningún color; solo usa esas variables;
- la hoja se revalida en cada visita (ETag con `no-cache`), así que un cambio de paleta se ve al instante;
- si la paleta guardada ya no existe, por ejemplo porque se retiró `THEMES_FILE`, se usa la predeterminada.

### Contraste mínimo (WCAG AA)

Toda paleta, también las de serie, debe alcanzar **4,5:1** en los dos modos en estos pares:

- `text`, `muted`, `accent` y `accentStrong` sobre `bg` y sobre `surface`;
- `headerText` sobre `headerBg`.

`border` es decorativo y no se exige. El foco usa `accent`, que ya supera el 3:1 que pide WCAG para elementos no textuales.

La comprobación la hace el servidor al arrancar. Si una paleta no la cumple, **el servidor no arranca** e indica la paleta, el modo, el par y la razón obtenida. `npm run check` la hace también. Las pruebas automáticas la repiten para las de serie y para el ejemplo.

## Paletas exclusivas de un cliente (`THEMES_FILE`)

Los colores institucionales de un cliente se preparan para su instalación y **no se añaden al repositorio común**. Así ningún cliente ve las paletas de otro, y personalizar no exige cambiar código.

1. Cree un archivo JSON fuera de `frontend/`, por ejemplo `/etc/cms-multiseccion/themes.json`, a partir de [`deploy/themes.example.json`](../deploy/themes.example.json):

   ```json
   { "palettes": [ { "id": "cliente", "name": "Cliente", "light": { "bg": "#…", "…": "…" }, "dark": { "…": "…" } } ] }
   ```

2. Indique su ruta en `THEMES_FILE`, en el entorno del servicio.
3. Compruébelo con `npm run check` y reinicie el servicio.
4. La paleta aparece en **Sistema → Configuración** con la etiqueta «Exclusiva». La elige la administración general.

**Reglas del archivo:**

- **Estructura:** exactamente `{ "palettes": [ … ] }`, con 1 a 50 paletas y un máximo de 256 KiB.
- **Campos admitidos:** `id`, `name`, `light` y `dark`. Cualquier campo o color que no esté en la lista es un error.
- **`id`:** de 1 a 40 caracteres `a-z`, `0-9` y guiones. No puede repetirse ni coincidir con una paleta de serie.
- **`name`:** texto de 1 a 60 caracteres, sin `<` ni `>`.
- **Colores:** los nueve colores en cada modo, en formato `#rrggbb`. Se normalizan a minúsculas.
- **Contraste:** el mínimo de la sección anterior.

Las paletas se leen al arrancar. Para cambiar el archivo hay que reiniciar el servicio.

## Modo del visitante

El selector **Modo: Automático · Claro · Oscuro** está en la cabecera de todas las páginas y funciona sin JavaScript:

1. Cada opción es un enlace a `/_modo?m=<auto|claro|oscuro>&volver=<página actual>`.
2. El servidor guarda la preferencia en la cookie `site_mode` (`light` o `dark`) y responde `303` a la página. **Automático** borra la cookie.
3. Con la cookie, la página lleva `data-mode` en `<html>`. Sin ella sigue el modo del sistema operativo (`prefers-color-scheme`).

**La cookie `site_mode`:**

- Solo guarda la preferencia de presentación: no identifica a nadie, no se usa para nada más y no se registra.
- Por eso, como preferencia pedida por el propio visitante, no requiere aviso de consentimiento. Conviene confirmarlo con la normativa aplicable a cada cliente.
- Atributos: `HttpOnly`, `SameSite=Lax`, `Path=/` y un año de duración. Lleva `Secure` cuando el sitio se sirve por `https`.
- Es `Lax` y no `Strict` para que la preferencia se respete también al llegar desde un enlace de otro sitio.

**Validación de la vuelta.** Solo se acepta una ruta con la forma de una página pública:

- hasta cuatro slugs y, opcionalmente, `?pagina=N`;
- nunca `/admin`, `/api`, `/assets` ni `/media`.

Cualquier otro valor vuelve a la portada: otro dominio, `//`, barras invertidas, esquemas o saltos de línea. Esto impide usar el enlace como redirección abierta.

**Caché:** las páginas llevan `Vary: Cookie`, y su ETag cambia con el modo, así que nunca se sirve una versión guardada en el otro modo. `/_modo` responde `no-store`, solo admite GET y `robots.txt` lo excluye.

## Modo del panel

- **Dónde se elige:** en la barra superior del panel (**Modo: Automático / Claro / Oscuro**). Se guarda en el perfil del usuario y se aplica en cualquier equipo.
- **API:** `PUT /api/auth/preferences` con `{ "uiMode": "auto" | "light" | "dark" }`. Responde `200 { user }`.
  - Exige sesión, token CSRF y la contraseña definitiva.
  - No se audita, porque es una preferencia personal que no concede nada.
  - La sesión (`GET /api/auth/session`) y el inicio de sesión devuelven `user.uiMode`.
- **Colores:** el panel tiene sus propios colores neutros, independientes de la paleta del sitio.
  - Todos son variables de `admin.css`, con una variante clara y otra oscura.
  - Una prueba comprueba el contraste AA de texto, enlaces, avisos y etiquetas en los dos modos.
- **Almacenamiento:** columna `users.ui_mode` (migración 009), con `'auto'` por defecto.
- **Antes de iniciar sesión** el panel sigue el modo del sistema.

## Seguridad

- **Sin CSS libre:** una paleta no puede inyectar CSS ni código. El servidor solo escribe en la hoja colores validados con `^#[0-9a-f]{6}$`, y la prueba lo comprueba.
- **Solo paletas del catálogo:** la API de configuración solo admite un id del catálogo (`400 validation_failed` para cualquier otro valor). Solo la usa `general_admin`, y cada cambio se audita (`settings.update`).
- **Muestras del panel:** las pinta la API CSSOM (`style.setProperty`) con valores `#rrggbb`, sin atributos `style`. La CSP del panel no cambia.
- **Sitio público:** la CSP no cambia. `/assets/palette.css` se sirve del propio origen con la CSP pública.
- **`THEMES_FILE`:** se valida como las demás rutas de datos: no puede estar dentro de `frontend/`.

## Limitaciones

- El modo del visitante cuesta una petición más: el enlace, que redirige a la misma página.
- Los colores del panel no se personalizan por cliente; solo los del sitio público.
