/**
 * Medida sencilla de rendimiento (Bloque 11), sin dependencias.
 *
 *   npm run bench                 (por defecto: 10 s por ruta, 20 conexiones)
 *   BENCH_SECONDS=5 BENCH_CONCURRENCY=50 npm run bench
 *
 * Arranca el servidor real con una base temporal (200 contenidos publicados,
 * una imagen) y mide peticiones por segundo y latencias (p50, p95, p99) de
 * rutas representativas. No toca la base de desarrollo. El límite general de
 * peticiones se sube durante la medida, porque todas salen de la misma IP.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../backend/config/index.js';
import { closeDatabase, openDatabase } from '../backend/database/connection.js';
import { migrate } from '../backend/database/migrator.js';
import { createPasswordHasher } from '../backend/modules/auth/password.js';
import { makePng } from '../tests/helpers/media.js';

const SECONDS = Number(process.env.BENCH_SECONDS ?? 10);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);
const CONTENTS = 200;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-bench-'));
const PORT = 3990;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'clave-de-la-medida-de-rendimiento';
const env = {
  ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATABASE_PATH: path.join(dir, 'cms.db'), STORAGE_DIR: path.join(dir, 'storage'),
  LOG_LEVEL: 'error', BACKUP_INTERVAL_HOURS: '0', RATE_LIMIT_REQUESTS_PER_MINUTE: '100000', RATE_LIMIT_WRITES_PER_MINUTE: '10000',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const setup = openDatabase(env.DATABASE_PATH);
migrate(setup);
setup.prepare("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('admin', 'admin@example.org', 'Admin', ?, 'general_admin')")
  .run(await createPasswordHasher().hash(PASS));
closeDatabase(setup);

const server = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'server.js')], { env, stdio: 'inherit' });
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* arrancando */ } await sleep(100); }

  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: 'admin', password: PASS }) });
  const { csrfToken } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (p, body, extra = {}) => (await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, origin: BASE, 'content-type': 'application/json', ...extra }, body,
  })).json();
  const { media } = await post('/api/sections/2/media', makePng({ width: 64, height: 40 }), { 'content-type': 'image/png', 'x-file-name': 'foto.png' });
  process.stdout.write(`Preparando ${CONTENTS} contenidos publicados…\n`);
  let slug;
  for (let i = 1; i <= CONTENTS; i++) {
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Texto de la noticia ${i}. `.repeat(20) }] },
      { type: 'image', attrs: { mediaId: media.id, alt: 'Foto' } }] };
    const { content, version } = await post('/api/sections/2/contents', JSON.stringify({ title: `Noticia ${i}`, summary: 'Resumen', body }));
    const v = `/api/contents/${content.id}/versions/${version.id}`;
    await post(`${v}/submit`, JSON.stringify({ revision: 1 }));
    await post(`${v}/approve`, '{}');
    await post(`${v}/publish`, '{}');
    slug = content.slug;
  }

  const ROUTES = [
    ['Portada', '/', {}],
    ['Lista de noticias (página 5)', '/noticias?pagina=5', {}],
    ['Página de un contenido', `/noticias/${slug}`, {}],
    ['Archivo público (imagen)', `/media/${media.id}`, {}],
    ['Hoja de estilos', '/assets/site.css', {}],
    ['API: contenidos de una sección (sesión)', '/api/sections/2/contents', { cookie }],
    ['API: consulta de auditoría (sesión)', '/api/audit?limit=50', { cookie }],
  ];

  const rows = [];
  for (const [name, p, headers] of ROUTES) {
    const latencies = [];
    let errors = 0;
    const end = Date.now() + SECONDS * 1000;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < end) {
        const t0 = performance.now();
        try {
          const res = await fetch(`${BASE}${p}`, { headers });
          await res.arrayBuffer();
          if (res.status !== 200) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - t0);
      }
    }));
    latencies.sort((a, b) => a - b);
    const q = (x) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * x))].toFixed(1);
    rows.push({ ruta: name, 'pet/s': Math.round(latencies.length / SECONDS), 'p50 ms': q(0.5), 'p95 ms': q(0.95), 'p99 ms': q(0.99), errores: errors });
  }
  process.stdout.write(`\nNode ${process.version} · ${os.cpus()[0]?.model ?? 'CPU'} · ${CONCURRENCY} conexiones · ${SECONDS} s por ruta\n`);
  console.table(rows);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
