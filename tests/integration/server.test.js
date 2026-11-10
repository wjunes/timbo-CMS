import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../../backend/app.js';
import { loadConfig } from '../../backend/config/index.js';
import { createLogger } from '../../backend/utils/logger.js';
import { closeDatabase, migratedMemoryDb } from '../helpers/db.js';

const silentLogger = createLogger({ level: 'error', write: () => {} });

function start(env) {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '3000', ...env });
  const db = migratedMemoryDb();
  const server = createServer({ config, logger: silentLogger, db });
  server.on('close', () => closeDatabase(db));
  return new Promise((resolve) => {
    // Puerto 0: el sistema asigna un puerto libre efímero.
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

describe('servidor HTTP mínimo', () => {
  let server;
  let base;

  before(async () => ({ server, base } = await start({})));
  after(() => stop(server));

  it('GET /health responde 200 con JSON', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('HEAD /health responde 200 sin cuerpo', async () => {
    const res = await fetch(`${base}/health`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });

  it('/health ignora query string', async () => {
    const res = await fetch(`${base}/health?x=1`);
    assert.equal(res.status, 200);
  });

  it('métodos no permitidos en /health devuelven 405 con Allow', async () => {
    const res = await fetch(`${base}/health`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });

  it('rutas desconocidas devuelven 404 genérico', async () => {
    const res = await fetch(`${base}/no-existe`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  it('no revela tecnología ni versión del servidor', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('server'), null);
  });

  it('aplica cabeceras de seguridad en todas las respuestas', async () => {
    for (const path of ['/health', '/no-existe']) {
      const res = await fetch(`${base}${path}`);
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
      assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      // HSTS solo en producción.
      assert.equal(res.headers.get('strict-transport-security'), null);
    }
  });
});

describe('servidor HTTP en producción', () => {
  it('añade HSTS', async () => {
    const { server, base } = await start({ NODE_ENV: 'production', APP_BASE_URL: 'https://cms.example.org' });
    try {
      const res = await fetch(`${base}/health`);
      assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
    } finally {
      await stop(server);
    }
  });
});
