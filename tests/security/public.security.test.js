/**
 * Seguridad del sitio público (Bloque 09): escapado de todo dato, CSP sin
 * scripts, nada no publicado accesible, sin path traversal ni redirecciones
 * abiertas, y las rutas del sistema intactas.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';
import { makePng, upload } from '../helpers/media.js';

let app;
let api;

beforeEach(async () => {
  app = await startApp();
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

async function call(path, { method = 'POST', body, expected = 200 } = {}) {
  const r = await api.json(path, { method, body });
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function publishDirect(sectionId, body) {
  const { content, version } = await call(`/api/sections/${sectionId}/contents`, { body, expected: 201 });
  await call(`/api/contents/${content.id}/versions/${version.id}/publish`, { body: { revision: 1 } });
  return content;
}

const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

describe('seguridad del sitio público', () => {
  it('escapa títulos, resúmenes, cuerpos, nombres de sección, descripciones y ajustes', async () => {
    const s = (await call('/api/sections', { body: { name: `Sección ${XSS}`, slug: 'avisos', description: XSS, type: 'news', workflow: 'direct' }, expected: 201 })).section;
    const c = await publishDirect(s.id, {
      title: `Título ${XSS}`, summary: XSS, slug: 'aviso',
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: XSS }] }] },
    });
    app.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(`Sitio ${XSS}`), 'site.name');
    for (const path of ['/', '/avisos', `/avisos/${c.slug}`, '/sitemap.xml']) {
      const html = await (await app.request(path)).text();
      // Como texto escapado sí aparece; nunca como etiqueta o atributo.
      // Si algo no se escapara, aparecería la etiqueta o el cierre ">" real tras el atributo.
      assert.doesNotMatch(html, /<script|<img src=x|onerror=alert\(2\)>/i, path);
      if (path !== '/sitemap.xml') assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&gt;&lt;img/, path);
    }
  });

  it('CSP sin scripts y HTML sin nada en línea en todas las páginas', async () => {
    const m = (await upload(api, 2, makePng())).body.media;
    await call('/api/sections/2', { method: 'PATCH', body: { workflow: 'direct' } });
    const c = await publishDirect(2, { title: 'Con imagen', body: { type: 'doc', content: [{ type: 'image', attrs: { mediaId: m.id, alt: 'x' } }] } });
    for (const path of ['/', '/noticias', `/noticias/${c.slug}`, '/no-existe', '/institucional']) {
      const res = await app.request(path);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'none'/, path);
      assert.doesNotMatch(csp, /script-src|unsafe-inline|unsafe-eval/, path);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      const html = await res.text();
      assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=|javascript:/i, path);
    }
    const css = await app.request('/assets/site.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  });

  it('rutas mal formadas y path traversal dan 404 sin revelar nada', async () => {
    for (const path of [
      '/../package.json', '/%2e%2e/%2e%2e/backend/app.js', '/noticias/..%2f..%2f.env', '/NOTICIAS', '/noticias%2Fx',
      '/noticias/a/b/c/d', '/noticias//x', '/.env', '/storage/media/x', '/database/cms.db', '/assets/../backend/app.js',
      '/noticias/x.html', '/noticias/_x', '/noticias/-x', '/frontend/admin/index.html',
    ]) {
      const res = await app.request(path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /createServer|DATABASE_PATH|SQLITE|Error:|at /, path);
    }
  });

  it('sin redirecciones abiertas a otros dominios', async () => {
    for (const path of ['//evil.example/', '/.//evil.example/', '/noticias/..//evil.example/', '/%2F%2Fevil.example/', '/\\evil.example/']) {
      const res = await app.request(path);
      const location = res.headers.get('location');
      assert.ok(location === null || /^\/[a-z0-9]/.test(location), `${path} → ${location}`);
    }
  });

  it('las rutas del sistema no las atiende el sitio público', async () => {
    assert.deepEqual(await (await app.request('/api/desconocida')).json(), { error: 'not_found' });
    assert.equal((await app.request('/admin/')).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match((await app.request('/admin/')).headers.get('content-security-policy'), /script-src 'self'/);
    assert.deepEqual(await (await app.request('/health')).json(), { status: 'ok' });
    assert.equal((await app.request('/media/abc')).status, 404);
  });

  it('los archivos no publicados no se sirven aunque se conozca su id, y el panel sigue exigiendo sesión', async () => {
    const m = (await upload(api, 2, makePng())).body.media;
    assert.equal((await app.request(`/media/${m.id}`)).status, 404);
    assert.equal((await app.request(`/api/media/${m.id}/file`)).status, 401);
  });

  it('un archivo publicado en una sección inactiva deja de servirse', async () => {
    const s = (await call('/api/sections', { body: { name: 'Avisos', type: 'news', workflow: 'direct' }, expected: 201 })).section;
    const m = (await upload(api, s.id, makePng())).body.media;
    await publishDirect(s.id, { title: 'x', body: { type: 'doc', content: [{ type: 'image', attrs: { mediaId: m.id } }] } });
    assert.equal((await app.request(`/media/${m.id}`)).status, 200);
    await call(`/api/sections/${s.id}/deactivate`, {});
    assert.equal((await app.request(`/media/${m.id}`)).status, 404);
  });

  it('el sitio público no usa cookies ni las fija', async () => {
    const res = await app.request('/noticias');
    assert.equal(res.headers.get('set-cookie'), null);
  });
});
