/**
 * Procesos reales (Bloque 11): la herramienta de copias (scripts/backup.js) y el
 * arranque del servidor (backend/server.js) con su bloqueo y su cierre.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';
import { removeDir, tempDir } from '../helpers/db.js';

let dir;
let env;

before(() => {
  dir = tempDir();
  env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', LOG_LEVEL: 'info',
    DATABASE_PATH: path.join(dir, 'cms.db'), STORAGE_DIR: path.join(dir, 'storage'), BACKUP_INTERVAL_HOURS: '0',
  };
  const db = openDatabase(env.DATABASE_PATH);
  migrate(db);
  closeDatabase(db);
});
after(() => removeDir(dir));

const backupCli = (...args) => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'backup.js'), ...args], { env, encoding: 'utf8', timeout: 60_000 });

describe('scripts/backup.js', () => {
  let id;

  it('create crea y verifica una copia; list la muestra', () => {
    const r = backupCli('create');
    assert.equal(r.status, 0, r.stderr);
    id = /verificada: (\d{14})/.exec(r.stdout)[1];
    const list = backupCli('list');
    assert.equal(list.status, 0);
    assert.ok(list.stdout.includes(id) && list.stdout.includes('manual'));
  });

  it('verify informa del resultado con el código de salida', () => {
    assert.equal(backupCli('verify', id).status, 0);
    fs.appendFileSync(path.join(env.STORAGE_DIR, 'backups', id, 'manifest.json'), ' ');
    const db = path.join(env.STORAGE_DIR, 'backups', id, 'database.sqlite');
    fs.appendFileSync(db, Buffer.alloc(512));
    const bad = backupCli('verify', id);
    assert.equal(bad.status, 1);
    assert.ok(bad.stdout.includes('NO supera'));
    assert.ok(bad.stdout.includes('file_corrupt'));
  });

  it('restore exige --confirm, no restaura una copia dañada y valida el id', () => {
    const noConfirm = backupCli('restore', id);
    assert.equal(noConfirm.status, 1);
    assert.ok(noConfirm.stderr.includes('--confirm'));
    const damaged = backupCli('restore', id, '--confirm');
    assert.equal(damaged.status, 1);
    assert.ok(damaged.stderr.includes('backup_invalid'));
    assert.ok(damaged.stderr.includes('file_corrupt'));
    assert.equal(backupCli('restore', '../../etc', '--confirm').status, 1);
  });

  it('verify-dir verifica una copia copiada a otro lugar, sin base ni configuración', () => {
    const created = backupCli('create');
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const good = /verificada: (\d{14})/.exec(created.stdout)[1];
    const elsewhere = path.join(dir, 'fuera', good);
    fs.cpSync(path.join(env.STORAGE_DIR, 'backups', good), elsewhere, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'backup.js'), 'verify-dir', elsewhere],
      { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('correcta'));
    fs.writeFileSync(path.join(elsewhere, 'extra.txt'), 'x');
    assert.equal(backupCli('verify-dir', elsewhere).status, 1);
  });

  it('restore de una copia correcta y prune', () => {
    const good = /verificada: (\d{14})/.exec(backupCli('create').stdout)[1];
    const r = backupCli('restore', good, '--confirm');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`Copia ${good} restaurada`));
    assert.equal(backupCli('prune').status, 0);
  });

  it('sin orden válida o con configuración inválida, falla con un mensaje', () => {
    assert.equal(backupCli().status, 1);
    assert.equal(backupCli('borrar-todo').status, 1);
    const bad = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'backup.js'), 'list'], { env: { ...env, BACKUP_KEEP: '0' }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes('BACKUP_KEEP'));
  });
});

describe('scripts/check-env.js en producción', () => {
  const run = (extra) => spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'check-env.js')], {
    env: { ...env, NODE_ENV: 'production', APP_BASE_URL: 'https://cms.example.org', ...extra }, encoding: 'utf8',
  });

  it('señala lo que no es seguro desplegar', () => {
    const r = run({ HOST: '0.0.0.0', TRUST_PROXY: 'false', LOG_LEVEL: 'debug' });
    assert.equal(r.status, 1);
    for (const t of ['HOST=0.0.0.0', 'TRUST_PROXY=false', 'LOG_LEVEL=debug', 'Producción: administrador general']) assert.ok(r.stdout.includes(t), t);
  });

  it('una configuración correcta y con administrador pasa', () => {
    const db = openDatabase(env.DATABASE_PATH, { create: false });
    db.prepare("INSERT OR IGNORE INTO users (username, email, display_name, password_hash, role) VALUES ('admin', 'admin@example.org', 'Admin', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo', 'general_admin')").run();
    closeDatabase(db);
    const r = run({ HOST: '127.0.0.1', TRUST_PROXY: 'true' });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.stdout.includes('Entorno correcto'));
  });
});

describe('backend/server.js', () => {
  function startServer(port) {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'server.js')], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = '';
    child.stdout.on('data', (d) => (child.output += d));
    child.stderr.on('data', (d) => (child.output += d));
    child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return child;
  }
  async function waitFor(fn, ms = 15_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  it('arranca con el bloqueo, impide un segundo servidor o una restauración, y lo libera al cerrarse', async (t) => {
    const port = 3940 + Math.floor(Math.random() * 50);
    const first = startServer(port);
    t.after(() => first.kill());
    assert.ok(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok), first.output);
    const lock = path.join(env.STORAGE_DIR, 'cms.lock');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, first.pid);

    const second = startServer(port + 1);
    assert.equal(await second.exited, 1);
    assert.ok(second.output.includes('No se pudo tomar el bloqueo del servidor'));

    const id = /verificada: (\d{14})/.exec(backupCli('create').stdout)[1];
    const restore = backupCli('restore', id, '--confirm');
    assert.equal(restore.status, 1);
    assert.ok(restore.stderr.includes('server_running'));

    first.kill('SIGTERM');
    await first.exited;
    // En POSIX, SIGTERM pasa por el cierre ordenado y libera el bloqueo. En Windows
    // el proceso termina sin más: el bloqueo queda abandonado y se reemplaza.
    if (process.platform !== 'win32') assert.equal(fs.existsSync(lock), false);
    assert.equal(backupCli('restore', id, '--confirm').status, 0);
  });

  it('no arranca con migraciones pendientes', async () => {
    const empty = path.join(dir, 'vacia.db');
    const db = openDatabase(empty);
    closeDatabase(db);
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'server.js')], {
      env: { ...env, DATABASE_PATH: empty, STORAGE_DIR: path.join(dir, 'otro'), PORT: '3999' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stderr.on('data', (d) => (out += d));
    child.stdout.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.ok(out.includes('No se pudo preparar la base de datos'));
    // El bloqueo se libera también al fallar el arranque.
    assert.equal(fs.existsSync(path.join(dir, 'otro', 'cms.lock')), false);
  });
});
