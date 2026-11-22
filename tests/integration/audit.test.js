/**
 * Auditoría (Bloque 10): cadena de huellas, consulta con filtros, verificación
 * y detección de manipulaciones; anclas de las copias de seguridad.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GENESIS, chainHash, createAuditChain } from '../../backend/modules/audit/chain.js';
import { createAuditLog } from '../../backend/modules/audit/audit.js';
import { closeDatabase, expectSqliteError, migratedMemoryDb } from '../helpers/db.js';
import { startApp } from '../helpers/http.js';

describe('auditoría: cadena de huellas', () => {
  let db;
  beforeEach(() => {
    db = migratedMemoryDb();
  });
  afterEach(() => closeDatabase(db));

  const record = (action = 'prueba.accion', details = {}) => createAuditLog(db).record({ action, outcome: 'success', details });
  const chainRows = () => db.prepare('SELECT audit_id, hash FROM audit_chain ORDER BY audit_id').all();

  it('cada entrada queda encadenada con la anterior en la misma transacción', () => {
    record('a.uno');
    record('a.dos', { n: 2 });
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all();
    const chain = chainRows();
    assert.equal(chain.length, 2);
    assert.equal(chain[0].hash, chainHash(GENESIS, rows[0]));
    assert.equal(chain[1].hash, chainHash(chain[0].hash, rows[1]));
    assert.equal(createAuditChain(db).verify().ok, true);
  });

  it('las entradas anteriores sin huella se encadenan en orden con la siguiente que se registra', () => {
    db.prepare("INSERT INTO audit_logs (action, outcome) VALUES ('antigua.una', 'success'), ('antigua.dos', 'success')").run();
    assert.equal(createAuditChain(db).verify().unchained, 2);
    record('nueva');
    const v = createAuditChain(db).verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 3);
    assert.equal(v.unchained, 0);
  });

  it('si falla la transacción no queda ni la entrada ni su huella', () => {
    db.exec('BEGIN IMMEDIATE');
    record('dentro');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 0);
    assert.equal(chainRows().length, 0);
  });

  it('la base impide modificar, borrar o desordenar la cadena', () => {
    record('uno');
    record('dos');
    expectSqliteError(assert, () => db.prepare("UPDATE audit_chain SET hash = ? WHERE audit_id = 1").run('f'.repeat(64)), 'audit_log_immutable');
    expectSqliteError(assert, () => db.prepare('DELETE FROM audit_chain').run(), 'audit_log_immutable');
    db.prepare("INSERT INTO audit_logs (action, outcome) VALUES ('x.uno', 'success'), ('x.dos', 'success')").run();
    // Saltarse la primera sin huella (id 3) no está permitido.
    expectSqliteError(assert, () => db.prepare('INSERT INTO audit_chain (audit_id, hash) VALUES (4, ?)').run('a'.repeat(64)), 'audit_chain_order');
  });

  it('detecta una entrada modificada aunque se salten los triggers', () => {
    for (const a of ['uno', 'dos', 'tres', 'cuatro']) record(a);
    db.exec('DROP TRIGGER trg_audit_no_update');
    db.prepare("UPDATE audit_logs SET details = '{\"falso\":true}' WHERE id = 2").run();
    const v = createAuditChain(db).verify();
    assert.equal(v.ok, false);
    assert.deepEqual(v.problems, [{ id: 2, reason: 'hash_mismatch' }]);
  });

  it('detecta una entrada borrada de en medio', () => {
    for (const a of ['uno', 'dos', 'tres']) record(a);
    db.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER trg_audit_no_delete;');
    db.prepare('DELETE FROM audit_logs WHERE id = 2').run();
    const v = createAuditChain(db).verify();
    assert.equal(v.ok, false);
    assert.equal(v.problems[0].id, 3);
  });

  it('las anclas detectan que se borraron entradas del final o que se reescribió la cadena', () => {
    for (const a of ['uno', 'dos', 'tres']) record(a);
    const head = createAuditChain(db).head();
    assert.equal(createAuditChain(db).verify([{ source: 'copia', ...head }]).ok, true);
    assert.deepEqual(createAuditChain(db).verify([{ source: 'copia', id: head.id, hash: 'e'.repeat(64) }]).problems,
      [{ id: head.id, reason: 'anchor_mismatch', source: 'copia' }]);

    db.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER trg_audit_no_delete; DROP TRIGGER trg_audit_chain_no_delete;');
    db.prepare('DELETE FROM audit_chain WHERE audit_id = 3').run();
    db.prepare('DELETE FROM audit_logs WHERE id = 3').run();
    const v = createAuditChain(db).verify([{ source: 'copia', ...head }]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.problems, [{ id: 3, reason: 'anchor_missing', source: 'copia' }]);
  });
});

describe('auditoría: API', () => {
  let app;
  let api;
  let admin;
  beforeEach(async () => {
    app = await startApp();
    ({ api, admin } = await app.loginAsAdmin());
  });
  afterEach(() => app.stop());

  it('lista las entradas de la más reciente a la más antigua, con su autor', async () => {
    await api.json('/api/sections', { method: 'POST', body: { name: 'Prensa', slug: 'prensa', type: 'news', workflow: 'direct' } });
    const r = await api.json('/api/audit');
    assert.equal(r.status, 200);
    const ids = r.body.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    const login = r.body.entries.find((e) => e.action === 'auth.login');
    assert.equal(login.actor.username, 'admin');
    assert.equal(login.outcome, 'success');
    assert.equal(typeof login.details, 'object');
  });

  it('filtra por acción (exacta o prefijo), resultado, autor, entidad y fechas, y pagina', async () => {
    await app.login('admin', 'contraseña-incorrecta-1');
    await app.login('admin', 'contraseña-incorrecta-2');
    const fails = await api.json('/api/audit?action=auth.login&outcome=failure');
    assert.equal(fails.body.entries.length, 2);
    assert.ok(fails.body.entries.every((e) => e.action === 'auth.login' && e.outcome === 'failure'));

    const prefix = await api.json('/api/audit?action=auth.');
    assert.ok(prefix.body.entries.length >= 3);
    assert.ok(prefix.body.entries.every((e) => e.action.startsWith('auth.')));

    const mine = await api.json(`/api/audit?actor=${admin.id}`);
    assert.ok(mine.body.entries.every((e) => e.actor?.id === admin.id));

    const page1 = await api.json('/api/audit?limit=2');
    assert.equal(page1.body.entries.length, 2);
    assert.ok(page1.body.nextBefore);
    const page2 = await api.json(`/api/audit?limit=2&before=${page1.body.nextBefore}`);
    assert.ok(page2.body.entries.every((e) => e.id < page1.body.nextBefore));

    const future = await api.json('/api/audit?from=2999-01-01');
    assert.deepEqual(future.body.entries, []);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await api.json(`/api/audit?from=${today}&to=${today}`)).body.entries.length >= 3);
  });

  it('rechaza filtros desconocidos o mal formados', async () => {
    for (const q of ['x=1', 'action=DROP%20TABLE', 'outcome=ok', 'limit=0', 'limit=500', 'from=ayer', 'entityId=3', 'actor=-1', 'action=a&action=b']) {
      const r = await api.json(`/api/audit?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'validation_failed');
    }
  });

  it('verifica la cadena y detecta una manipulación', async () => {
    let v = await api.json('/api/audit/verify');
    assert.equal(v.status, 200);
    assert.equal(v.body.ok, true);
    assert.ok(v.body.checked >= 1);
    app.db.exec('DROP TRIGGER trg_audit_no_update');
    app.db.prepare("UPDATE audit_logs SET ip_address = '10.9.9.9' WHERE id = 1").run();
    v = await api.json('/api/audit/verify');
    assert.equal(v.body.ok, false);
    assert.deepEqual(v.body.problems, [{ id: 1, reason: 'hash_mismatch' }]);
  });

  it('no hay forma de modificar ni borrar la auditoría desde la API', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await api.json('/api/audit', { method, body: {} })).status, 405);
    }
    assert.equal((await api.json('/api/audit/1', { method: 'DELETE' })).status, 404);
  });

  it('solo el administrador general la consulta', async () => {
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    for (const path of ['/api/audit', '/api/audit/verify']) {
      assert.equal((await other.json(path)).status, 403);
      assert.equal((await app.request(path)).status, 401);
    }
  });
});
