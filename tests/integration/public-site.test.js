/**
 * Sitio público (Bloque 09): portada, presentaciones, contenidos, jerarquía,
 * visibilidad, redirecciones, paginación, archivos, sitemap y caché.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';
import { makePdf, makePng, upload } from '../helpers/media.js';

let app;
let api; // general_admin

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const NEWS = 2; // 'noticias', presentación list, flujo approval

async function call(path, { method = 'POST', body, expected = 200 } = {}) {
  const r = await api.json(path, { method, body });
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
  return r.body;
}

const doc = (...content) => ({ type: 'doc', content });
const p = (text, marks) => ({ type: 'paragraph', content: [marks ? { type: 'text', text, marks } : { type: 'text', text }] });
const img = (mediaId, alt = '') => ({ type: 'image', attrs: { mediaId, alt } });
const docLink = (mediaId, text = 'Bases') => p(text, [{ type: 'link', attrs: { href: `/media/${mediaId}` } }]);

async function section(body) {
  return (await call('/api/sections', { body: { workflow: 'direct', ...body }, expected: 201 })).section;
}

/** Crea y publica un contenido (en secciones 'approval', pasando por envío y aprobación). */
async function publish(sectionId, { title, summary = '', body = doc(p(`Texto de ${title}`)), slug } = {}) {
  const created = await call(`/api/sections/${sectionId}/contents`, { body: { title, summary, body, ...(slug ? { slug } : {}) }, expected: 201 });
  const { content, version } = created;
  const v = `/api/contents/${content.id}/versions/${version.id}`;
  const { section: s } = await call(`/api/sections/${sectionId}`, { method: 'GET' });
  if (s.workflow === 'approval') {
    await call(`${v}/submit`, { body: { revision: 1 } });
    await call(`${v}/approve`, { body: {} });
    await call(`${v}/publish`, { body: {} });
  } else {
    await call(`${v}/publish`, { body: { revision: 1 } });
  }
  return { content, version };
}

async function page(path, headers = {}) {
  const res = await app.request(path, { headers });
  return { status: res.status, headers: res.headers, html: await res.text() };
}

const uploadOk = async (sectionId, buffer = makePng({ width: 40, height: 30 }), opts) => {
  const r = await upload(api, sectionId, buffer, opts);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.media;
};

