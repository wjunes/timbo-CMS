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

/** Publica directamente una versión en borrador (modalidad direct), respetando las invariantes. */
export function publishVersion(db, { contentId, versionId, userId }) {
  db.prepare(`UPDATE content_versions SET status = 'published', published_by = ?, published_at = ${NOW} WHERE id = ?`).run(userId, versionId);
  db.prepare("UPDATE contents SET status = 'published', published_version_id = ? WHERE id = ?").run(versionId, contentId);
}

export function submitVersion(db, { versionId, userId }) {
  db.prepare(`UPDATE content_versions SET status = 'pending_review', submitted_by = ?, submitted_at = ${NOW} WHERE id = ?`).run(userId, versionId);
}

/** Comprueba que la función falle con un error de SQLite cuyo mensaje contenga `fragment`. */
export function expectSqliteError(assert, fn, fragment) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'ERR_SQLITE_ERROR', `se esperaba un error SQLite, se obtuvo: ${err.message}`);
    assert.ok(err.message.includes(fragment), `"${err.message}" no contiene "${fragment}"`);
    return true;
  });
}
