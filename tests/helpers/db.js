/**
 * Utilidades de prueba para la base de datos. No es un archivo *.test.js: el
 * runner no lo ejecuta directamente.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../../backend/database/connection.js';
import { migrate } from '../../backend/database/migrator.js';

// Hash con formato PHC Argon2id ficticio: solo satisface el CHECK del esquema.
export const FAKE_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cms-test-'));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Base de datos en memoria con todas las migraciones aplicadas. */
export function migratedMemoryDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export { closeDatabase };

let seq = 0;
export function insertUser(db, { role = 'section_admin', status = 'active', username } = {}) {
  const name = username ?? `user${++seq}`;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, email, display_name, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, `${name}@example.org`, `Usuario ${name}`, FAKE_HASH, role, status);
  return Number(lastInsertRowid);
}

/** Crea un contenido con una versión en borrador. */
export function insertContent(db, { sectionId = 2, userId, slug } = {}) {
  const contentId = Number(
    db.prepare('INSERT INTO contents (section_id, slug, created_by) VALUES (?, ?, ?)').run(sectionId, slug ?? `contenido-${++seq}`, userId)
      .lastInsertRowid,
  );
  const versionId = insertVersion(db, { contentId, userId, number: 1 });
  return { contentId, versionId };
}

export function insertVersion(db, { contentId, userId, number, basedOn = null }) {
  return Number(
    db
      .prepare('INSERT INTO content_versions (content_id, version_number, based_on_version_id, title, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(contentId, number, basedOn, `Título v${number}`, userId).lastInsertRowid,
  );
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Publica una versión respetando las invariantes. En secciones con flujo
 * `approval` (migración 005) la envía, la revisa y la aprueba antes, con
 * `userId` como revisor (debe ser general_admin). No abre transacción propia.
 */
export function publishVersion(db, { contentId, versionId, userId }) {
  const { status, workflow } = db
    .prepare('SELECT v.status, s.workflow FROM content_versions AS v JOIN contents AS c ON c.id = v.content_id JOIN sections AS s ON s.id = c.section_id WHERE v.id = ?')
    .get(versionId);
  if (status === 'draft' && workflow === 'approval') {
    submitVersion(db, { versionId, userId });
    reviewVersion(db, { versionId, reviewerId: userId, decision: 'approved' });
  }
  db.prepare(`UPDATE content_versions SET status = 'published', published_by = ?, published_at = ${NOW} WHERE id = ?`).run(userId, versionId);
  db.prepare("UPDATE contents SET status = 'published', published_version_id = ? WHERE id = ?").run(versionId, contentId);
}

export function submitVersion(db, { versionId, userId }) {
  db.prepare(`UPDATE content_versions SET status = 'pending_review', submitted_by = ?, submitted_at = ${NOW} WHERE id = ?`).run(userId, versionId);
}

/** Registra la revisión de una versión pendiente y aplica su decisión (migración 005). */
export function reviewVersion(db, { versionId, reviewerId, decision = 'approved', comment = '' }) {
  db.prepare('INSERT INTO publication_reviews (content_version_id, reviewer_id, decision, comment) VALUES (?, ?, ?, ?)')
    .run(versionId, reviewerId, decision, comment);
  if (decision === 'approved') {
    db.prepare(`UPDATE content_versions SET status = 'approved', approved_by = ?, approved_at = ${NOW} WHERE id = ?`).run(reviewerId, versionId);
  } else {
    db.prepare("UPDATE content_versions SET status = 'changes_requested' WHERE id = ?").run(versionId);
  }
}

/** Comprueba que la función falle con un error de SQLite cuyo mensaje contenga `fragment`. */
export function expectSqliteError(assert, fn, fragment) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'ERR_SQLITE_ERROR', `se esperaba un error SQLite, se obtuvo: ${err.message}`);
    assert.ok(err.message.includes(fragment), `"${err.message}" no contiene "${fragment}"`);
    return true;
  });
}
