/**
 * Bloque 12: paleta del sitio elegida por la administración general, modo
 * claro/oscuro del visitante sin JavaScript y modo del panel por usuario.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PROJECT_ROOT, loadConfig } from '../../backend/config/index.js';
import { startApp } from '../helpers/http.js';

const EXAMPLE_THEMES = path.join(PROJECT_ROOT, 'deploy', 'themes.example.json');

let app;
beforeEach(async () => {
  app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0' } });
});
afterEach(() => app.stop());

const page = async (path, cookie) => {
  const res = await app.request(path, { cookie });
  return { res, text: await res.text() };
};

describe('paleta del sitio', () => {
  it('/assets/palette.css sirve la predeterminada con su CSP, ETag y revalidación', async () => {
    const res = await app.request('/assets/palette.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const css = await res.text();
    assert.match(css, /Paleta «azul»/);
    assert.match(css, /--accent:#1d5fb4;/);
    const again = await app.request('/assets/palette.css', { headers: { 'if-none-match': res.headers.get('etag') } });
    assert.equal(again.status, 304);
    assert.equal((await app.request('/assets/palette.css', { method: 'HEAD' })).status, 200);
    assert.equal((await app.request('/assets/palette.css', { method: 'POST', body: {} })).status, 405);
    // El resto de /assets sigue siendo estático.
    assert.equal((await app.request('/assets/site.css')).status, 200);
    assert.equal((await app.request('/assets/no-existe.css')).status, 404);
  });

  it('todas las páginas enlazan la hoja de la paleta después de site.css', async () => {
    for (const path of ['/', '/no-existe']) {
      const { text } = await page(path);
      assert.match(text, /<link rel="stylesheet" href="\/assets\/site\.css">\n<link rel="stylesheet" href="\/assets\/palette\.css">/, path);
    }
  });

  it('la administración general la cambia; se audita, el sitio la aplica y el ETag cambia', async () => {
    const { api } = await app.loginAsAdmin();
    let r = await api.json('/api/settings');
    assert.equal(r.body.settings.sitePalette, 'azul');
    assert.deepEqual(r.body.palettes.map((p) => [p.id, p.custom]), [['azul', false], ['verde', false], ['granate', false], ['grafito', false]]);
    assert.match(r.body.palettes[1].light.accent, /^#[0-9a-f]{6}$/);
    const before = (await app.request('/assets/palette.css')).headers.get('etag');

    r = await api.json('/api/settings', { method: 'PATCH', body: { sitePalette: 'granate' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.sitePalette, 'granate');
    const res = await app.request('/assets/palette.css', { headers: { 'if-none-match': before } });
    assert.equal(res.status, 200, 'la versión guardada en el navegador ya no vale');
    assert.match(await res.text(), /Paleta «granate»/);

    const audit = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(audit.details), { before: { sitePalette: 'azul' }, after: { sitePalette: 'granate' } });
  });

  it('solo admite paletas del catálogo: ni ids desconocidos ni CSS', async () => {
    const { api } = await app.loginAsAdmin();
    for (const sitePalette of ['no-existe', 'AZUL', '<style>', 'body{}', '', 3, null, ['azul']]) {
      const r = await api.json('/api/settings', { method: 'PATCH', body: { sitePalette } });
      assert.equal(r.status, 400, JSON.stringify(sitePalette));
      assert.equal(r.body.error, 'validation_failed');
    }
    for (const body of [{ palette: 'verde' }, { siteCss: 'body{}' }, { sitePalette: 'verde', colors: { bg: '#000000' } }]) {
      assert.equal((await api.json('/api/settings', { method: 'PATCH', body })).status, 400, JSON.stringify(body));
    }
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'site.palette'").get().n, 0);
  });

  it('un administrador de sección no puede consultarla ni cambiarla', async () => {
    await app.loginAsAdmin();
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    assert.equal((await other.json('/api/settings')).status, 403);
    assert.equal((await other.json('/api/settings', { method: 'PATCH', body: { sitePalette: 'verde' } })).status, 403);
  });

  it('una paleta guardada que ya no existe (se retiró THEMES_FILE) se sustituye por la predeterminada', async () => {
    app.db.prepare("INSERT INTO settings (key, value) VALUES ('site.palette', '\"retirada\"')").run();
    assert.match(await (await app.request('/assets/palette.css')).text(), /Paleta «azul»/);
    const { api } = await app.loginAsAdmin();
    assert.equal((await api.json('/api/settings')).body.settings.sitePalette, 'azul');
  });
});

describe('paletas exclusivas de la instalación (THEMES_FILE)', () => {
  it('se ofrecen junto a las de serie, marcadas como exclusivas, y el sitio las aplica', async () => {
    const custom = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0', THEMES_FILE: EXAMPLE_THEMES } });
    try {
      const { api } = await custom.loginAsAdmin();
      const { body } = await api.json('/api/settings');
      assert.deepEqual(body.palettes.at(-1).id, 'ejemplo-turquesa');
      assert.equal(body.palettes.at(-1).custom, true);
      assert.equal((await api.json('/api/settings', { method: 'PATCH', body: { sitePalette: 'ejemplo-turquesa' } })).status, 200);
      assert.match(await (await custom.request('/assets/palette.css')).text(), /Paleta «ejemplo-turquesa»[\s\S]*--accent:#0b6b74;/);
    } finally {
      await custom.stop();
    }
  });

  it('sin THEMES_FILE una paleta exclusiva no se puede elegir', async () => {
    const { api } = await app.loginAsAdmin();
    assert.equal((await api.json('/api/settings', { method: 'PATCH', body: { sitePalette: 'ejemplo-turquesa' } })).status, 400);
  });

  it('la configuración resuelve la ruta y no admite el directorio público', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).themesFile, null);
    assert.equal(loadConfig({ NODE_ENV: 'test', THEMES_FILE: 'deploy/themes.example.json' }).themesFile, EXAMPLE_THEMES);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', THEMES_FILE: 'frontend/public/assets/themes.json' }), /THEMES_FILE no puede estar dentro del directorio público/);
  });
});

describe('modo claro/oscuro del visitante', () => {
  const setMode = (m, volver) => app.request(`/_modo?m=${encodeURIComponent(m)}${volver === undefined ? '' : `&volver=${encodeURIComponent(volver)}`}`);

  it('sin preferencia sigue el sistema: sin data-mode y con «Automático» marcado', async () => {
    const { res, text } = await page('/');
    assert.match(text, /^<!doctype html>\n<html lang="es">/);
    assert.match(text, /<nav class="mode-switch" aria-label="Modo de color">/);
    assert.match(text, /<a href="\/_modo\?m=auto&amp;volver=%2F" rel="nofollow" aria-current="true">Automático<\/a>/);
    assert.match(text, /<a href="\/_modo\?m=oscuro&amp;volver=%2F" rel="nofollow">Oscuro<\/a>/);
    assert.equal(res.headers.get('vary'), 'Cookie');
  });

  it('elegir «oscuro» guarda una cookie de preferencia y vuelve a la página; la página la aplica', async () => {
    const res = await setMode('oscuro', '/noticias?pagina=2');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/noticias?pagina=2');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const cookie = res.headers.get('set-cookie');
    assert.equal(cookie, `site_mode=dark; Path=/; SameSite=Lax; Max-Age=${365 * 24 * 3600}; HttpOnly`);

    const { text } = await page('/', 'site_mode=dark');
    assert.match(text, /^<!doctype html>\n<html lang="es" data-mode="dark">/);
    assert.match(text, /rel="nofollow" aria-current="true">Oscuro<\/a>/);
    assert.doesNotMatch(text, /aria-current="true">Automático/);
  });

  it('«claro» fija el modo claro y «auto» borra la cookie', async () => {
    assert.match((await setMode('claro', '/')).headers.get('set-cookie'), /^site_mode=light;/);
    assert.match((await page('/', 'site_mode=light')).text, /<html lang="es" data-mode="light">/);
    assert.match((await setMode('auto', '/')).headers.get('set-cookie'), /^site_mode=; Path=\/; SameSite=Lax; Max-Age=0; HttpOnly$/);
  });

  it('el ETag distingue el modo: una página guardada en otro modo no se reutiliza', async () => {
    const auto = await app.request('/');
    const etag = auto.headers.get('etag');
    assert.equal((await app.request('/', { headers: { 'if-none-match': etag } })).status, 304);
    const dark = await app.request('/', { cookie: 'site_mode=dark', headers: { 'if-none-match': etag } });
    assert.equal(dark.status, 200);
    const notModified = await app.request('/', { cookie: 'site_mode=dark', headers: { 'if-none-match': dark.headers.get('etag') } });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.get('vary'), 'Cookie');
  });

  it('una cookie con otro valor se ignora', async () => {
    for (const cookie of ['site_mode=purple', 'site_mode=%22dark%22', 'site_mode=']) {
      assert.match((await page('/', cookie)).text, /^<!doctype html>\n<html lang="es">/, cookie);
    }
  });

  it('la vuelta solo admite rutas del propio sitio: cualquier otra cosa vuelve a la portada', async () => {
    const attempts = [
      'https://evil.example/', '//evil.example', '/\\evil.example', '/%2F%2Fevil.example', '\\\\evil.example',
      'javascript:alert(1)', '/admin/', '/admin', '/api/settings', '/assets/site', '/media/1', '/noticias/', '/a//b', '/a?x=1', '/a?pagina=0', '/a#frag',
      '/A', '/a/b/c/d/e', ' /noticias', '/noticias\r\nSet-Cookie: x=1', '',
    ];
    for (const volver of attempts) {
      const res = await setMode('oscuro', volver);
      assert.equal(res.status, 303, volver);
      assert.equal(res.headers.get('location'), '/', JSON.stringify(volver));
    }
    assert.equal((await setMode('oscuro')).headers.get('location'), '/');
    for (const ok of ['/', '/noticias', '/servicios/tramites/licencias', '/noticias?pagina=3']) {
      assert.equal((await setMode('oscuro', ok)).headers.get('location'), ok);
    }
  });

  it('un modo desconocido no fija cookie; solo admite GET y robots.txt la excluye', async () => {
    for (const m of ['dark', 'OSCURO', 'x', '']) {
      const res = await setMode(m, '/');
      assert.equal(res.status, 303, m);
      assert.equal(res.headers.get('set-cookie'), null, m);
    }
    assert.equal((await app.request('/_modo?m=oscuro')).status, 303);
    assert.equal((await app.request('/_modo', { method: 'POST', body: {} })).status, 405);
    assert.match(await (await app.request('/robots.txt')).text(), /^Disallow: \/_modo$/m);
  });

  it('la cookie lleva Secure si el sitio se sirve por https', async () => {
    const https = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0', APP_BASE_URL: 'https://cms.example.org' } });
    try {
      const res = await https.request('/_modo?m=oscuro&volver=/', { origin: null });
      assert.match(res.headers.get('set-cookie'), /; HttpOnly; Secure$/);
    } finally {
      await https.stop();
    }
  });

  it('el selector vuelve a la página actual, también en las páginas de error', async () => {
    assert.match((await page('/no-existe')).text, /href="\/_modo\?m=claro&amp;volver=%2F"/);
  });
});

describe('modo del panel', () => {
  it('cada usuario guarda el suyo; la sesión lo devuelve y no afecta a otros', async () => {
    const { api } = await app.loginAsAdmin();
    assert.equal((await api.json('/api/auth/session')).body.user.uiMode, 'auto');
    const r = await api.json('/api/auth/preferences', { method: 'PUT', body: { uiMode: 'dark' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.uiMode, 'dark');
    assert.equal((await api.json('/api/auth/session')).body.user.uiMode, 'dark');

    await app.createUser({ username: 'seccion' });
    const login = await app.login('seccion');
    assert.equal(login.body.user.uiMode, 'auto');
    const other = app.as(login);
    assert.equal((await other.json('/api/auth/preferences', { method: 'PUT', body: { uiMode: 'light' } })).status, 200);
    assert.equal((await api.json('/api/auth/session')).body.user.uiMode, 'dark');
    // Persiste para el próximo inicio de sesión.
    assert.equal((await app.login('admin')).body.user.uiMode, 'dark');
  });

  it('valida el valor y exige sesión, CSRF y contraseña definitiva', async () => {
    const { api, session } = await app.loginAsAdmin();
    for (const body of [{ uiMode: 'purple' }, { uiMode: 'DARK' }, {}, { uiMode: 'dark', role: 'general_admin' }]) {
      assert.equal((await api.json('/api/auth/preferences', { method: 'PUT', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await app.request('/api/auth/preferences', { method: 'PUT', body: { uiMode: 'dark' } })).status, 401);
    assert.equal((await app.request('/api/auth/preferences', { method: 'PUT', cookie: session.cookie, body: { uiMode: 'dark' } })).status, 403);

    const temp = await app.createUser({ username: 'temporal' });
    app.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(temp.id);
    const tempApi = app.as(await app.login('temporal'));
    const r = await tempApi.json('/api/auth/preferences', { method: 'PUT', body: { uiMode: 'dark' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'password_change_required');
  });

  it('la base solo admite los tres modos', async () => {
    await app.createUser({ username: 'seccion' });
    assert.throws(() => app.db.prepare("UPDATE users SET ui_mode = 'purple'").run(), /CHECK constraint failed/);
  });
});
