/**
 * Sitio público (Bloque 09): HTML generado en el servidor, sin JavaScript.
 *
 * Rutas:
 *   /                          portada
 *   /<ruta-de-sección>         sección con su presentación (?pagina=N)
 *   /<ruta-de-sección>/<slug>  contenido
 *   /media/<id>                archivo de un contenido publicado
 *   /sitemap.xml, /robots.txt, /favicon.ico (204)
 *   /assets/palette.css        colores de la paleta elegida (Bloque 12)
 *   /_modo?m=…&volver=…        preferencia de modo claro/oscuro del visitante (Bloque 12)
 *
 * Visibilidad (lo único que se lee): secciones `active` con todos sus
 * ancestros `active`; contenidos `published` de esas secciones, siempre con su
 * versión publicada. Todo lo demás responde 404 con la misma página que una
 * ruta inexistente, así que no revela qué existe.
 *
 * Una ruta antigua (slug cambiado o sección movida) responde 301 a la actual
 * si el destino es visible (D-055). Respuestas con ETag y `no-cache`: el
 * navegador revalida siempre, y despublicar tiene efecto inmediato.
 */
import { createHash } from 'node:crypto';
import { parseCookies, serializeCookie } from '../../middleware/http.js';
import { isReservedSlug } from '../sections/slug.js';
import { MEDIA_TYPES } from '../media/inspect.js';
import { createMediaStorage } from '../media/storage.js';
import { contentDisposition } from '../media/index.js';
import { renderBody } from '../contents/render.js';
import { createPublicRepository } from './repository.js';
import * as views from './views.js';

export const PUBLIC_CSP = [
  "default-src 'none'", "style-src 'self'", "img-src 'self'", "form-action 'none'", "frame-ancestors 'none'",
  "base-uri 'none'", "object-src 'none'",
].join('; ');

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENTS = 4; // 3 niveles de sección + el contenido
const PAGE_PARAM = /^[1-9][0-9]{0,4}$/;
export const PAGE_SIZE = Object.freeze({ list: 10, document_list: 10, grid: 12, page: 200, accordion: 200 });
export const HOME_LATEST = 6;
const HOME_TYPES = new Set(['news', 'articles']);
const DATED = new Set(['list', 'grid', 'document_list']);
const SITE_DEFAULTS = Object.freeze({ name: 'CMS-MULTISECCIÓN', description: 'Sitio institucional' });

/**
 * Modo de color elegido por el visitante (Bloque 12, D-070). Sin cookie se sigue
 * el del sistema. La cookie solo guarda esa preferencia: no identifica a nadie.
 */
export const MODE_COOKIE = 'site_mode';
export const MODE_PATH = '/_modo';
export const PALETTE_CSS_PATH = '/assets/palette.css';
const MODE_PARAMS = Object.freeze({ auto: null, claro: 'light', oscuro: 'dark' });
const MODE_COOKIE_MAX_AGE = 365 * 24 * 3600;
/**
 * Vuelta tras elegir el modo: solo rutas del propio sitio con la forma de una
 * página pública (slugs y ?pagina=N). Cualquier otra cosa vuelve a la portada,
 * así que el enlace no puede llevar a otro dominio («//otro», «/\otro», esquemas…).
 */
const RETURN_PATH = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3})?(?:\?pagina=[1-9][0-9]{0,4})?$/;
export const safeReturnPath = (value) => (typeof value === 'string' && RETURN_PATH.test(value)
  // Tampoco al panel ni a la API (slugs reservados): la vuelta es siempre a una página pública.
  && !isReservedSlug(value.slice(1).split(/[/?]/)[0], true) ? value : '/');

