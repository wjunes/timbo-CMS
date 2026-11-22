/**
 * Prueba en un navegador real (Bloque 11): servidor real + Chrome sin interfaz,
 * manejado por el protocolo DevTools (WebSocket nativo de Node, sin dependencias).
 *
 *   npm run test:browser
 *
 * Recorre el sitio público (móvil y escritorio) y el panel como lo haría una
 * persona, y termina con una restauración por línea de órdenes. No forma parte de
 * `npm test` porque necesita Chrome. Busca Chrome en CHROME_PATH o en las rutas
 * habituales; si no lo encuentra, lo indica y termina con código 2.
 * Con BROWSER_SCREENSHOTS=<directorio> guarda capturas.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';
import { createPasswordHasher } from '../../backend/modules/auth/password.js';
import { makePdf, makePng } from '../helpers/media.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('No se encontró Chrome. Indique su ruta en CHROME_PATH.');
  process.exit(2);
}

const shots = process.env.BROWSER_SCREENSHOTS ? path.resolve(process.env.BROWSER_SCREENSHOTS) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-browser-'));
const PORT = 3960 + Math.floor(Math.random() * 30);
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'clave-de-prueba-del-navegador';
const env = {
  ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATABASE_PATH: path.join(dir, 'cms.db'),
  STORAGE_DIR: path.join(dir, 'storage'), LOG_LEVEL: 'warn', BACKUP_INTERVAL_HOURS: '0',
};

const db = openDatabase(env.DATABASE_PATH);
migrate(db);
db.prepare("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('admin', 'admin@example.org', 'Admin', ?, 'general_admin')")
  .run(await createPasswordHasher().hash(PASS));
closeDatabase(db);

let serverOut = '';
const startServer = () => {
  const s = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => (serverOut += d));
  s.stderr.on('data', (d) => (serverOut += d));
  return s;
};
const stopServer = async (s) => {
  if (s.exitCode !== null) return;
  s.kill('SIGTERM');
  await new Promise((r) => s.on('exit', r));
};
const cli = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'backup.js'), ...args], { env, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitHealth = async () => { for (let i = 0; i < 150; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* arrancando */ } await sleep(100); } };

const results = [];
const check = (name, cond, extra = '') => results.push([cond ? 'OK   ' : 'FALLO', name, extra]);