describe('sitio público: portada y navegación', () => {
  it('muestra el nombre del sitio, las secciones visibles y las últimas publicaciones', async () => {
    await publish(NEWS, { title: 'Primera noticia', summary: 'Resumen uno' });
    await publish(NEWS, { title: 'Segunda noticia' });
    await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Borrador oculto' }, expected: 201 });
    await call('/api/sections/5/deactivate', {});
    const { status, headers, html } = await page('/');
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(html, /<title>CMS-MULTISECCIÓN<\/title>/);
    assert.match(html, /<a href="\/noticias">Noticias<\/a>/);
    assert.doesNotMatch(html, /preguntas-frecuentes/, 'sección inactiva fuera de la navegación');
    assert.ok(html.indexOf('Segunda noticia') < html.indexOf('Primera noticia'), 'de la más reciente a la más antigua');
    assert.doesNotMatch(html, /Borrador oculto/);
    assert.match(html, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:3000\/">/);
  });

  it('las publicaciones de una sección no visible no aparecen en la portada', async () => {
    const agenda = await section({ name: 'Agenda', type: 'news', parentId: NEWS });
    await publish(agenda.id, { title: 'Concierto de agenda' });
    assert.match((await page('/')).html, /Concierto de agenda/);
    await call(`/api/sections/${NEWS}/deactivate`, {}); // el ancestro deja de ser visible
    assert.doesNotMatch((await page('/')).html, /Concierto de agenda/);
  });

  it('el nombre y la descripción del sitio salen de settings', async () => {
    app.db.prepare("UPDATE settings SET value = '\"Ayuntamiento\"' WHERE key = 'site.name'").run();
    app.db.prepare("UPDATE settings SET value = '\"Portal municipal\"' WHERE key = 'site.description'").run();
    const { html } = await page('/');
    assert.match(html, /<title>Ayuntamiento<\/title>/);
    assert.match(html, /<meta name="description" content="Portal municipal">/);
  });
});

describe('sitio público: secciones y contenidos', () => {
  it('lista (noticias): del más reciente al más antiguo, con fecha y resumen; página del contenido', async () => {
    const { content } = await publish(NEWS, { title: 'Convocatoria 2027', summary: 'Plazo abierto' });
    const list = await page('/noticias');
    assert.equal(list.status, 200);
    assert.match(list.html, /<h1>Noticias<\/h1>/);
    assert.match(list.html, /<a href="\/noticias\/convocatoria-2027">Convocatoria 2027<\/a>/);
    assert.match(list.html, /<p>Plazo abierto<\/p>/);
    assert.match(list.html, /<time datetime="\d{4}-\d{2}-\d{2}">/);

    const item = await page(`/noticias/${content.slug}`);
    assert.equal(item.status, 200);
    assert.match(item.html, /<title>Convocatoria 2027 · CMS-MULTISECCIÓN<\/title>/);
    assert.match(item.html, /<meta name="description" content="Plazo abierto">/);
    assert.match(item.html, /<p>Texto de Convocatoria 2027<\/p>/);
    assert.match(item.html, /Publicado el <time/);
    assert.match(item.html, /<li><a href="\/noticias">Noticias<\/a><\/li>/, 'migas de pan');
  });

  it('muestra la versión publicada aunque haya otra en borrador', async () => {
    const { content } = await publish(NEWS, { title: 'Original', body: doc(p('Texto publicado')) });
    const { version: v2 } = await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 });
    await call(`/api/contents/${content.id}/versions/${v2.id}`, { method: 'PATCH', body: { revision: 1, title: 'Cambiado', body: doc(p('Texto en borrador')) } });
    const { html } = await page(`/noticias/${content.slug}`);
    assert.match(html, /Texto publicado/);
    assert.doesNotMatch(html, /Texto en borrador|Cambiado/);
  });

  it('presentación page: el primer contenido completo y enlaces a los demás', async () => {
    await publish(1, { title: 'Quiénes somos', body: doc(p('Historia de la institución')) });
    await publish(1, { title: 'Organigrama' });
    const { html } = await page('/institucional');
    assert.match(html, /Historia de la institución/);
    assert.match(html, /Más en Institucional/);
    assert.match(html, /<a href="\/institucional\/organigrama">Organigrama<\/a>/);
  });

  it('presentación accordion: preguntas desplegables con su respuesta', async () => {
    await publish(5, { title: '¿Cómo me inscribo?', body: doc(p('Desde la sede electrónica')) });
    const { html } = await page('/preguntas-frecuentes');
    assert.match(html, /<details id="como-me-inscribo"><summary>¿Cómo me inscribo\?<\/summary><div class="body"><p>Desde la sede electrónica<\/p><\/div>/);
  });

  it('presentación grid: tarjetas con la primera imagen', async () => {
    const s = await section({ name: 'Galería', type: 'news', presentation: 'grid' });
    const m = await uploadOk(s.id);
    await publish(s.id, { title: 'Inauguración', body: doc(p('Acto'), img(m.id, 'Corte de cinta')) });
    const { html } = await page('/galeria');
    assert.match(html, new RegExp(`<img src="/media/${m.id}" alt="" width="40" height="30" loading="lazy"`));
  });

  it('presentación document_list: documentos de cada contenido con tipo y tamaño', async () => {
    const pdf = await uploadOk(4, makePdf(), { type: 'application/pdf', name: 'Memoria 2026.pdf' });
    await publish(4, { title: 'Memoria anual', body: doc(docLink(pdf.id, 'Descargar memoria')) });
    const { html } = await page('/biblioteca');
    assert.match(html, new RegExp(`<a href="/media/${pdf.id}" download>Memoria 2026.pdf</a> <span class="meta">PDF, \\d+ B</span>`));
  });

  it('imagen y documento en la página del contenido, servidos por /media', async () => {
    const m = await uploadOk(NEWS);
    await call(`/api/media/${m.id}`, { method: 'PATCH', body: { altText: 'Fachada' } });
    const pdf = await uploadOk(NEWS, makePdf(), { type: 'application/pdf', name: 'bases.pdf' });
    const { content } = await publish(NEWS, { title: 'Con archivos', body: doc(img(m.id), docLink(pdf.id)) });
    const { html } = await page(`/noticias/${content.slug}`);
    assert.match(html, new RegExp(`<img src="/media/${m.id}" alt="Fachada" width="40" height="30"`), 'alt de la biblioteca si el nodo no lo tiene');
    assert.match(html, new RegExp(`<a href="/media/${pdf.id}">Bases</a>`));
    assert.match(html, /<h2>Documentos<\/h2>/);
  });

  it('subsecciones: URL jerárquica, listado en la sección padre y migas', async () => {
    const agenda = await section({ name: 'Agenda', type: 'news', parentId: NEWS });
    await publish(agenda.id, { title: 'Concierto' });
    const parent = await page('/noticias');
    assert.match(parent.html, /<a href="\/noticias\/agenda">Agenda<\/a>/);
    const child = await page('/noticias/agenda/concierto');
    assert.equal(child.status, 200);
    assert.match(child.html, /<li><a href="\/noticias\/agenda">Agenda<\/a><\/li>/);
  });

  it('paginación: 10 por página; páginas fuera de rango o mal formadas dan 404', async () => {
    for (let i = 1; i <= 11; i++) await publish(NEWS, { title: `Noticia ${i}` });
    const first = await page('/noticias');
    assert.equal((first.html.match(/class="teaser"/g) ?? []).length, 10);
    assert.match(first.html, /<a rel="next" href="\/noticias\?pagina=2">/);
    const second = await page('/noticias?pagina=2');
    assert.equal((second.html.match(/class="teaser"/g) ?? []).length, 1);
    assert.match(second.html, /Noticia 1</);
    assert.match(second.html, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:3000\/noticias\?pagina=2">/);
    for (const q of ['?pagina=3', '?pagina=0', '?pagina=abc', '?pagina=-1', '?pagina=1e2']) assert.equal((await page(`/noticias${q}`)).status, 404, q);
  });
});

