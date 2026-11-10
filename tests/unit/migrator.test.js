import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../../backend/database/connection.js';
import { MigrationError, assertSchemaCurrent, getMigrationStatus, loadMigrations, migrate } from '../../backend/database/migrator.js';
import { removeDir, tempDir } from '../helpers/db.js';

let dir;
let db;

function write(name, sql) {
  fs.writeFileSync(path.join(dir, name), sql);
}

const tableNames = () =>
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

beforeEach(() => {
  dir = tempDir();
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  removeDir(dir);
});

describe('loadMigrations', () => {
  it('carga y ordena por versión, con checksum', () => {
    write('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    fs.writeFileSync(path.join(dir, 'LEEME.md'), 'ignorado');
    const ms = loadMigrations(dir);
    assert.deepEqual(ms.map((m) => m.file), ['001_a.sql', '002_b.sql']);
    assert.match(ms[0].checksum, /^[0-9a-f]{64}$/);
  });

  it('el checksum no depende de los finales de línea', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\n');
    const lf = loadMigrations(dir)[0].checksum;
    write('001_a.sql', 'CREATE TABLE a (id INTEGER);\r\nCREATE TABLE b (id INTEGER);\r\n');
    assert.equal(loadMigrations(dir)[0].checksum, lf);
  });

  it('rechaza nombres inválidos, huecos, duplicados y archivos vacíos', () => {
    write('1_a.sql', 'SELECT 1;');
    assert.throws(() => loadMigrations(dir), /Nombre de migración inválido/);
    fs.rmSync(path.join(dir, '1_a.sql'));

    write('001_a.sql', 'SELECT 1;');
    write('003_c.sql', 'SELECT 1;');
    assert.throws(() => loadMigrations(dir), /no contigua/);

    write('001_duplicada.sql', 'SELECT 1;');
    assert.throws(() => loadMigrations(dir), /no contigua o duplicada/);
    fs.rmSync(path.join(dir, '001_duplicada.sql'));
    fs.rmSync(path.join(dir, '003_c.sql'));

    write('002_vacia.sql', '   \n');
    assert.throws(() => loadMigrations(dir), /vacía/);
  });

  it('rechaza migraciones con control de transacciones propio', () => {
    for (const sql of ['BEGIN;\nSELECT 1;', 'SELECT 1;\nCOMMIT;', 'BEGIN IMMEDIATE TRANSACTION;', 'SELECT 1;\nROLLBACK;']) {
      write('001_a.sql', sql);
      assert.throws(() => loadMigrations(dir), /control de transacciones/, sql);
    }
  });

  it('permite triggers con BEGIN ... END', () => {
    write('001_a.sql', 'CREATE TABLE t (x INTEGER);\nCREATE TRIGGER tr BEFORE DELETE ON t\nBEGIN\n  SELECT RAISE(ABORT, \'no\');\nEND;');
    assert.equal(loadMigrations(dir).length, 1);
  });

  it('las migraciones reales del proyecto son válidas', () => {
    const ms = loadMigrations();
    assert.ok(ms.length >= 1);
    assert.equal(ms[0].file, '001_initial_schema.sql');
  });
});

describe('migrate', () => {
  it('aplica las pendientes en orden y es idempotente', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id));');
    const migrations = loadMigrations(dir);
    assert.deepEqual(migrate(db, { migrations }).applied.map((m) => m.version), [1, 2]);
    assert.deepEqual(migrate(db, { migrations }).applied, []);
    assert.deepEqual(tableNames(), ['a', 'b', 'schema_migrations']);
    assert.equal(getMigrationStatus(db, migrations).pending.length, 0);
  });

  it('aplica solo las nuevas en una base existente', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, { migrations: loadMigrations(dir) });
    write('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }).applied.map((m) => m.version), [2]);
  });

  it('revierte por completo una migración que falla y no aplica las siguientes', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('002_falla.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);\nINSERT INTO tabla_inexistente VALUES (1);');
    write('003_c.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
    assert.throws(() => migrate(db, { migrations: loadMigrations(dir) }), (err) => {
      assert.ok(err instanceof MigrationError);
      assert.match(err.message, /002_falla\.sql/);
      return true;
    });
    assert.deepEqual(tableNames(), ['a', 'schema_migrations']);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version), [1]);
    assert.equal(db.isTransaction, false);
  });

  it('revierte una migración que deja violaciones de claves foráneas', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);\nCREATE TABLE b (a_id INTEGER REFERENCES a (id));');
    // Con FK diferidas la inserción no falla de inmediato; la detecta foreign_key_check.
    write('002_b.sql', 'PRAGMA defer_foreign_keys = ON;\nINSERT INTO b VALUES (42);');
    assert.throws(() => migrate(db, { migrations: loadMigrations(dir) }), /002_b\.sql/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM b').get().n, 0);
  });

  it('detecta una migración aplicada que fue modificada', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, { migrations: loadMigrations(dir) });
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');
    const migrations = loadMigrations(dir);
    assert.throws(() => migrate(db, { migrations }), /modificada después de aplicarse/);
    assert.throws(() => assertSchemaCurrent(db, migrations), /modificada después de aplicarse/);
  });

  it('detecta migraciones aplicadas que ya no existen en el código', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    migrate(db, { migrations: loadMigrations(dir) });
    fs.rmSync(path.join(dir, '002_b.sql'));
    assert.match(getMigrationStatus(db, loadMigrations(dir)).issues.join(), /no existe en el código/);
  });
});

describe('assertSchemaCurrent', () => {
  it('falla si hay pendientes (también en una base vacía) y pasa al migrar', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const migrations = loadMigrations(dir);
    assert.throws(() => assertSchemaCurrent(db, migrations), /1 migración\(es\) pendiente\(s\).*db:migrate/);
    migrate(db, { migrations });
    assertSchemaCurrent(db, migrations);
  });

  it('no modifica la base de datos', () => {
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    assert.throws(() => assertSchemaCurrent(db, loadMigrations(dir)));
    assert.deepEqual(tableNames(), []);
  });
});