let server = startServer();
let chrome;
let profile;
try {
  await waitHealth();

  // --- Datos de partida por la API, como lo haría el panel ----------------------
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  const { csrfToken } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (p, { method = 'POST', body, raw, type, name } = {}) => {
    const h = { cookie, 'x-csrf-token': csrfToken, origin: BASE };
    let payload;
    if (raw) { h['content-type'] = type; h['x-file-name'] = encodeURIComponent(name); payload = raw; } else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${BASE}${p}`, { method, headers: h, body: payload });
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  };
  const publish = async (sectionId, body) => {
    const { content, version } = await api(`/api/sections/${sectionId}/contents`, { body });
    const v = `/api/contents/${content.id}/versions/${version.id}`;
    await api(`${v}/submit`, { body: { revision: 1 } });
    await api(`${v}/approve`, { body: {} });
    await api(`${v}/publish`, { body: {} });
    return content;
  };
  const doc = (...c) => ({ type: 'doc', content: c });
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const photo = (await api('/api/sections/2/media', { raw: makePng({ width: 64, height: 40 }), type: 'image/png', name: 'portada.png' })).media;
  const pdf = (await api('/api/sections/4/media', { raw: makePdf(), type: 'application/pdf', name: 'Memoria 2026.pdf' })).media;
  const news = await publish(2, { title: 'Noticia con un título bastante largo para comprobar el ajuste en pantallas de móvil', summary: 'Resumen.',
    body: doc(p('Cuerpo de la noticia.'), { type: 'image', attrs: { mediaId: photo.id, alt: 'Portada' } },
      { type: 'table', content: [{ type: 'tableRow', content: ['Columna A', 'Columna B', 'Columna C', 'Columna D', 'Columna E'].map((t) => ({ type: 'tableHeader', content: [p(t)] })) }] }) });
  await publish(1, { title: 'Quiénes somos', body: doc(p('Texto institucional.')) });
  await publish(4, { title: 'Memoria anual', body: doc({ type: 'paragraph', content: [{ type: 'text', text: 'Descargar', marks: [{ type: 'link', attrs: { href: `/media/${pdf.id}` } }] }] }) });
  await publish(5, { title: '¿Cómo me inscribo?', body: doc(p('Desde la sede electrónica.')) });

  // --- Chrome -----------------------------------------------------------------
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-chrome-'));
  chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 75 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* arrancando */ } if (!target) await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++seq; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? {}); pending.delete(msg.id); return; }
    if (msg.method === 'Page.javascriptDialogOpening') { send('Page.handleJavaScriptDialog', { accept: true }); return; } // confirmaciones del panel
    if (msg.method) events.push(msg);
  });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })).result?.value;
  const screenshot = async (name) => {
    if (!shots) return;
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.__t = {
      byText: (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === text),
      label: (text) => [...document.querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === text)?.querySelector('input,select,textarea'),
      fill: (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); },
      wait: async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; },
    };` });
  const visit = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 50; i++) { if (await evaluate("return document.readyState === 'complete'")) break; await sleep(100); }
    await sleep(150);
  };
  const go = async (hash) => { await evaluate(`location.hash = ${JSON.stringify(hash)}`); await sleep(400); };
  const overflowing = () => evaluate(`return document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('body *')].some((el) => {
    const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1 && !el.closest('.table-wrap, table.grid, pre');
  })`);
  const mobile = () => send('Emulation.setDeviceMetricsOverride', { width: 375, height: 740, deviceScaleFactor: 1, mobile: true });
  const desktop = () => send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // --- Sitio público ------------------------------------------------------------
  const pages = ['/', '/noticias', `/noticias/${news.slug}`, '/institucional', '/biblioteca', '/preguntas-frecuentes', '/no-existe'];
  for (const [label, set] of [['móvil', mobile], ['escritorio', desktop]]) {
    await set();
    const bad = [];
    for (const pg of pages) {
      await visit(`${BASE}${pg}`);
      if (await overflowing()) bad.push(pg);
    }
    check(`sitio público (${label}): sin desbordamiento horizontal`, bad.length === 0, bad.join(', '));
    await visit(`${BASE}/noticias/${news.slug}`);
    await screenshot(`sitio-contenido-${label}`);
  }
  check('sitio: la imagen pública se carga', await evaluate('return [...document.images].every((i) => i.complete && i.naturalWidth > 0)'));
  check('sitio: estilos cargados', await evaluate("return getComputedStyle(document.querySelector('.site-header')).backgroundColor !== 'rgba(0, 0, 0, 0)'"));
  await visit(`${BASE}/preguntas-frecuentes`);
  await evaluate("document.querySelector('summary').click()");
  check('sitio: acordeón sin JavaScript', await evaluate("return document.querySelector('details').open"));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  check('sitio: el primer Tab llega a «Saltar al contenido»', await evaluate("return document.activeElement.classList.contains('skip')"));
  // Segunda visita: el navegador revalida (304) y debe conservar la CSP pública.
  await visit(`${BASE}/noticias/${news.slug}`);
  check('sitio: la revalidación (304) mantiene estilos e imágenes', await evaluate('return [...document.images].every((i) => i.naturalWidth > 0) && document.styleSheets.length > 0'));

  // --- Panel ----------------------------------------------------------------------
  await visit(`${BASE}/admin/`);
  await evaluate(`__t.fill(document.querySelector('[name=username]'), 'admin'); __t.fill(document.querySelector('[name=password]'), ${JSON.stringify(PASS)}); document.querySelector('form').requestSubmit();`);
  check('panel: acceso', await evaluate("return !!(await __t.wait(() => __t.byText('nav a', 'Sistema')))"));

  await go('#/users');
  await evaluate(`__t.fill(__t.label('Usuario'), 'editora'); __t.fill(__t.label('Nombre visible'), 'Editora de Noticias');
    __t.fill(__t.label('Correo electrónico'), 'editora@example.org'); __t.fill(__t.label('Contraseña temporal'), 'temporal-muy-segura-1');
    document.querySelector('form').requestSubmit();`);
  check('panel: alta de administrador de sección', await evaluate("return !!(await __t.wait(() => /^#\\/users\\/\\d+$/.test(location.hash) && document.querySelector('h1')?.textContent.includes('Editora')))"));
  const userHash = await evaluate('return location.hash');
  await evaluate("const s = document.querySelector('select[aria-label=\"Sección para asignar\"]'); __t.fill(s, [...s.options].find((o) => o.textContent.includes('Noticias')).value); __t.byText('button', 'Asignar sección').click();");
  check('panel: asignación de sección', await evaluate("return !!(await __t.wait(() => document.querySelector('.perm-set legend')?.textContent.includes('Noticias')))"));
  await evaluate("document.querySelector('.perm-set input[value=\"content.create\"]').click(); __t.byText('button', 'Guardar permisos').click();");
  check('panel: permisos guardados', await evaluate("return !!(await __t.wait(() => document.querySelector('main').innerText.includes('Permisos de «Noticias» guardados')))"));
  await evaluate("__t.byText('button', 'Suspender').click()");
  check('panel: suspensión (con confirmación)', await evaluate("return !!(await __t.wait(() => document.querySelector('h1 .badge')?.textContent === 'Suspendido'))"));
  await evaluate("(await __t.wait(() => __t.byText('button', 'Reactivar'))).click()");
  check('panel: reactivación', await evaluate("return !!(await __t.wait(() => document.querySelector('h1 .badge')?.textContent === 'Activo'))"));

  await go('#/sections');
  await evaluate(`document.querySelector('details.card').open = true; __t.fill(__t.label('Nombre'), 'Convocatorias');
    const tipo = __t.label('Tipo'); __t.fill(tipo, [...tipo.options].find((o) => o.textContent.toLowerCase().includes('noticia')).value);
    __t.fill(__t.label('Publicación'), 'direct'); __t.byText('button', 'Crear sección').click();`);
  check('panel: alta de sección', await evaluate("return !!(await __t.wait(() => /settings$/.test(location.hash) && document.querySelector('h1')?.textContent.includes('Convocatorias')))"));
  await evaluate("__t.fill(__t.label('Nombre'), 'Convocatorias abiertas'); __t.byText('button', 'Guardar cambios').click();");
  check('panel: edición de sección', await evaluate("return !!(await __t.wait(() => document.querySelector('h1')?.textContent.includes('Convocatorias abiertas')))"));

  await go('#/system/settings');
  await evaluate("__t.fill(__t.label('Nombre del sitio'), 'Portal de prueba en navegador'); document.querySelector('form').requestSubmit();");
  await evaluate("await __t.wait(() => document.querySelector('main').innerText.includes('Configuración guardada'))");
  check('panel: el sitio público muestra el nuevo nombre', (await (await fetch(`${BASE}/`)).text()).includes('Portal de prueba en navegador'));

  await go('#/system/backups');
  await evaluate("__t.byText('button', 'Crear copia ahora').click()");
  check('panel: copia creada', await evaluate("return !!(await __t.wait(() => document.querySelector('table.grid tbody tr td.mono')))"));
  await evaluate("__t.byText('button', 'Verificar').click()");
  check('panel: copia verificada', await evaluate("return !!(await __t.wait(() => document.querySelector('main').innerText.includes('Correcta.')))"));
  const backupId = await evaluate("return document.querySelector('table.grid tbody tr td.mono').textContent");

  await go('#/system/audit');
  check('panel: auditoría listada', await evaluate("return !!(await __t.wait(() => document.querySelectorAll('table.audit tbody tr').length > 5))"));
  await evaluate("__t.byText('button', 'Verificar la integridad').click()");
  check('panel: auditoría íntegra', await evaluate("return !!(await __t.wait(() => document.querySelector('main').innerText.includes('Cadena íntegra')))"));
  await go('#/system/purge');
  check('panel: pantalla de purga', await evaluate("return document.querySelector('main').innerText.includes('Archivos eliminados sin uso (0)')"));

  await mobile();
  const bad = [];
  for (const hsh of ['#/sections', '#/sections/2', '#/sections/2/media', '#/sections/2/settings', '#/reviews', '#/users', userHash,
    '#/system/settings', '#/system/audit', '#/system/backups', '#/system/purge', '#/password']) {
    await go(hsh);
    await sleep(250);
    if (await overflowing()) bad.push(hsh);
  }
  check('panel (móvil): sin desbordamiento horizontal', bad.length === 0, bad.join(', '));
  await go(userHash);
  await screenshot('panel-usuario-móvil');
  await desktop();
  await go('#/system/backups');
  await screenshot('panel-copias-escritorio');

  check('ninguna violación de CSP', (await evaluate('return window.__csp')).length === 0);
  const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'
    // Esperados: la página 404 buscada y la comprobación de sesión al abrir el panel sin sesión.
    && !e.params.entry.url?.endsWith('/no-existe') && !(e.params.entry.url?.endsWith('/api/auth/session') && e.params.entry.text.includes('401'))))
    .map((e) => JSON.stringify(e.params).slice(0, 300));
  check('sin errores en la consola', errors.length === 0, errors.join('\n'));

  // --- Restauración por línea de órdenes --------------------------------------------
  const blocked = cli('restore', backupId, '--confirm');
  check('la restauración se niega con el servidor en marcha', blocked.code === 1 && blocked.out.includes('server_running'));
  await stopServer(server);
  const restored = cli('restore', backupId, '--confirm');
  check('restauración con el servidor detenido', restored.code === 0, restored.out.trim().split('\n').pop());
  server = startServer();
  await waitHealth();
  check('tras restaurar, la sesión del navegador queda cerrada', (await evaluate("return (await fetch('/api/auth/session')).status")) === 401);
  ws.close();
} catch (err) {
  check('ejecución', false, err.stack);
} finally {
  chrome?.kill();
  await stopServer(server);
  for (const r of results) console.log(r.join(' | '));
  const failed = results.filter((r) => r[0] !== 'OK   ').length;
  console.log(failed ? `\nPrueba en navegador: ${failed} FALLOS de ${results.length}` : `\nPrueba en navegador: ${results.length}/${results.length} correctas`);
  if (failed && serverOut) console.log(`\nSalida del servidor:\n${serverOut}`);
  await sleep(1500);
  for (const d of [dir, profile]) { try { if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Chrome puede tardar en soltar archivos */ } }
  process.exitCode = failed ? 1 : 0;
}
