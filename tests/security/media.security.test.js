/**
 * Seguridad de la multimedia y del panel (Bloque 08): permisos por sección en
 * el backend, aislamiento entre secciones, validación real de los archivos,
 * límites, nombres maliciosos, nada ejecutable y el panel sin path traversal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { startApp } from '../helpers/http.js';
import { makePdf, makePng, upload } from '../helpers/media.js';

const NEWS = 2; // asignada al editor
const ARTICLES = 3; // no asignada

let app;
let api; // general_admin

beforeEach(async () => {
  app = await startApp({ env: { MEDIA_MAX_BYTES: '4096' } });
  ({ api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

async function editorWith(permissions, section = NEWS) {
  const username = `ed${Math.random().toString(36).slice(2, 8)}`;
  const user = await app.createUser({ username });
  assert.equal((await api.json(`/api/users/${user.id}/sections/${section}`, { method: 'PUT' })).status, 201);
  assert.equal((await api.json(`/api/users/${user.id}/sections/${section}/permissions`, { method: 'PUT', body: { permissions } })).status, 200);
  return { user, client: app.as(await app.login(username)) };
}

async function adminUpload(section = NEWS, buffer = makePng(), opts) {
  const r = await upload(api, section, buffer, opts);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.media;
}

const lastDenied = () => {
  const row = app.db.prepare("SELECT actor_user_id, section_id, details FROM audit_logs WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1").get();
  return { ...row, details: JSON.parse(row.details) };
};
const mediaFiles = () => {
  const dir = path.join(app.config.storageDir, 'media');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('seguridad multimedia: permisos y aislamiento', () => {
  it('subir exige media.upload en la sección (403 auditado); sin asignación, 404', async () => {
    const { user, client } = await editorWith(['content.create']);
    let r = await upload(client, NEWS, makePng());
    assert.equal(r.status, 403);
    assert.deepEqual([lastDenied().actor_user_id, lastDenied().section_id, lastDenied().details.permission], [user.id, NEWS, 'media.upload']);
    r = await upload(client, ARTICLES, makePng());
    assert.equal(r.status, 404);
    assert.equal(mediaFiles().length, 0);
  });

  it('con media.upload sube y edita el texto alternativo, pero no elimina sin media.delete', async () => {
    const { client } = await editorWith(['media.upload']);
    const r = await upload(client, NEWS, makePng());
    assert.equal(r.status, 201);
    const id = r.body.media.id;
    assert.equal((await client.json(`/api/media/${id}`, { method: 'PATCH', body: { altText: 'ok' } })).status, 200);
    assert.equal((await client.json(`/api/media/${id}`, { method: 'DELETE' })).status, 403);
    assert.equal(lastDenied().details.permission, 'media.delete');
    const { client: deleter } = await editorWith(['media.delete']);
    assert.equal((await deleter.json(`/api/media/${id}`, { method: 'PATCH', body: { altText: 'x' } })).status, 403);
    assert.equal((await deleter.json(`/api/media/${id}`, { method: 'DELETE' })).status, 204);
  });

  it('los archivos de una sección no asignada no existen para el editor (404 en todo)', async () => {
    const foreign = await adminUpload(ARTICLES);
    const { client } = await editorWith(['media.upload', 'media.delete']);
    for (const [method, p, body] of [
      ['GET', `/api/media/${foreign.id}`], ['GET', `/api/media/${foreign.id}/file`],
      ['PATCH', `/api/media/${foreign.id}`, { altText: 'x' }], ['DELETE', `/api/media/${foreign.id}`],
      ['GET', `/api/sections/${ARTICLES}/media`],
    ]) {
      assert.equal((await client.json(p, { method, body })).status, 404, `${method} ${p}`);
    }
    assert.equal(app.db.prepare('SELECT status FROM media WHERE id = ?').get(foreign.id).status, 'active');
  });

  it('un editor no puede usar en su sección una imagen de otra sección', async () => {
    const foreign = await adminUpload(ARTICLES);
    const { client } = await editorWith(['content.create']);
    const r = await client.json(`/api/sections/${NEWS}/contents`, {
      method: 'POST', body: { title: 'x', body: { type: 'doc', content: [{ type: 'image', attrs: { mediaId: foreign.id } }] } },
    });
    assert.deepEqual([r.status, r.body.fields], [400, { body: 'media_not_available' }]);
  });

  it('un usuario suspendido o sin sesión no accede a los archivos', async () => {
    const m = await adminUpload();
    const { user, client } = await editorWith([]);
    assert.equal((await client(`/api/media/${m.id}/file`)).status, 200);
    await api.json(`/api/users/${user.id}/suspend`, { method: 'POST' });
    assert.equal((await client(`/api/media/${m.id}/file`)).status, 401);
    assert.equal((await app.request(`/api/media/${m.id}/file`)).status, 401);
  });

  it('la subida exige el token CSRF y el origen del sitio', async () => {
    const session = await app.login('admin');
    const noCsrf = await app.request(`/api/sections/${NEWS}/media`, {
      method: 'POST', cookie: session.cookie, body: makePng(), headers: { 'content-type': 'image/png', 'x-file-name': 'a.png' },
    });
    assert.equal(noCsrf.status, 403);
    const badOrigin = await app.request(`/api/sections/${NEWS}/media`, {
      method: 'POST', cookie: session.cookie, origin: 'https://evil.example', body: makePng(),
      headers: { 'content-type': 'image/png', 'x-file-name': 'a.png', 'x-csrf-token': session.csrfToken },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(mediaFiles().length, 0);
  });
});

describe('seguridad multimedia: archivos maliciosos', () => {
  it('rechaza archivos falsificados (código renombrado, HTML con firma de imagen, SVG)', async () => {
    const sig = makePng().subarray(0, 8);
    for (const [buffer, type, name, expected] of [
      [Buffer.from('<?php system($_GET["c"]); ?>'), 'image/png', 'shell.png', 422],
      [Buffer.concat([sig, Buffer.from('<html><script>alert(1)</script>')]), 'image/png', 'x.png', 422],
      [Buffer.from('<script>alert(1)</script>'), 'application/pdf', 'x.pdf', 422],
      [makePdf({ extra: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }), 'application/pdf', 'x.pdf', 422],
      [Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml', 'x.svg', 415],
      [makePng(), 'text/html', 'x.html', 415],
      [makePng(), 'application/octet-stream', 'x.png', 415],
    ]) {
      const r = await upload(api, NEWS, buffer, { type, name });
      assert.equal(r.status, expected, name);
    }
    assert.equal(mediaFiles().length, 0);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM media').get().n, 0);
  });

  it('el nombre original es solo un dato: rutas y caracteres de control se rechazan', async () => {
    for (const name of ['../../../backend/app.js.png', '..\\..\\x.png', 'a/b.png', 'x\u0000.png']) {
      const r = await upload(api, NEWS, makePng(), { name });
      assert.deepEqual([r.status, r.body.fields], [400, { fileName: 'invalid_characters' }], name);
    }
    const r = await upload(api, NEWS, makePng(), { headers: { 'x-file-name': '%ZZ.png' } });
    assert.deepEqual(r.body.fields, { fileName: 'invalid_format' });
    const ok = await adminUpload(NEWS, makePng(), { name: '<img src=x onerror=alert(1)>.png' });
    assert.equal(ok.originalName, '<img src=x onerror=alert(1)>.png'); // se devuelve como JSON; el panel lo muestra como texto
    assert.match(mediaFiles()[0], /^[0-9a-f]{32}$/);
  });

  it('aplica MEDIA_MAX_BYTES por Content-Length y por bytes recibidos', async () => {
    const big = makePng({ text: 'x'.repeat(5000) });
    const r = await upload(api, NEWS, big);
    assert.equal(r.status, 413);

    // Transferencia por trozos (sin Content-Length): se corta al superar el límite.
    const session = await app.login('admin');
    const res = await new Promise((resolve, reject) => {
      const { port } = new URL(app.base);
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write([
          `POST /api/sections/${NEWS}/media HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: ${app.origin}`,
          `Cookie: ${session.cookie}`, `X-CSRF-Token: ${session.csrfToken}`, 'Content-Type: image/png', 'X-File-Name: a.png',
          'Transfer-Encoding: chunked', '', '',
        ].join('\r\n'));
        const chunk = Buffer.alloc(2048, 0x41);
        for (let i = 0; i < 4; i++) socket.write(`${chunk.length.toString(16)}\r\n${chunk.toString('latin1')}\r\n`);
      });
      let data = '';
      socket.on('data', (d) => {
        data += d;
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
    });
    assert.match(res, /^HTTP\/1\.1 413/);
    assert.equal(mediaFiles().length, 0);
  });

  it('la configuración rechaza límites fuera de rango', async () => {
    const { loadConfig } = await import('../../backend/config/index.js');
    assert.throws(() => loadConfig({ MEDIA_MAX_BYTES: '100' }), /MEDIA_MAX_BYTES/);
    assert.throws(() => loadConfig({ MEDIA_MAX_BYTES: String(60 * 1024 * 1024) }), /MEDIA_MAX_BYTES/);
    assert.equal(loadConfig({}).media.maxBytes, 10 * 1024 * 1024);
  });

  it('la API no expone la clave de almacenamiento ni el disco, y la auditoría no guarda contenido', async () => {
    const m = await adminUpload(NEWS, makePng({ text: 'SECRETO-EN-METADATOS' }));
    const key = app.db.prepare('SELECT storage_key FROM media WHERE id = ?').get(m.id).storage_key;
    const listing = JSON.stringify(await api.json(`/api/sections/${NEWS}/media`));
    const detail = JSON.stringify(await api.json(`/api/media/${m.id}`));
    for (const text of [listing, detail]) {
      assert.equal(text.includes(key), false);
      assert.equal(text.includes(app.config.storageDir.replaceAll('\\', '\\\\')), false);
    }
    const details = app.db.prepare('SELECT details FROM audit_logs').all().map((r) => r.details).join('');
    assert.equal(details.includes('SECRETO'), false);
    assert.equal(details.includes(key), false);
  });
});

describe('seguridad del panel', () => {
  it('sirve el panel con una CSP sin nada en línea y sin marcos', async () => {
    const res = await app.request('/admin/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const html = await res.text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'sin scripts en línea');
    assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i, 'sin estilos ni manejadores en línea');
  });

  it('ningún archivo del panel usa localStorage, sessionStorage, eval ni estilos en línea', () => {
    const dir = path.join(PROJECT_ROOT, 'frontend', 'admin');
    const sources = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(js|html)$/.test(f) && !f.includes('editor.bundle'));
    assert.ok(sources.length >= 8);
    for (const file of sources) {
      // Sin comentarios: algunos explican precisamente que esas APIs no se usan.
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|\beval\(|new Function\(|\.style\s*=|insertAdjacentHTML|outerHTML/, file);
      const innerHtml = (text.match(/innerHTML/g) ?? []).length;
      assert.equal(innerHtml, file.endsWith('preview.js') ? 1 : 0, `${file}: innerHTML solo en la vista previa`);
    }
  });

  it('solo sirve los archivos de la lista; nada fuera de frontend/admin (path traversal)', async () => {
    for (const p of [
      '/admin/../backend/app.js', '/admin/..%2f..%2fbackend%2fapp.js', '/admin/%2e%2e/%2e%2e/package.json',
      '/admin/js/../../../.env', '/admin/assets/editor.bundle.licenses.txt', '/admin/js/', '/admin/index.html%00.js',
      '/admin//etc/passwd', '/admin/js/main.js/', '/admin/.hidden', '/admin\\..\\backend\\app.js',
    ]) {
      const res = await app.request(p);
      assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`);
      assert.doesNotMatch(await res.text(), /createServer|DATABASE_PATH|root:/, p);
    }
    const js = await app.request('/admin/js/main.js');
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
  });

  it('el panel solo admite GET y HEAD', async () => {
    const res = await app.request('/admin/', { method: 'POST', body: {} });
    assert.equal(res.status, 405);
    const head = await app.request('/admin/js/api.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  it('el almacenamiento no se sirve por ninguna ruta', async () => {
    const m = await adminUpload();
    const key = app.db.prepare('SELECT storage_key FROM media WHERE id = ?').get(m.id).storage_key;
    for (const p of [`/storage/media/${key}`, `/media/${key}`, `/media/${m.id}`, `/admin/../storage/media/${key}`]) {
      assert.equal((await app.request(p)).status, 404, p);
    }
  });
});
