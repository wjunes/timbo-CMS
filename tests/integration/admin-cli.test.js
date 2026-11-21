import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';
import { createPasswordHasher } from '../../backend/modules/auth/password.js';
import { createSessionStore } from '../../backend/modules/auth/sessions.js';
import { removeDir, tempDir } from '../helpers/db.js';

const PASSWORD = 'frase de acceso del administrador';
const NEW_PASSWORD = 'otra frase de acceso renovada';

let dir;
let dbPath;

function admin(command, lines, env = {}) {
  return spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'admin.js'), command], {
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', DATABASE_PATH: dbPath, ...env },
    input: lines.map((l) => `${l}\n`).join(''),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function withDb(fn) {
  const db = openDatabase(dbPath, { create: false });
  try {
    return fn(db);
  } finally {
    closeDatabase(db);
  }
}

before(() => {
  dir = tempDir();
  dbPath = path.join(dir, 'admin.db');
  const db = openDatabase(dbPath);
  migrate(db);
  closeDatabase(db);
});
after(() => removeDir(dir));

describe('scripts/admin.js', () => {
  it('rechaza contraseñas que no cumplen la política o no coinciden, sin crear nada', () => {
    let r = admin('create', ['jefa', 'jefa@example.org', 'Jefa', 'corta']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /al menos 12/);
    r = admin('create', ['jefa', 'jefa@example.org', 'Jefa', PASSWORD, 'distinta de la anterior']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no coinciden/);
    r = admin('create', ['no válido!', 'jefa@example.org', 'Jefa', PASSWORD, PASSWORD]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usuario inválido/);
    assert.equal(withDb((db) => db.prepare('SELECT count(*) AS n FROM users').get().n), 0);
  });

  it('reset-password sin administrador general informa y falla', () => {
    const r = admin('reset-password', [NEW_PASSWORD, NEW_PASSWORD]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No existe administrador general/);
  });

  it('crea el general_admin con Argon2id y lo audita; la contraseña no aparece en la salida', async () => {
    const r = admin('create', ['jefa', 'jefa@example.org', 'Jefa de redacción', PASSWORD, PASSWORD]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Administrador general "jefa" creado/);
    assert.ok(!r.stdout.includes(PASSWORD) && !r.stderr.includes(PASSWORD));

    const { user, auditRow } = withDb((db) => ({
      user: db.prepare("SELECT username, role, status, password_hash FROM users WHERE role = 'general_admin'").get(),
      auditRow: db.prepare("SELECT action, details FROM audit_logs WHERE action = 'user.create'").get(),
    }));
    assert.equal(user.username, 'jefa');
    assert.equal(user.status, 'active');
    assert.match(user.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    assert.equal(await createPasswordHasher().verify(PASSWORD, user.password_hash), true);
    assert.deepEqual(JSON.parse(auditRow.details), { role: 'general_admin', via: 'cli' });
  });

  it('no permite crear un segundo general_admin', () => {
    const r = admin('create', ['otro', 'otro@example.org', 'Otro', PASSWORD, PASSWORD]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Ya existe un administrador general/);
  });

  it('reset-password cambia la contraseña, revoca todas las sesiones y lo audita', async () => {
    const tokens = withDb((db) => {
      const { id } = db.prepare("SELECT id FROM users WHERE role = 'general_admin'").get();
      const store = createSessionStore(db, { ttlMs: 3_600_000, idleMs: 600_000 });
      return [store.create({ userId: id }).token, store.create({ userId: id }).token];
    });

    const r = admin('reset-password', [NEW_PASSWORD, NEW_PASSWORD]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Sesiones revocadas: 2/);

    const hasher = createPasswordHasher();
    withDb((db) => {
      const store = createSessionStore(db, { ttlMs: 3_600_000, idleMs: 600_000 });
      for (const t of tokens) assert.equal(store.resolve(t), null);
      const row = db.prepare("SELECT details FROM audit_logs WHERE action = 'auth.password_reset'").get();
      assert.deepEqual(JSON.parse(row.details), { via: 'cli', revokedCount: 2 });
    });
    const { password_hash: hash } = withDb((db) => db.prepare("SELECT password_hash FROM users WHERE role = 'general_admin'").get());
    assert.equal(await hasher.verify(NEW_PASSWORD, hash), true);
    assert.equal(await hasher.verify(PASSWORD, hash), false);
  });

  it('rechaza órdenes desconocidas y bases sin migrar', () => {
    assert.equal(admin('delete', []).status, 1);
    const r = admin('create', [], { DATABASE_PATH: path.join(dir, 'no-existe.db') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no existe/);
  });
});
