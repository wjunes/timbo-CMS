/**
 * Plantillas HTML del sitio público (Bloque 09).
 *
 * Son código del sistema: los administradores no pueden editarlas ni subir otras.
 * Todo dato se escapa con `escapeHtml` (texto y atributos); el cuerpo de los
 * contenidos llega ya renderizado por `renderBody`, que también escapa. Ni
 * scripts, ni estilos ni manejadores en línea: la CSP pública no los admite.
 */
import { escapeHtml as e } from '../contents/render.js';

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'long' });
const isoDate = (iso) => iso.slice(0, 10);
export const formatDate = (iso) => dateFormat.format(new Date(iso));

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

const time = (iso) => `<time datetime="${e(isoDate(iso))}">${e(formatDate(iso))}</time>`;

const MODE_OPTIONS = Object.freeze([['auto', null, 'Automático'], ['claro', 'light', 'Claro'], ['oscuro', 'dark', 'Oscuro']]);

/**
 * Selector de modo sin JavaScript (Bloque 12, D-070): enlaces que guardan la
 * preferencia en una cookie y vuelven a la misma página.
 */
export function modeSwitch(mode, returnPath) {
  const back = encodeURIComponent(returnPath);
  return `<nav class="mode-switch" aria-label="Modo de color"><span>Modo:</span><ul>${MODE_OPTIONS.map(([param, value, label]) => `<li><a href="/_modo?m=${param}&amp;volver=${e(back)}" rel="nofollow"${value === mode ? ' aria-current="true"' : ''}>${label}</a></li>`).join('')}</ul></nav>`;
}

/**
 * @param {{ site: { name: string, description: string }, baseUrl: string, title: string|null, description?: string,
 *           path: string, nav: { path: string, name: string }[], current?: string, main: string, noindex?: boolean,
 *           mode?: 'light'|'dark'|null }} p
 *   mode: preferencia del visitante (cookie); null sigue el modo del sistema.
 */
export function layout({ site, baseUrl, title, description, path, nav, current, main, noindex = false, mode = null }) {
  const fullTitle = title ? `${title} · ${site.name}` : site.name;
  const links = nav.map((s) => {
    const active = current === s.path || current?.startsWith(`${s.path}/`);
    return `<li><a href="${e(s.path)}"${active ? ' aria-current="page"' : ''}>${e(s.name)}</a></li>`;
  }).join('');
  return `<!doctype html>
<html lang="es"${mode ? ` data-mode="${e(mode)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(fullTitle)}</title>
<meta name="description" content="${e(description || site.description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${e(baseUrl + path)}">`}
<link rel="stylesheet" href="/assets/site.css">
<link rel="stylesheet" href="/assets/palette.css">
</head>
<body>
<a class="skip" href="#contenido">Saltar al contenido</a>
<header class="site-header">
<div class="wrap">
<a class="brand" href="/">${e(site.name)}</a>
<nav class="site-nav" aria-label="Secciones"><ul>${links}</ul></nav>
${modeSwitch(mode, path)}
</div>
</header>
<main id="contenido" class="wrap" tabindex="-1">
${main}
</main>
<footer class="site-footer"><div class="wrap"><p>${e(site.name)}</p><p><a href="/sitemap.xml">Mapa del sitio</a></p></div></footer>
</body>
</html>
`;
}

export function breadcrumbs(items) {
  if (items.length === 0) return '';
  const parts = [{ name: 'Inicio', path: '/' }, ...items];
  return `<nav class="crumbs" aria-label="Ruta"><ol>${parts.map((p, i) => (i === parts.length - 1
    ? `<li><span aria-current="page">${e(p.name)}</span></li>`
    : `<li><a href="${e(p.path)}">${e(p.name)}</a></li>`)).join('')}</ol></nav>`;
}

/** Tarjeta o elemento de lista de un contenido. `image`: { src, alt, width, height } opcional. */
function teaser(item, { image = null, showDate = true, headingLevel = 2 } = {}) {
  const h = `h${headingLevel}`;
  return `<article class="teaser">
${image ? `<a class="teaser-image" href="${e(item.path)}" tabindex="-1" aria-hidden="true"><img src="${e(image.src)}" alt="" width="${e(image.width)}" height="${e(image.height)}" loading="lazy" decoding="async"></a>` : ''}
<${h}><a href="${e(item.path)}">${e(item.title)}</a></${h}>
${showDate ? `<p class="meta">${time(item.publishedAt)}</p>` : ''}
${item.summary ? `<p>${e(item.summary)}</p>` : ''}
</article>`;
}

function documents(files) {
  if (!files.length) return '';
  return `<ul class="documents">${files.map((f) => `<li><a href="/media/${e(f.id)}" download>${e(f.name)}</a> <span class="meta">${e(f.extension.toUpperCase())}, ${e(formatBytes(f.size))}</span></li>`).join('')}</ul>`;
}

