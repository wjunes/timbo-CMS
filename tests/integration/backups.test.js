/**
 * Copias de seguridad (Bloque 10): creación coherente, manifiesto, verificación
 * y manipulaciones, retención, copias automáticas, API, anclas de auditoría y
 * restauración controlada (con base en archivo).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { loadMigrations, migrate } from '../../backend/database/migrator.js';
import { createAuditModule } from '../../backend/modules/audit/index.js';
import { createBackupScheduler } from '../../backend/modules/backups/index.js';
import { acquireLock, serverLockFile } from '../../backend/modules/backups/lock.js';
import { checkSchemaCompatible, restoreBackup } from '../../backend/modules/backups/restore.js';
import { createBackupService, verifyBackupDir } from '../../backend/modules/backups/service.js';
import { removeDir, tempDir } from '../helpers/db.js';
import { startApp } from '../helpers/http.js';
import { makePng, upload } from '../helpers/media.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

describe('copias de seguridad: API', () => {
  let app;
  let api;
  beforeEach(async () => {
    app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0' } });
    ({ api } = await app.loginAsAdmin());
  });
  afterEach(() => app.stop());

  const dirOf = (id) => path.join(app.config.storageDir, 'backups', id);

  async function createBackup() {
    const r = await api.json('/api/backups', { method: 'POST' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.backup;
  }

  it('crea una copia coherente con la base, los archivos y un manifiesto verificable', async () => {
    const up = await upload(api, 2, makePng({ width: 5, height: 4 }));
    assert.equal(up.status, 201);
    fs.mkdirSync(path.join(app.config.storageDir, 'private', 'informes'), { recursive: true });
    fs.writeFileSync(path.join(app.config.storageDir, 'private', 'informes', 'nota.txt'), 'privado');

    const b = await createBackup();
    assert.match(b.id, /^\d{14}$/);
    assert.equal(b.kind, 'manual');
    assert.equal(b.mediaCount, 1);
    assert.equal(b.schemaVersion, loadMigrations().length);
    assert.deepEqual(b.warnings, []);

    const manifest = JSON.parse(fs.readFileSync(path.join(dirOf(b.id), 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'cms-multiseccion-backup');
    assert.equal(manifest.app.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
    assert.deepEqual(manifest.files.map((f) => f.path).sort(),
      ['database.sqlite', `media/${app.db.prepare('SELECT storage_key FROM media').get().storage_key}`, 'private/informes/nota.txt']);
    assert.equal(manifest.auditHead.id > 0, true);

    // La base copiada es un archivo único (sin WAL) con los datos del momento.
    const copy = new DatabaseSync(path.join(dirOf(b.id), 'database.sqlite'), { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(copy.prepare('SELECT count(*) AS n FROM media').get().n, 1);
    } finally {
      copy.close();
    }
    assert.deepEqual((await api.json(`/api/backups/${b.id}/verify`, { method: 'POST' })).body, { ok: true, issues: [] });

    const audit = app.db.prepare("SELECT outcome, details FROM audit_logs WHERE action = 'backup.create'").all();
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].details).id, b.id);
    // Nada temporal queda a la vista.
    assert.deepEqual(fs.readdirSync(path.join(app.config.storageDir, 'backups')).filter((n) => n !== '.lock'), [b.id]);
  });

  it('la verificación detecta archivos alterados, borrados o añadidos y una base dañada', async () => {
    await upload(api, 2, makePng());
    const b = await createBackup();
    const verify = async () => (await api.json(`/api/backups/${b.id}/verify`, { method: 'POST' })).body;
    const media = fs.readdirSync(path.join(dirOf(b.id), 'media'))[0];

    fs.appendFileSync(path.join(dirOf(b.id), 'media', media), 'x');
    assert.deepEqual((await verify()).issues, [{ code: 'file_corrupt', path: `media/${media}` }]);
    fs.rmSync(path.join(dirOf(b.id), 'media', media));
    assert.deepEqual((await verify()).issues, [{ code: 'file_missing', path: `media/${media}` }]);
    fs.writeFileSync(path.join(dirOf(b.id), 'media', 'f'.repeat(32)), 'intruso');
    assert.ok((await verify()).issues.some((i) => i.code === 'unexpected_file'));

    const db = path.join(dirOf(b.id), 'database.sqlite');
    const bytes = fs.readFileSync(db);
    bytes[200] ^= 0xff;
    fs.writeFileSync(db, bytes);
    const r = await verify();
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.path === 'database.sqlite'));
    assert.ok(app.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'backup.verify' AND outcome = 'failure'").get());
  });

  it('un manifiesto con rutas fuera de la copia se rechaza sin leerlas', async () => {
    const b = await createBackup();
    const file = path.join(dirOf(b.id), 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const bad of ['../../cms.lock', 'media/../../x', '/etc/passwd', 'private/../media', 'otra/cosa']) {
      fs.writeFileSync(file, JSON.stringify({ ...manifest, files: [...manifest.files, { path: bad, size: 1, sha256: '0'.repeat(64) }] }));
      assert.deepEqual((await verifyBackupDir(dirOf(b.id))).issues, [{ code: 'manifest_invalid' }], bad);
    }
  });

  it('lista, consulta y elimina copias; ids desconocidos o mal formados responden 404', async () => {
    const a = await createBackup();
    app.clock.now += 2000;
    const b = await createBackup();
    const list = await api.json('/api/backups');
    assert.deepEqual(list.body.backups.map((x) => x.id), [b.id, a.id]);
    assert.deepEqual(list.body.schedule, { intervalHours: 0, keep: 14 });
    assert.equal((await api.json(`/api/backups/${a.id}`)).body.backup.id, a.id);

    assert.equal((await api.json(`/api/backups/${a.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(fs.existsSync(dirOf(a.id)), false);
    assert.ok(app.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'backup.delete'").get());
    for (const p of [`/api/backups/${a.id}`, '/api/backups/123', '/api/backups/..%2F..', '/api/backups/99999999999999']) {
      assert.equal((await api.json(p)).status, 404, p);
    }
    assert.equal((await api.json('/api/backups/123', { method: 'DELETE' })).status, 404);
  });

  it('dos copias en el mismo segundo tienen ids distintos; una a la vez (409 si hay otra en curso)', async () => {
    const a = await createBackup();
    const b = await createBackup();
    assert.notEqual(a.id, b.id);
    const release = acquireLock(path.join(app.config.storageDir, 'backups', '.lock'), 'otra');
    try {
      // El bloqueo es del propio proceso: se trata como ocupado.
      assert.equal((await api.json('/api/backups', { method: 'POST' })).body.error, 'backup_in_progress');
    } finally {
      release();
    }
  });

  it('la verificación de la auditoría usa las copias como anclas', async () => {
    const { auditHead } = await createBackup();
    assert.equal((await api.json('/api/audit/verify')).body.ok, true);
    // Borrar las últimas entradas (y sus huellas) pasa la cadena, pero no el ancla.
    const head = auditHead.id;
    app.db.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER trg_audit_no_delete; DROP TRIGGER trg_audit_chain_no_delete;');
    app.db.prepare('DELETE FROM audit_chain WHERE audit_id >= ?').run(head);
    app.db.prepare('DELETE FROM audit_logs WHERE id >= ?').run(head);
    app.db.exec('PRAGMA foreign_keys = ON');
    const v = (await api.json('/api/audit/verify')).body;
    assert.equal(v.ok, false);
    assert.equal(v.problems[0].reason, 'anchor_missing');
  });

  it('solo el administrador general gestiona copias; no hay ruta de restauración ni de descarga', async () => {
    const b = await createBackup();
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    for (const [method, p] of [['GET', '/api/backups'], ['POST', '/api/backups'], ['GET', `/api/backups/${b.id}`],
      ['POST', `/api/backups/${b.id}/verify`], ['DELETE', `/api/backups/${b.id}`]]) {
      assert.equal((await other.json(p, { method })).status, 403, `${method} ${p}`);
    }
    assert.equal((await api.json(`/api/backups/${b.id}/restore`, { method: 'POST' })).status, 404);
    assert.equal((await api.json(`/api/backups/${b.id}/download`)).status, 404);
    assert.equal((await app.request(`/backups/${b.id}/database.sqlite`)).status, 404);
  });
});

describe('copias de seguridad: retención y copias automáticas', () => {
  let app;
  beforeEach(async () => {
    app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0' } });
  });
  afterEach(() => app.stop());

  it('conserva las N automáticas más recientes y nunca borra las manuales', async () => {
    const service = app.server.backups;
    const manual = await service.create({ kind: 'manual' });
    const auto = [];
    for (let i = 0; i < 4; i += 1) {
      app.clock.now += 5000;
      auto.push((await service.create({ kind: 'automatic' })).id);
    }
    const removed = await service.prune(2);
    assert.deepEqual(removed.sort(), auto.slice(0, 2).sort());
    assert.deepEqual((await service.list()).map((b) => b.id).sort(), [manual.id, ...auto.slice(2)].sort());
    assert.ok(app.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'backup.prune'").get());
  });

  it('el programador solo crea una copia cuando la última automática es más antigua que el intervalo', async () => {
    const service = app.server.backups;
    const scheduler = createBackupScheduler({ service, intervalHours: 24, keep: 3, logger: silent, clock: () => app.clock.now });
    assert.ok(await scheduler.tick());
    app.clock.now += 3_600_000;
    assert.equal(await scheduler.tick(), null);
    app.clock.now += 24 * 3_600_000;
    assert.ok(await scheduler.tick());
    assert.equal((await service.list()).filter((b) => b.kind === 'automatic').length, 2);
    const off = createBackupScheduler({ service, intervalHours: 0, keep: 3, logger: silent });
    assert.equal(await off.tick(), null);
  });
});

describe('copias de seguridad: restauración', () => {
  let dir;
  let config;
  let db;
  beforeEach(() => {
    dir = tempDir();
    config = { databasePath: path.join(dir, 'cms.db'), storageDir: path.join(dir, 'storage') };
    db = openDatabase(config.databasePath);
    migrate(db);
  });
  afterEach(() => {
    if (db.isOpen) closeDatabase(db);
    removeDir(dir);
  });

  const service = () => createBackupService({ db, storageDir: config.storageDir, logger: silent });
  const setting = (d) => d.prepare("SELECT value FROM settings WHERE key = 'site.name'").get().value;

  function addMedia(key, content) {
    fs.mkdirSync(path.join(config.storageDir, 'media'), { recursive: true });
    fs.writeFileSync(path.join(config.storageDir, 'media', key), content);
    const userId = Number(db.prepare("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('usuario1', 'usuario1@example.org', 'U', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo', 'general_admin')").run().lastInsertRowid);
    db.prepare(`INSERT INTO media (storage_key, original_name, mime_type, extension, size_bytes, sha256, visibility, section_id, uploaded_by)
      VALUES (?, 'a.png', 'image/png', 'png', ?, ?, 'public', 2, ?)`).run(key, content.length, sha256(content), userId);
    return userId;
  }

  it('devuelve la base y los archivos al estado de la copia, guarda antes el estado actual y revoca las sesiones', async () => {
    const key = 'a'.repeat(32);
    const userId = addMedia(key, Buffer.from('original'));
    db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (randomblob(32), ?, '2999-01-01T00:00:00.000Z')`).run(userId);
    const backup = await service().create({ kind: 'manual' });

    // Cambios posteriores que la restauración debe deshacer.
    db.prepare(`UPDATE settings SET value = '"Cambiado"' WHERE key = 'site.name'`).run();
    fs.writeFileSync(path.join(config.storageDir, 'media', 'b'.repeat(32)), 'nuevo');
    fs.rmSync(path.join(config.storageDir, 'media', key));
    closeDatabase(db);

    const r = await restoreBackup({ config, id: backup.id, logger: silent, clock: () => Date.now() + 5000 });
    assert.equal(r.id, backup.id);
    assert.ok(r.safetyBackupId);
    assert.equal(r.revokedCount, 1);

    db = openDatabase(config.databasePath, { create: false });
    assert.equal(setting(db), '"CMS-MULTISECCIÓN"');
    assert.deepEqual(fs.readdirSync(path.join(config.storageDir, 'media')), [key]);
    assert.equal(fs.readFileSync(path.join(config.storageDir, 'media', key), 'utf8'), 'original');
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL').get().n, 0);
    const audit = db.prepare("SELECT details FROM audit_logs WHERE action = 'backup.restore' AND outcome = 'success'").get();
    assert.equal(JSON.parse(audit.details).backupId, backup.id);

    // La copia del estado anterior tiene los cambios descartados.
    const safety = await service().get(r.safetyBackupId);
    assert.equal(safety.kind, 'pre_restore');
    const old = new DatabaseSync(path.join(config.storageDir, 'backups', r.safetyBackupId, 'database.sqlite'), { readOnly: true });
    assert.equal(setting(old), '"Cambiado"');
    old.close();
    // No quedan restos de la preparación.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cms.db', 'cms.db-shm', 'cms.db-wal', 'storage'].filter((n) => fs.existsSync(path.join(dir, n))).sort());
    assert.ok(!fs.readdirSync(config.storageDir).some((n) => n.includes('restore')));
    // La cadena de auditoría sigue íntegra y las anclas de la historia descartada no cuentan.
    const v = await createAuditModule({ db, anchors: service().anchors }).verify();
    assert.equal(v.ok, true, JSON.stringify(v.problems));
  });

  it('no restaura con el servidor en marcha', async () => {
    const backup = await service().create();
    const release = acquireLock(serverLockFile(config.storageDir), 'server');
    try {
      await assert.rejects(restoreBackup({ config, id: backup.id, logger: silent }), { code: 'server_running' });
    } finally {
      release();
    }
  });

  it('no restaura una copia manipulada ni deja cambios a medias', async () => {
    const backup = await service().create();
    db.prepare(`UPDATE settings SET value = '"Actual"' WHERE key = 'site.name'`).run();
    const copy = path.join(config.storageDir, 'backups', backup.id, 'database.sqlite');
    fs.appendFileSync(copy, Buffer.alloc(4096));
    closeDatabase(db);
    await assert.rejects(restoreBackup({ config, id: backup.id, logger: silent }), { code: 'backup_invalid' });
    db = openDatabase(config.databasePath, { create: false });
    assert.equal(setting(db), '"Actual"');
    assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'backup.restore' AND outcome = 'failure'").get());
    await assert.rejects(restoreBackup({ config, id: '12345678901234', logger: silent }), { code: 'backup_not_found' });
    await assert.rejects(restoreBackup({ config, id: '../x', logger: silent }), { code: 'backup_not_found' });
  });

  it('solo admite copias con un esquema que es prefijo del código', () => {
    const code = loadMigrations();
    const of = (list) => list.map(({ version, name, checksum }) => ({ version, name, checksum }));
    assert.equal(checkSchemaCompatible(of(code), code), null);
    assert.equal(checkSchemaCompatible(of(code.slice(0, 5)), code), null);
    assert.equal(checkSchemaCompatible([...of(code), { version: code.length + 1, name: 'futura', checksum: 'f'.repeat(64) }], code), 'schema_newer');
    const altered = of(code);
    altered[2] = { ...altered[2], checksum: '0'.repeat(64) };
    assert.equal(checkSchemaCompatible(altered, code), 'schema_mismatch');
  });

  it('una copia de un esquema anterior al del código se restaura y se migra', async () => {
    const backup = await service().create();
    // Código «futuro», con una migración más que la copia.
    const future = [...loadMigrations(), {
      version: loadMigrations().length + 1, name: 'futura', file: 'futura.sql', checksum: 'c'.repeat(64),
      sql: 'CREATE TABLE prueba_futura (id INTEGER PRIMARY KEY) STRICT;',
    }];
    closeDatabase(db);
    const r = await restoreBackup({ config, id: backup.id, logger: silent, clock: () => Date.now() + 5000, migrations: future });
    assert.equal(r.migrationsApplied, 1);
    db = openDatabase(config.databasePath, { create: false });
    assert.equal(db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, future.length);
  });

  it('el bloqueo abandonado por un proceso que ya no existe se reemplaza', () => {
    const file = serverLockFile(config.storageDir);
    fs.mkdirSync(config.storageDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, purpose: 'server' }));
    const release = acquireLock(file, 'restore');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    release();
    assert.equal(fs.existsSync(file), false);
  });

  it('registra la creación fallida en la auditoría', async () => {
    const broken = createBackupService({ db, storageDir: path.join(dir, 'archivo'), logger: silent });
    fs.writeFileSync(path.join(dir, 'archivo'), 'no es un directorio');
    await assert.rejects(broken.create());
    assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'backup.create' AND outcome = 'failure'").get());
  });
});
