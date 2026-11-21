import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../../backend/database/connection.js';
import { withTransaction } from '../../backend/database/transaction.js';

let db;
const count = () => db.prepare('SELECT count(*) AS n FROM t').get().n;
const insert = (v) => db.prepare('INSERT INTO t (v) VALUES (?)').run(v);

beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (v TEXT NOT NULL UNIQUE) STRICT');
});
afterEach(() => db.close());

describe('withTransaction', () => {
  it('confirma y devuelve el resultado', () => {
    assert.equal(withTransaction(db, () => (insert('a'), 'ok')), 'ok');
    assert.equal(count(), 1);
    assert.equal(db.isTransaction, false);
  });

  it('revierte todo ante una excepción y la relanza', () => {
    assert.throws(
      () =>
        withTransaction(db, () => {
          insert('a');
          insert('a'); // UNIQUE
        }),
      /UNIQUE/,
    );
    assert.equal(count(), 0);
    assert.equal(db.isTransaction, false);
  });

  it('anidada: un fallo interno capturado solo revierte el SAVEPOINT', () => {
    withTransaction(db, () => {
      insert('externo');
      assert.throws(() =>
        withTransaction(db, () => {
          insert('interno');
          throw new Error('fallo interno');
        }),
      );
      assert.equal(db.isTransaction, true);
    });
    assert.deepEqual(db.prepare('SELECT v FROM t').all().map((r) => r.v), ['externo']);
  });

  it('anidada: un fallo externo revierte también lo interno', () => {
    assert.throws(() =>
      withTransaction(db, () => {
        withTransaction(db, () => insert('interno'));
        throw new Error('fallo externo');
      }),
    );
    assert.equal(count(), 0);
  });

  it('rechaza funciones asíncronas y revierte', () => {
    assert.throws(
      () =>
        withTransaction(db, async () => {
          insert('a');
        }),
      /síncrona/,
    );
    assert.equal(count(), 0);
    assert.equal(db.isTransaction, false);
  });
});