export function pagination(path, page, pages) {
  if (pages <= 1) return '';
  const href = (n) => (n === 1 ? path : `${path}?pagina=${n}`);
  return `<nav class="pagination" aria-label="Páginas">
${page > 1 ? `<a rel="prev" href="${e(href(page - 1))}">← Anteriores</a>` : '<span></span>'}
<span>Página ${page} de ${pages}</span>
${page < pages ? `<a rel="next" href="${e(href(page + 1))}">Siguientes →</a>` : '<span></span>'}
</nav>`;
}

function subsections(children) {
  if (!children.length) return '';
  return `<nav class="subsections" aria-label="Subsecciones"><h2>En esta sección</h2><ul>${children.map((c) => `<li><a href="${e(c.path)}">${e(c.name)}</a>${c.description ? `<span>${e(c.description)}</span>` : ''}</li>`).join('')}</ul></nav>`;
}

/**
 * Página de una sección según su presentación (catálogo del sistema, D-027).
 * @param {{ section, crumbs, children, items, page, pages }} p
 *   items: [{ path, title, summary, publishedAt, html?, image?, files? }]
 */
export function sectionPage({ section, crumbs, children, items, page, pages }) {
  const head = `${breadcrumbs(crumbs)}<header class="page-header"><h1>${e(section.name)}</h1>${section.description ? `<p class="lead">${e(section.description)}</p>` : ''}</header>`;
  let body;
  if (!items.length) {
    body = '<p class="empty">Todavía no hay contenidos publicados en esta sección.</p>';
  } else {
    switch (section.presentation) {
      case 'page': {
        const [first, ...rest] = items;
        body = `<article class="content"><h2 class="visually-hidden">${e(first.title)}</h2>${first.summary ? `<p class="summary">${e(first.summary)}</p>` : ''}<div class="body">${first.html}</div>${documents(first.files)}</article>`
          + (rest.length ? `<nav class="related" aria-label="Más páginas"><h2>Más en ${e(section.name)}</h2><ul>${rest.map((i) => `<li><a href="${e(i.path)}">${e(i.title)}</a></li>`).join('')}</ul></nav>` : '');
        break;
      }
      case 'grid':
        body = `<div class="grid">${items.map((i) => teaser(i, { image: i.image })).join('')}</div>`;
        break;
      case 'accordion':
        body = `<div class="accordion">${items.map((i) => `<details id="${e(i.slug)}"><summary>${e(i.title)}</summary><div class="body">${i.html}</div>${documents(i.files)}<p class="meta"><a href="${e(i.path)}">Enlace permanente</a></p></details>`).join('')}</div>`;
        break;
      case 'document_list':
        body = `<div class="doc-list">${items.map((i) => `<article class="teaser"><h2><a href="${e(i.path)}">${e(i.title)}</a></h2><p class="meta">${time(i.publishedAt)}</p>${i.summary ? `<p>${e(i.summary)}</p>` : ''}${documents(i.files)}</article>`).join('')}</div>`;
        break;
      default: // 'list'
        body = `<div class="list">${items.map((i) => teaser(i)).join('')}</div>`;
    }
  }
  return `${head}${body}${pagination(section.path, page, pages)}${subsections(children)}`;
}

/** Página de un contenido. */
export function contentPage({ item, crumbs, showDate }) {
  return `${breadcrumbs(crumbs)}<article class="content">
<header class="page-header"><h1>${e(item.title)}</h1>${showDate ? `<p class="meta">Publicado el ${time(item.publishedAt)}</p>` : ''}${item.summary ? `<p class="lead">${e(item.summary)}</p>` : ''}</header>
<div class="body">${item.html}</div>
${item.files.length ? `<section class="attachments"><h2>Documentos</h2>${documents(item.files)}</section>` : ''}
</article>`;
}

export function homePage({ site, sections, latest }) {
  return `<header class="page-header home"><h1>${e(site.name)}</h1><p class="lead">${e(site.description)}</p></header>
${latest.length ? `<section aria-labelledby="ultimas"><h2 id="ultimas">Últimas publicaciones</h2><div class="grid">${latest.map((i) => teaser(i, { headingLevel: 3 })).join('')}</div></section>` : ''}
${sections.length ? `<section aria-labelledby="secciones"><h2 id="secciones">Secciones</h2><ul class="section-cards">${sections.map((s) => `<li><a href="${e(s.path)}">${e(s.name)}</a>${s.description ? `<p>${e(s.description)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

export function errorPage(status) {
  const text = status === 404
    ? ['Página no encontrada', 'La dirección no existe o el contenido ya no está publicado.']
    : ['Error del servidor', 'No se pudo mostrar la página. Inténtalo de nuevo más tarde.'];
  return { title: text[0], main: `<header class="page-header"><h1>${e(text[0])}</h1><p class="lead">${e(text[1])}</p></header><p><a href="/">Volver al inicio</a></p>` };
}

/** sitemap.xml (las URL se escapan como XML). */
export function sitemap(baseUrl, entries) {
  const xml = (s) => e(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((u) => `<url><loc>${xml(baseUrl + u.path)}</loc>${u.lastmod ? `<lastmod>${xml(isoDate(u.lastmod))}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}