describe('sitio público: visibilidad', () => {
  it('borradores, contenidos en revisión, despublicados, archivados y eliminados no existen', async () => {
    const draft = (await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Borrador' }, expected: 201 })).content;
    const review = await call(`/api/sections/${NEWS}/contents`, { body: { title: 'En revisión' }, expected: 201 });
    await call(`/api/contents/${review.content.id}/versions/${review.version.id}/submit`, { body: { revision: 1 } });
    const unpublished = (await publish(NEWS, { title: 'Despublicado' })).content;
    await call(`/api/contents/${unpublished.id}/unpublish`, {});
    const archived = (await publish(NEWS, { title: 'Archivado' })).content;
    await call(`/api/contents/${archived.id}/archive`, {});
    const deleted = (await publish(NEWS, { title: 'Eliminado' })).content;
    await call(`/api/contents/${deleted.id}/unpublish`, {});
    await call(`/api/contents/${deleted.id}`, { method: 'DELETE', expected: 204 });

    const notFound = await page('/noticias/no-existe');
    for (const c of [draft, review.content, unpublished, archived, deleted]) {
      const r = await page(`/noticias/${c.slug}`);
      assert.equal(r.status, 404, c.slug);
      assert.equal(r.html, notFound.html, 'misma respuesta que lo inexistente');
    }
    const list = await page('/noticias');
    for (const t of ['Borrador', 'En revisión', 'Despublicado', 'Archivado', 'Eliminado']) assert.doesNotMatch(list.html, new RegExp(`>${t}<`));
  });

  it('una sección inactiva o con un ancestro inactivo no existe, ni sus contenidos', async () => {
    const agenda = await section({ name: 'Agenda', type: 'news', parentId: NEWS });
    await publish(agenda.id, { title: 'Concierto' });
    await call(`/api/sections/${agenda.id}/deactivate`, {});
    assert.equal((await page('/noticias/agenda')).status, 404);
    assert.equal((await page('/noticias/agenda/concierto')).status, 404);
    assert.doesNotMatch((await page('/noticias')).html, /Agenda/);

    await call(`/api/sections/${agenda.id}/activate`, {});
    assert.equal((await page('/noticias/agenda/concierto')).status, 200);
    await call(`/api/sections/${NEWS}/deactivate`, {});
    assert.equal((await page('/noticias/agenda/concierto')).status, 404, 'ancestro inactivo');
    assert.equal((await page('/noticias')).status, 404);
  });
});

describe('sitio público: redirecciones (D-055)', () => {
  it('cambiar el slug de un contenido redirige la URL antigua (301)', async () => {
    const { content } = await publish(NEWS, { title: 'Antiguo' });
    await call(`/api/contents/${content.id}`, { method: 'PATCH', body: { slug: 'nuevo' } });
    const res = await app.request('/noticias/antiguo?pagina=1');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/noticias/nuevo?pagina=1');
    assert.equal((await page('/noticias/nuevo')).status, 200);
  });

  it('cambiar el slug o el padre de una sección redirige la sección y sus contenidos', async () => {
    const s = await section({ name: 'Agenda', type: 'news', parentId: NEWS });
    await publish(s.id, { title: 'Concierto' });
    await call(`/api/sections/${s.id}`, { method: 'PATCH', body: { slug: 'eventos' } });
    let res = await app.request('/noticias/agenda/concierto');
    assert.deepEqual([res.status, res.headers.get('location')], [301, '/noticias/eventos/concierto']);
    await call(`/api/sections/${s.id}`, { method: 'PATCH', body: { parentId: 3 } });
    for (const old of ['/noticias/agenda/concierto', '/noticias/eventos/concierto']) {
      res = await app.request(old);
      assert.deepEqual([res.status, res.headers.get('location')], [301, '/articulos/eventos/concierto'], old);
    }
    res = await app.request('/noticias/eventos');
    assert.deepEqual([res.status, res.headers.get('location')], [301, '/articulos/eventos']);
  });

  it('no redirige a algo no visible, y la ruta real tiene prioridad sobre la redirección', async () => {
    const { content } = await publish(NEWS, { title: 'Uno' });
    await call(`/api/contents/${content.id}`, { method: 'PATCH', body: { slug: 'dos' } });
    await call(`/api/contents/${content.id}/unpublish`, {});
    assert.equal((await page('/noticias/uno')).status, 404);

    const other = await publish(NEWS, { title: 'Uno' }); // vuelve a ocupar /noticias/uno
    assert.equal(other.content.slug, 'uno');
    assert.equal((await page('/noticias/uno')).status, 200);
  });

  it('una barra final redirige a la ruta sin ella', async () => {
    const res = await app.request('/noticias/');
    assert.deepEqual([res.status, res.headers.get('location')], [301, '/noticias']);
  });
});

describe('sitio público: archivos, sitemap y caché', () => {
  it('/media/<id> sirve solo archivos de contenidos publicados y visibles', async () => {
    const used = await uploadOk(NEWS);
    const unused = await uploadOk(NEWS);
    const inDraft = await uploadOk(NEWS);
    const { content } = await publish(NEWS, { title: 'Con foto', body: doc(img(used.id)) });
    await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Borrador', body: doc(img(inDraft.id)) }, expected: 201 });

    const res = await app.request(`/media/${used.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    const etag = res.headers.get('etag');
    assert.equal(etag, `"${used.sha256}"`);
    const revalidated = await app.request(`/media/${used.id}`, { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.match(revalidated.headers.get('content-security-policy'), /sandbox/);

    for (const m of [unused, inDraft, { id: 999999 }]) assert.equal((await app.request(`/media/${m.id}`)).status, 404, String(m.id));
    await call(`/api/contents/${content.id}/unpublish`, {});
    assert.equal((await app.request(`/media/${used.id}`)).status, 404, 'tras despublicar');
  });

  it('los PDF públicos se descargan', async () => {
    const pdf = await uploadOk(4, makePdf(), { type: 'application/pdf', name: 'memoria.pdf' });
    await publish(4, { title: 'Memoria', body: doc(docLink(pdf.id)) });
    const res = await app.request(`/media/${pdf.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="memoria.pdf"/);
  });

  it('sitemap.xml lista solo lo visible; robots.txt y favicon', async () => {
    const { content } = await publish(NEWS, { title: 'Visible' });
    await call(`/api/sections/${NEWS}/contents`, { body: { title: 'Oculto' }, expected: 201 });
    await call('/api/sections/5/deactivate', {});
    const res = await app.request('/sitemap.xml');
    assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8');
    const xml = await res.text();
    assert.match(xml, new RegExp(`<loc>http://127\\.0\\.0\\.1:3000/noticias/${content.slug}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    assert.match(xml, /<loc>http:\/\/127\.0\.0\.1:3000\/noticias<\/loc>/);
    assert.doesNotMatch(xml, /oculto|preguntas-frecuentes/);
    const robots = await (await app.request('/robots.txt')).text();
    assert.equal(robots, 'User-agent: *\nDisallow: /admin/\nDisallow: /api/\nSitemap: http://127.0.0.1:3000/sitemap.xml\n');
    assert.equal((await app.request('/favicon.ico')).status, 204);
  });

  it('ETag con no-cache: 304 si no cambió y contenido nuevo tras publicar', async () => {
    const first = await page('/noticias');
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag');
    const revalidated = await page('/noticias', { 'if-none-match': etag });
    assert.equal(revalidated.status, 304);
    // El navegador actualiza la respuesta guardada con las cabeceras del 304: debe llevar la CSP pública.
    assert.equal(revalidated.headers.get('content-security-policy'), first.headers.get('content-security-policy'));
    assert.match(revalidated.headers.get('content-security-policy'), /style-src 'self'; img-src 'self'/);
    await publish(NEWS, { title: 'Novedad' });
    const after = await page('/noticias', { 'if-none-match': etag });
    assert.equal(after.status, 200);
    assert.match(after.html, /Novedad/);
  });

  it('HEAD responde sin cuerpo; el sitio público no admite otros métodos', async () => {
    const head = await app.request('/noticias', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await app.request('/noticias', { method: 'POST', body: {} });
    assert.equal(post.status, 405);
  });
});
