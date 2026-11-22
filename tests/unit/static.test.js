import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HttpError } from '../../backend/middleware/http.js';
import { createStaticSite } from '../../backend/middleware/static.js';

let root;
let site;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-static-'));
  const write = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('index.html', '<!doctype html>');
  write('js/app.js');
  write('.env', 'SECRETO=1');
  write('.git/config');
  write('js/.oculto.js');
  write('notas.txt');
  write('datos.json');
  write('plantilla.svg', '<svg onload="alert(1)"/>');
  site = createStaticSite({ root, prefix: '/admin' });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const get = (p) => site.serve({ method: 'GET' }, p);
const notFound = (p) => assert.rejects(get(p), (e) => e instanceof HttpError && e.status === 404, p);

describe('archivos estáticos del panel', () => {
  it('sirve index.html en /admin y /admin/, y los archivos de la lista con su tipo', async () => {
    for (const p of ['/admin', '/admin/', '/admin/index.html']) {
      const r = await get(p);
      assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
      r.stream.destroy();
    }
    const js = await get('/admin/js/app.js');
    assert.equal(js.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.match(js.headers['Content-Security-Policy'], /default-src 'none'/);
    js.stream.destroy();
  });

  it('no sirve ocultos, extensiones desconocidas ni rutas fuera de la lista', async () => {
    for (const p of ['/admin/.env', '/admin/.git/config', '/admin/js/.oculto.js', '/admin/notas.txt', '/admin/datos.json',
      '/admin/plantilla.svg', '/admin/../package.json', '/admin/js/../index.html', '/admin/JS/APP.JS']) {
      await notFound(p);
    }
  });

  it('solo GET y HEAD', async () => {
    await assert.rejects(site.serve({ method: 'POST' }, '/admin/'), (e) => e.status === 405);
    assert.equal(site.owns('/admin'), true);
    assert.equal(site.owns('/administracion'), false);
  });
});
