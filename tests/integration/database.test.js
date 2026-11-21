/**
 * Integración con archivos reales: conexión, modo WAL, CLI de migraciones y
 * arranque del servidor condicionado al estado del esquema.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';
import { removeDir, tempDir } from '../helpers/db.js';

let dir;
before(() => (dir = tempDir()));
after(() => removeDir(dir));

/** Entorno aislado: no hereda variables .env del desarrollador. */
function childEnv(extra) {
  return { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', LOG_LEVEL: 'error', ...extra };
}

function runDbCli(args, env) {
  return spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'db.js'), ...args], {
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe('conexión a archivo', () => {
  it('activa WAL, claves foráneas, trusted_schema=OFF y synchronous=NORMAL', () => {
    const db = openDatabase(path.join(dir, 'conn.db'));
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
      assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    } finally {
      closeDatabase(db);
    }
  });

  it('crea el directorio padre si no existe', () => {
    const file = path.join(dir, 'sub', 'dir', 'nuevo.db');
    closeDatabase(openDatabase(file));
    assert.ok(fs.existsSync(file));
  });

  it('con create=false no crea una base inexistente', () => {
    const file = path.join(dir, 'no-existe.db');
    assert.throws(() => openDatabase(file, { create: false }), /no existe.*db:migrate/);
    assert.equal(fs.existsSync(file), false);
  });

  it('exige rutas absolutas', () => {
    assert.throws(() => openDatabase('relativa.db'), /absoluta/);
  });

  it('el modo defensivo impide escribir el esquema directamente', () => {
    const db = openDatabase(path.join(dir, 'defensive.db'));
    try {
      db.exec('PRAGMA writable_schema = ON');
      assert.throws(() => db.exec("UPDATE sqlite_schema SET sql = 'x'"), /may not be modified/);
    } finally {
      closeDatabase(db);
    }
  });

  it('dos conexiones: el lector ve el último commit mientras otro escribe (WAL)', () => {
    const file = path.join(dir, 'concurrency.db');
    const writer = openDatabase(file);
    const reader = openDatabase(file);
    try {
      migrate(writer);
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("INSERT INTO settings (key, value) VALUES ('k', '1')").run();
      // El lector no queda bloqueado y no ve la escritura sin confirmar.
      assert.equal(reader.prepare('SELECT count(*) AS n FROM settings').get().n, 0);
      // Un segundo escritor no puede empezar mientras el primero mantiene el bloqueo.
      reader.exec('PRAGMA busy_timeout = 0');
      assert.throws(() => reader.exec('BEGIN IMMEDIATE'), /locked|busy/i);
      writer.exec('COMMIT');
      assert.equal(reader.prepare('SELECT count(*) AS n FROM settings').get().n, 1);
    } finally {
      closeDatabase(reader);
      closeDatabase(writer);
    }
  });
});

describe('CLI de base de datos (scripts/db.js)', () => {
  it('status sobre una base inexistente no la crea', () => {
    const file = path.join(dir, 'cli-status.db');
    const r = runDbCli(['status'], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no existe/);
    assert.equal(fs.existsSync(file), false);
  });

  it('migrate aplica el esquema y status lo refleja; repetir es seguro', () => {
    const file = path.join(dir, 'cli.db');
    let r = runDbCli(['migrate'], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr);
    r = runDbCli(['migrate'], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr);
    r = runDbCli(['status'], { DATABASE_PATH: file });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[aplicada\]\s+001_initial_schema/);
    assert.doesNotMatch(r.stdout, /pendiente/);
  });

  it('rechaza órdenes desconocidas y configuración inválida', () => {
    assert.equal(runDbCli(['drop'], {}).status, 1);
    assert.equal(runDbCli(['migrate'], { DATABASE_PATH: 'frontend/x.db' }).status, 1);
  });
});

describe('arranque del servidor', () => {
  async function startServer(env) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'server.js')], {
      env: childEnv({ LOG_LEVEL: 'info', PORT: String(port), ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, port, exited, output: () => output };
  }

  async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  it('no arranca si la base de datos no existe', async () => {
    const file = path.join(dir, 'server-missing.db');
    const { exited, output } = await startServer({ DATABASE_PATH: file });
    assert.equal(await exited, 1);
    assert.match(output(), /no existe/);
    assert.equal(fs.existsSync(file), false);
  });

  it('no arranca si hay migraciones pendientes', async () => {
    const file = path.join(dir, 'server-pending.db');
    closeDatabase(openDatabase(file)); // base vacía, sin migrar
    const { exited, output } = await startServer({ DATABASE_PATH: file });
    assert.equal(await exited, 1);
    assert.match(output(), /pendiente/);
  });

  it('arranca y responde con el esquema al día', async () => {
    const file = path.join(dir, 'server-ok.db');
    const db = openDatabase(file);
    migrate(db);
    closeDatabase(db);

    const { child, port, exited, output } = await startServer({ DATABASE_PATH: file });
    try {
      const ready = await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
        } catch {
          return false;
        }
      });
      assert.ok(ready, `el servidor no respondió: ${output()}`);
    } finally {
      child.kill();
      await exited;
    }
  });
});