const etagOf = (text) => `W/"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;

/** ¿El cliente ya tiene esta versión? (If-None-Match con el ETag) */
function notModified(req, etag) {
  const header = req.headers['if-none-match'];
  return typeof header === 'string' && header.split(',').some((t) => t.trim() === etag);
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: { baseUrl: string, storageDir: string },
 *           logger: { error: Function } }} deps
 */
export function createPublicSite({ db, config, logger, themes }) {
  if (!themes) throw new TypeError('createPublicSite requiere el catálogo de paletas');
  const repo = createPublicRepository(db);
  const storage = createMediaStorage(config.storageDir);

  /** Árbol de secciones con su ruta y visibilidad (pocas filas; se lee en cada petición). */
  function loadTree() {
    const rows = repo.sections();
    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const s of byId.values()) (s.parent_id === null ? roots : byId.get(s.parent_id)?.children ?? []).push(s);
    const walk = (list, parent) => {
      for (const s of list) {
        s.path = parent ? `${parent.path}/${s.slug}` : `/${s.slug}`;
        s.visible = s.status === 'active' && (!parent || parent.visible);
        s.ancestors = parent ? [...parent.ancestors, parent] : [];
        walk(s.children, s);
      }
    };
    walk(roots, null);
    return { byId, roots };
  }

  const site = () => ({
    name: repo.setting('site.name', SITE_DEFAULTS.name) || SITE_DEFAULTS.name,
    description: repo.setting('site.description', SITE_DEFAULTS.description),
  });

  const paletteId = () => repo.setting('site.palette', themes.defaultId);
  const modeOf = (req) => {
    const value = parseCookies(req.headers.cookie).get(MODE_COOKIE);
    return value === 'light' || value === 'dark' ? value : null;
  };

  function html(req, status, { title, description, path, current, main, noindex }, tree) {
    const text = views.layout({
      site: site(), baseUrl: config.baseUrl, title, description, path, current, main, noindex, mode: modeOf(req),
      nav: tree.roots.filter((s) => s.visible).map((s) => ({ path: s.path, name: s.name })),
    });
    // La página depende de la cookie de modo: una caché intermedia no debe mezclar versiones.
    return respond(req, status, text, 'text/html; charset=utf-8', { 'Content-Security-Policy': PUBLIC_CSP, Vary: 'Cookie' });
  }

  function respond(req, status, text, type, extra = {}) {
    const etag = etagOf(text);
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, ...extra };
    // El 304 repite las cabeceras propias (sobre todo la CSP): el navegador actualiza con
    // ellas la respuesta guardada, y con la CSP base la página perdería estilos e imágenes.
    if (status === 200 && notModified(req, etag)) return { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache', ...extra } };
    return { status, headers, text };
  }

  function notFound(req, tree = loadTree()) {
    const { title, main } = views.errorPage(404);
    return html(req, 404, { title, main, path: '/', noindex: true }, tree);
  }

  /** Datos de presentación de un contenido publicado. */
  function present(row, section, { withBody }) {
    const item = {
      slug: row.slug, path: `${section.path}/${row.slug}`, title: row.title, summary: row.summary, publishedAt: row.published_at,
    };
    if (!withBody) return item;
    const media = repo.versionMedia(row.version_id);
    const info = new Map(media.map((m) => [m.id, { width: m.width, height: m.height, alt: m.alt_text }]));
    const doc = JSON.parse(row.body);
    const src = (id) => `/media/${id}`;
    item.html = renderBody(doc, { mediaSrc: src, mediaHref: src, media: info });
    item.files = media.filter((m) => MEDIA_TYPES[m.mime_type]?.kind === 'document')
      .map((m) => ({ id: m.id, name: m.original_name, extension: m.extension, size: m.size_bytes }));
    const firstImage = doc.content?.find((n) => n.type === 'image' && info.has(n.attrs.mediaId));
    if (firstImage) {
      const m = info.get(firstImage.attrs.mediaId);
      item.image = { src: src(firstImage.attrs.mediaId), width: m.width, height: m.height };
    }
    return item;
  }

  /**
   * Resuelve los segmentos de la ruta a una sección y, opcionalmente, un contenido.
   * Sigue las redirecciones registradas (`redirected`). No mira la visibilidad.
   */
  function resolve(tree, segments) {
    let section = null;
    let redirected = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const last = i === segments.length - 1;
      const siblings = section ? section.children : tree.roots;
      const child = siblings.find((s) => s.slug === seg);
      if (child) {
        section = child;
        continue;
      }
      if (last && section) {
        const content = repo.bySlug(section.id, seg);
        if (content) return { section, content, redirected };
      }
      const movedId = repo.sectionRedirect(section?.id ?? null, seg);
      if (movedId !== null && tree.byId.has(movedId)) {
        section = tree.byId.get(movedId);
        redirected = true;
        continue;
      }
      if (last && section) {
        const contentId = repo.contentRedirect(section.id, seg);
        const content = contentId === null ? null : repo.publishedById(contentId);
        if (content && content.section_id === section.id) return { section, content: { ...content, status: 'published' }, redirected: true };
      }
      return null;
    }
    return section ? { section, content: null, redirected } : null;
  }

  // ---------------------------------------------------------------------------

  function home(req, tree) {
    const visible = [...tree.byId.values()].filter((s) => s.visible);
    const latest = visible.filter((s) => HOME_TYPES.has(s.type))
      .flatMap((s) => repo.list(s.id, { order: 'recent', limit: HOME_LATEST, offset: 0 }).map((r) => present(r, s, { withBody: false })))
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, HOME_LATEST);
    const main = views.homePage({ site: site(), sections: tree.roots.filter((s) => s.visible), latest });
    return html(req, 200, { title: null, path: '/', current: '/', main }, tree);
  }

  function sectionView(req, tree, section, query) {
    const raw = query.get('pagina');
    if (raw !== null && !PAGE_PARAM.test(raw)) return notFound(req, tree);
    const page = raw === null ? 1 : Number(raw);
    const size = PAGE_SIZE[section.presentation] ?? PAGE_SIZE.list;
    const total = repo.count(section.id);
    const pages = Math.max(1, Math.ceil(total / size));
    if (page > pages) return notFound(req, tree);
    const order = DATED.has(section.presentation) ? 'recent' : 'manual';
    const withBody = section.presentation !== 'list';
    const items = repo.list(section.id, { order, limit: size, offset: (page - 1) * size })
      .map((r) => present(r, section, { withBody }));
    const main = views.sectionPage({
      section, page, pages, items,
      crumbs: [...section.ancestors, section].map((s) => ({ name: s.name, path: s.path })),
      children: section.children.filter((c) => c.visible),
    });
    return html(req, 200, {
      title: page > 1 ? `${section.name} (página ${page})` : section.name, description: section.description,
      path: page > 1 ? `${section.path}?pagina=${page}` : section.path, current: section.path, main,
    }, tree);
  }

  function contentView(req, tree, section, row) {
    const item = present(row, section, { withBody: true });
    const main = views.contentPage({
      item, showDate: DATED.has(section.presentation),
      crumbs: [...section.ancestors, section, { name: item.title, path: item.path }].map((s) => ({ name: s.name ?? s.title, path: s.path })),
    });
    return html(req, 200, { title: item.title, description: item.summary, path: item.path, current: section.path, main }, tree);
  }

  /** Página pública (GET/HEAD). */
  function page(req, url) {
    const tree = loadTree();
    try {
      const { pathname } = url;
      if (pathname === '/') return home(req, tree);
      // Barra final: 301 a la ruta sin ella, solo si todos los segmentos son slugs válidos
      // (así el destino empieza siempre por "/<slug>" y no puede ser "//otro-dominio").
      const trailing = pathname.endsWith('/');
      const segments = (trailing ? pathname.slice(1, -1) : pathname.slice(1)).split('/');
      if (segments.length > MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) return notFound(req, tree);
      if (trailing) return { status: 301, headers: { Location: `/${segments.join('/')}${url.search}`, 'Cache-Control': 'no-cache' } };

      const found = resolve(tree, segments);
      if (!found || !found.section.visible) return notFound(req, tree);
      const { section, content, redirected } = found;
      if (content && content.status !== 'published') return notFound(req, tree);
      if (redirected) {
        const target = content ? `${section.path}/${content.slug}` : section.path;
        if (target !== pathname) return { status: 301, headers: { Location: target + url.search, 'Cache-Control': 'no-cache' } };
      }
      return content ? contentView(req, tree, section, content) : sectionView(req, tree, section, url.searchParams);
    } catch (err) {
      logger.error('Error al generar una página pública', { err });
      const { title, main } = views.errorPage(500);
      return html(req, 500, { title, main, path: '/', noindex: true }, tree);
    }
  }

  /** Archivo público: solo si lo usa la versión publicada de un contenido visible. */
  async function media(ctx) {
    const rows = repo.mediaPublication(ctx.params.id);
    const tree = loadTree();
    const row = rows.find((r) => tree.byId.get(r.section_id)?.visible);
    if (!row) return notFound(ctx.req, tree);
    const etag = `"${row.sha256}"`;
    const cache = { ETag: etag, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'" };
    if (notModified(ctx.req, etag)) return { status: 304, headers: cache };
    const opened = await storage.open(row.storage_key);
    if (!opened) {
      logger.error('Falta el archivo de un registro multimedia', { mediaId: row.id });
      return notFound(ctx.req, tree);
    }
    const isImage = MEDIA_TYPES[row.mime_type]?.kind === 'image';
    return {
      status: 200,
      stream: opened.stream,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Length': String(opened.size),
        'Content-Disposition': contentDisposition(isImage ? 'inline' : 'attachment', row.original_name),
        ...cache,
      },
    };
  }

  function sitemapXml(ctx) {
    const tree = loadTree();
    const entries = [{ path: '/' }];
    for (const s of tree.byId.values()) if (s.visible) entries.push({ path: s.path });
    for (const c of repo.allPublished()) {
      const s = tree.byId.get(c.section_id);
      if (s?.visible) entries.push({ path: `${s.path}/${c.slug}`, lastmod: c.published_at });
    }
    return respond(ctx.req, 200, views.sitemap(config.baseUrl, entries), 'application/xml; charset=utf-8');
  }

  function robotsTxt(ctx) {
    const text = `User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: ${MODE_PATH}\nSitemap: ${config.baseUrl}/sitemap.xml\n`;
    return respond(ctx.req, 200, text, 'text/plain; charset=utf-8');
  }

  /** Colores de la paleta elegida por la administración general (generados, nunca CSS libre). */
  function paletteCss(ctx) {
    return respond(ctx.req, 200, themes.css(paletteId()), 'text/css; charset=utf-8', { 'Content-Security-Policy': PUBLIC_CSP });
  }

  /**
   * Guarda el modo del visitante y vuelve a la página. Es un GET porque el sitio
   * no tiene JavaScript ni formularios (CSP form-action 'none'); solo cambia una
   * preferencia de presentación del propio navegador, sin efecto en el servidor.
   */
  function setMode(ctx) {
    const url = new URL(ctx.req.url, 'http://localhost');
    const param = url.searchParams.get('m');
    const headers = { Location: safeReturnPath(url.searchParams.get('volver')), 'Cache-Control': 'no-store' };
    if (param === null || !Object.hasOwn(MODE_PARAMS, param)) return { status: 303, headers };
    const mode = MODE_PARAMS[param];
    const secure = config.baseUrl.startsWith('https:');
    // Lax: la preferencia también se aplica al llegar desde un enlace de otro sitio.
    const cookie = serializeCookie(MODE_COOKIE, mode ?? '', { maxAge: mode ? MODE_COOKIE_MAX_AGE : 0, secure, sameSite: 'Lax' });
    return { status: 303, headers, cookies: [cookie] };
  }

  const get = (path, handler) => [{ method: 'GET', path, handler }, { method: 'HEAD', path, handler }];
  return Object.freeze({
    /** ¿Debe atender el sitio público una ruta que no es de la API? */
    owns: (pathname) => !pathname.startsWith('/api/') && pathname !== '/api',
    page,
    routes: [
      ...get('/media/:id', media),
      ...get('/sitemap.xml', sitemapXml),
      ...get('/robots.txt', robotsTxt),
      ...get(PALETTE_CSS_PATH, paletteCss),
      { method: 'GET', path: MODE_PATH, handler: setMode },
      // Sin icono propio todavía: 204 evita un 404 en cada visita (D-057).
      ...get('/favicon.ico', () => ({ status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } })),
    ],
  });
}
