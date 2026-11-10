/**
 * Invariantes estructurales del esquema 001. Cada prueba verifica que la base de
 * datos, por sí misma, impide un estado inválido (independientemente de la app).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { withTransaction } from '../../backend/database/transaction.js';
import {
  closeDatabase,
  expectSqliteError,
  insertContent,
  insertUser,
  insertVersion,
  migratedMemoryDb,
  publishVersion,
  submitVersion,
} from '../helpers/db.js';

let db;
let admin; // general_admin
let editor; // section_admin

beforeEach(() => {
  db = migratedMemoryDb();
  admin = insertUser(db, { role: 'general_admin', username: 'admin' });
  editor = insertUser(db, { role: 'section_admin', username: 'editor' });
});
afterEach(() => closeDatabase(db));

const run = (sql, ...params) => db.prepare(sql).run(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);

describe('esquema: estructura general', () => {
  it('crea las 14 tablas del modelo más schema_migrations, todas STRICT', () => {
    const tables = db
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    assert.deepEqual(
      tables.map((t) => t.name),
      [
        'audit_logs', 'content_media', 'content_versions', 'contents', 'media', 'permissions', 'publication_reviews',
        'schema_migrations', 'section_types', 'sections', 'sessions', 'settings', 'user_section_permissions', 'user_sections', 'users',
      ],
    );
    for (const t of tables) assert.equal(t.strict, 1, `${t.name} debe ser STRICT`);
  });

  it('no deja violaciones de claves foráneas ni problemas de integridad', () => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(get('PRAGMA integrity_check').integrity_check, 'ok');
  });

  it('incluye los 5 tipos de sección y las 5 secciones predefinidas del sistema', () => {
    assert.deepEqual(
      db.prepare('SELECT code FROM section_types ORDER BY id').all().map((r) => r.code),
      ['institutional', 'news', 'articles', 'documents', 'faq'],
    );
    const sections = db.prepare('SELECT slug, is_system, workflow, parent_id FROM sections ORDER BY sort_order').all();
    assert.deepEqual(sections.map((s) => s.slug), ['institucional', 'noticias', 'articulos', 'biblioteca', 'preguntas-frecuentes']);
    for (const s of sections) {
      assert.equal(s.is_system, 1);
      assert.equal(s.workflow, 'approval', 'el flujo por defecto es el más restrictivo');
      assert.equal(s.parent_id, null);
    }
  });
});

describe('esquema: usuarios', () => {
  it('impide un segundo general_admin', () => {
    expectSqliteError(assert, () => insertUser(db, { role: 'general_admin' }), 'UNIQUE constraint failed');
  });

  it('el rol es inmutable (sin escalada ni degradación)', () => {
    expectSqliteError(assert, () => run("UPDATE users SET role = 'general_admin' WHERE id = ?", editor), 'user_role_immutable');
    expectSqliteError(assert, () => run("UPDATE users SET role = 'section_admin' WHERE id = ?", admin), 'user_role_immutable');
  });

  it('el general_admin no puede suspenderse ni desactivarse', () => {
    for (const status of ['suspended', 'disabled']) {
      expectSqliteError(assert, () => run('UPDATE users SET status = ? WHERE id = ?', status, admin), 'CHECK constraint failed');
    }
    run("UPDATE users SET status = 'suspended' WHERE id = ?", editor);
  });

  it('los usuarios no se eliminan', () => {
    expectSqliteError(assert, () => run('DELETE FROM users WHERE id = ?', editor), 'user_delete_forbidden');
    expectSqliteError(assert, () => run('DELETE FROM users WHERE id = ?', admin), 'user_delete_forbidden');
  });

  it('solo admite hashes Argon2id', () => {
    expectSqliteError(
      assert,
      () => run("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('x1x', 'x@e.org', 'X', 'plaintext', 'section_admin')"),
      'CHECK constraint failed',
    );
    expectSqliteError(
      assert,
      () => run("INSERT INTO users (username, email, display_name, password_hash, role) VALUES ('x1x', 'x@e.org', 'X', '$2b$10$bcrypt', 'section_admin')"),
      'CHECK constraint failed',
    );
  });

  it('username y email son únicos sin distinguir mayúsculas', () => {
    expectSqliteError(assert, () => insertUser(db, { username: 'EDITOR' }), 'UNIQUE constraint failed');
  });

  it('rechaza roles y estados desconocidos y usernames con caracteres no permitidos', () => {
    expectSqliteError(assert, () => insertUser(db, { role: 'root' }), 'CHECK constraint failed');
    expectSqliteError(assert, () => insertUser(db, { status: 'banned' }), 'CHECK constraint failed');
    expectSqliteError(assert, () => insertUser(db, { username: '<script>' }), 'CHECK constraint failed');
  });
});

describe('esquema: secciones', () => {
  const insertSection = (slug, parentId = null) =>
    Number(run("INSERT INTO sections (section_type_id, parent_id, slug, name, presentation) VALUES (1, ?, ?, 'S', 'page')", parentId, slug).lastInsertRowid);

  it('las secciones del sistema no se eliminan ni pierden su marca', () => {
    expectSqliteError(assert, () => run('DELETE FROM sections WHERE id = 1'), 'system_section_protected');
    expectSqliteError(assert, () => run('UPDATE sections SET is_system = 0 WHERE id = 1'), 'system_section_protected');
  });

  it('una sección personalizada sin contenidos puede eliminarse', () => {
    const id = insertSection('temporal');
    run('DELETE FROM sections WHERE id = ?', id);
  });

  for (const slug of ['Mayus', 'con espacio', '-inicio', 'fin-', 'doble--guion', 'acentuación', '', '../x']) {
    it(`rechaza el slug inválido "${slug}"`, () => {
      expectSqliteError(assert, () => insertSection(slug), 'CHECK constraint failed');
    });
  }

  it('reserva prefijos del sistema solo en el primer nivel', () => {
    expectSqliteError(assert, () => insertSection('admin'), 'CHECK constraint failed');
    insertSection('admin', 1);
  });

  it('slug único entre hermanos, incluida la raíz', () => {
    expectSqliteError(assert, () => insertSection('noticias'), 'UNIQUE constraint failed');
    insertSection('anuario', 1);
    expectSqliteError(assert, () => insertSection('anuario', 1), 'UNIQUE constraint failed');
    insertSection('anuario', 2);
  });

  it('impide ciclos en la jerarquía', () => {
    const a = insertSection('nivel-a');
    const b = insertSection('nivel-b', a);
    const c = insertSection('nivel-c', b);
    expectSqliteError(assert, () => run('UPDATE sections SET parent_id = ? WHERE id = ?', c, a), 'section_cycle');
    // Autorreferencia: el trigger se evalúa antes que el CHECK; ambos la rechazan.
    expectSqliteError(assert, () => run('UPDATE sections SET parent_id = ? WHERE id = ?', a, a), 'section_cycle');
    expectSqliteError(assert, () => insertSection('huerfana', 9999), 'FOREIGN KEY constraint failed');
    run('UPDATE sections SET parent_id = ? WHERE id = ?', a, c); // mover c bajo a es válido
  });

  it('solo admite flujos y presentaciones del sistema', () => {
    expectSqliteError(assert, () => run("UPDATE sections SET workflow = 'auto' WHERE id = 1"), 'CHECK constraint failed');
    expectSqliteError(assert, () => run("UPDATE sections SET presentation = 'custom_html' WHERE id = 1"), 'CHECK constraint failed');
  });
});

describe('esquema: asignaciones y permisos', () => {
  let permissionId;
  beforeEach(() => {
    permissionId = Number(run("INSERT INTO permissions (code, description) VALUES ('test.perm', 'Permiso de prueba')").lastInsertRowid);
  });
  const assign = (userId, sectionId, by = admin) =>
    run('INSERT INTO user_sections (user_id, section_id, assigned_by) VALUES (?, ?, ?)', userId, sectionId, by);
  const grant = (userId, sectionId, by = admin) =>
    run('INSERT INTO user_section_permissions (user_id, section_id, permission_id, granted_by) VALUES (?, ?, ?, ?)', userId, sectionId, permissionId, by);

  it('solo se asignan secciones a section_admin y solo las asigna el general_admin', () => {
    assign(editor, 2);
    expectSqliteError(assert, () => assign(admin, 3), 'assignee_must_be_section_admin');
    const other = insertUser(db);
    expectSqliteError(assert, () => assign(other, 3, editor), 'assigner_must_be_general_admin');
  });

  it('las asignaciones no se modifican', () => {
    assign(editor, 2);
    expectSqliteError(assert, () => run('UPDATE user_sections SET section_id = 3 WHERE user_id = ?', editor), 'assignment_immutable');
  });

  it('no puede concederse un permiso sobre una sección no asignada', () => {
    expectSqliteError(assert, () => grant(editor, 2), 'FOREIGN KEY constraint failed');
  });

  it('solo el general_admin concede permisos', () => {
    assign(editor, 2);
    expectSqliteError(assert, () => grant(editor, 2, editor), 'granter_must_be_general_admin');
  });

  it('revocar la asignación elimina sus permisos', () => {
    assign(editor, 2);
    grant(editor, 2);
    run('DELETE FROM user_sections WHERE user_id = ? AND section_id = 2', editor);
    assert.equal(get('SELECT count(*) AS n FROM user_section_permissions').n, 0);
  });
});

describe('esquema: contenidos y versiones', () => {
  it('slug único por sección, reutilizable tras eliminar', () => {
    const { contentId } = insertContent(db, { userId: editor, slug: 'aviso' });
    expectSqliteError(assert, () => insertContent(db, { userId: editor, slug: 'aviso' }), 'UNIQUE constraint failed');
    insertContent(db, { userId: editor, slug: 'aviso', sectionId: 3 });
    run("UPDATE contents SET status = 'deleted', deleted_by = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", admin, contentId);
    insertContent(db, { userId: editor, slug: 'aviso' });
  });

  it('publicado requiere puntero a versión publicada del mismo contenido', () => {
    const a = insertContent(db, { userId: editor });
    const b = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => run("UPDATE contents SET status = 'published' WHERE id = ?", a.contentId), 'CHECK constraint failed');
    expectSqliteError(
      assert,
      () => run("UPDATE contents SET status = 'published', published_version_id = ? WHERE id = ?", a.versionId, a.contentId),
      'published_version_not_published',
    );
    publishVersion(db, { ...b, userId: admin });
    expectSqliteError(
      assert,
      () => run("UPDATE contents SET status = 'published', published_version_id = ? WHERE id = ?", b.versionId, a.contentId),
      'FOREIGN KEY constraint failed',
    );
  });

  it('una sola versión en curso por contenido', () => {
    const { contentId } = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => insertVersion(db, { contentId, userId: editor, number: 2 }), 'UNIQUE constraint failed');
  });

  it('el borrador es editable y descartable', () => {
    const { contentId, versionId } = insertContent(db, { userId: editor });
    run("UPDATE content_versions SET title = 'Nuevo', revision = revision + 1 WHERE id = ?", versionId);
    run('DELETE FROM content_versions WHERE id = ?', versionId);
    run('DELETE FROM contents WHERE id = ?', contentId);
  });

  it('una versión enviada a revisión es inmutable, no vuelve a borrador y no se elimina', () => {
    const { versionId } = insertContent(db, { userId: editor });
    submitVersion(db, { versionId, userId: editor });
    expectSqliteError(assert, () => run("UPDATE content_versions SET title = 'Cambio' WHERE id = ?", versionId), 'content_version_immutable');
    expectSqliteError(assert, () => run("UPDATE content_versions SET body = '{\"type\":\"doc\"}' WHERE id = ?", versionId), 'content_version_immutable');
    expectSqliteError(assert, () => run("UPDATE content_versions SET status = 'draft' WHERE id = ?", versionId), 'content_version_immutable');
    expectSqliteError(assert, () => run('DELETE FROM content_versions WHERE id = ?', versionId), 'content_version_immutable');
  });

  it('la identidad de una versión es inmutable incluso en borrador', () => {
    const { versionId } = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => run('UPDATE content_versions SET version_number = 9 WHERE id = ?', versionId), 'content_version_immutable');
    expectSqliteError(assert, () => run('UPDATE content_versions SET created_by = ? WHERE id = ?', admin, versionId), 'content_version_immutable');
  });

  it('los estados exigen sus marcas de autoría (enviado, aprobado, publicado)', () => {
    const { versionId } = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => run("UPDATE content_versions SET status = 'pending_review' WHERE id = ?", versionId), 'CHECK constraint failed');
    expectSqliteError(assert, () => run("UPDATE content_versions SET status = 'published' WHERE id = ?", versionId), 'CHECK constraint failed');
    expectSqliteError(
      assert,
      () => run("UPDATE content_versions SET submitted_by = ? WHERE id = ?", editor, versionId),
      'CHECK constraint failed',
    );
  });

  it('el cuerpo debe ser un objeto JSON válido', () => {
    const { versionId } = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => run("UPDATE content_versions SET body = 'no json' WHERE id = ?", versionId), 'CHECK constraint failed');
    expectSqliteError(assert, () => run("UPDATE content_versions SET body = '[1,2]' WHERE id = ?", versionId), 'CHECK constraint failed');
  });

  it('la versión publicada se conserva mientras se edita otra, y puede reemplazarse en una transacción', () => {
    const { contentId, versionId: v1 } = insertContent(db, { userId: editor });
    publishVersion(db, { contentId, versionId: v1, userId: admin });

    const v2 = insertVersion(db, { contentId, userId: editor, number: 2, basedOn: v1 });
    run("UPDATE content_versions SET title = 'Edición en curso' WHERE id = ?", v2);
    assert.equal(get('SELECT published_version_id AS p FROM contents WHERE id = ?', contentId).p, v1);
    assert.equal(get('SELECT title FROM content_versions WHERE id = ?', v1).title, 'Título v1');

    // No se puede archivar la versión publicada sin retirar antes el puntero.
    expectSqliteError(assert, () => run("UPDATE content_versions SET status = 'archived' WHERE id = ?", v1), 'version_is_published');
    // Ni puede haber dos versiones publicadas a la vez.
    expectSqliteError(assert, () => publishVersion(db, { contentId, versionId: v2, userId: admin }), 'UNIQUE constraint failed');

    withTransaction(db, () => {
      run("UPDATE contents SET status = 'draft', published_version_id = NULL WHERE id = ?", contentId);
      run("UPDATE content_versions SET status = 'archived' WHERE id = ?", v1);
      publishVersion(db, { contentId, versionId: v2, userId: admin });
    });
    assert.equal(get('SELECT published_version_id AS p FROM contents WHERE id = ?', contentId).p, v2);
    assert.equal(get('SELECT status FROM content_versions WHERE id = ?', v1).status, 'archived');
  });
});

describe('esquema: revisiones de publicación', () => {
  const review = (versionId, reviewer = admin, decision = 'approved') =>
    run('INSERT INTO publication_reviews (content_version_id, reviewer_id, decision) VALUES (?, ?, ?)', versionId, reviewer, decision);

  it('solo se revisan versiones pendientes y solo las revisa el general_admin', () => {
    const { versionId } = insertContent(db, { userId: editor });
    expectSqliteError(assert, () => review(versionId), 'version_not_pending_review');
    submitVersion(db, { versionId, userId: editor });
    expectSqliteError(assert, () => review(versionId, editor), 'reviewer_must_be_general_admin');
    expectSqliteError(assert, () => review(versionId, admin, 'rejected_silently'), 'CHECK constraint failed');
    review(versionId);
  });

  it('las revisiones no se modifican ni se eliminan', () => {
    const { versionId } = insertContent(db, { userId: editor });
    submitVersion(db, { versionId, userId: editor });
    review(versionId);
    expectSqliteError(assert, () => run("UPDATE publication_reviews SET decision = 'changes_requested'"), 'review_immutable');
    expectSqliteError(assert, () => run('DELETE FROM publication_reviews'), 'review_immutable');
  });
});

describe('esquema: multimedia', () => {
  const insertMedia = (storageKey = 'a1b2c3d4e5f6a7b8c9d0.png') =>
    Number(
      run(
        "INSERT INTO media (storage_key, original_name, mime_type, extension, size_bytes, sha256, visibility, uploaded_by) VALUES (?, 'foto.png', 'image/png', 'png', 1024, ?, 'public', ?)",
        storageKey,
        'a'.repeat(64),
        editor,
      ).lastInsertRowid,
    );

  for (const key of ['../../etc/passwd', 'sub/dir/archivo.png', '.htaccessxxxxxxxxx', 'corto.png', 'MAYUSCULAS0123456.png', 'a1b2c3d4e5f6a7b8..png']) {
    it(`rechaza la clave de almacenamiento "${key}"`, () => {
      expectSqliteError(assert, () => insertMedia(key), 'CHECK constraint failed');
    });
  }

  it('un archivo referenciado no puede eliminarse físicamente', () => {
    const mediaId = insertMedia();
    const { versionId } = insertContent(db, { userId: editor });
    run('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)', versionId, mediaId);
    expectSqliteError(assert, () => run('DELETE FROM media WHERE id = ?', mediaId), 'FOREIGN KEY constraint failed');
  });

  it('las referencias multimedia de una versión no borrador son inmutables', () => {
    const m1 = insertMedia();
    const m2 = insertMedia('b1b2c3d4e5f6a7b8c9d0.jpg');
    const { versionId } = insertContent(db, { userId: editor });
    run('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)', versionId, m1);
    submitVersion(db, { versionId, userId: editor });
    expectSqliteError(assert, () => run('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)', versionId, m2), 'content_version_immutable');
    expectSqliteError(assert, () => run('DELETE FROM content_media WHERE content_version_id = ?', versionId), 'content_version_immutable');
  });

  it('descartar un borrador elimina sus referencias multimedia en cascada', () => {
    const mediaId = insertMedia();
    const { versionId } = insertContent(db, { userId: editor });
    run('INSERT INTO content_media (content_version_id, media_id) VALUES (?, ?)', versionId, mediaId);
    run('DELETE FROM content_versions WHERE id = ?', versionId);
    assert.equal(get('SELECT count(*) AS n FROM content_media').n, 0);
    run('DELETE FROM media WHERE id = ?', mediaId);
  });
});

describe('esquema: sesiones', () => {
  const insertSession = (hash) =>
    run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'))", hash, editor);

  it('solo almacena hashes de 32 bytes, únicos', () => {
    const hash = new Uint8Array(32).fill(7);
    insertSession(hash);
    expectSqliteError(assert, () => insertSession(hash), 'UNIQUE constraint failed');
    expectSqliteError(assert, () => insertSession(new Uint8Array(16)), 'CHECK constraint failed');
    expectSqliteError(assert, () => insertSession('token-en-claro-de-32-caracteres!'), 'cannot store TEXT value in BLOB column');
  });

  it('la expiración debe ser posterior a la creación', () => {
    expectSqliteError(
      assert,
      () => run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, '2000-01-01T00:00:00.000Z')", new Uint8Array(32), editor),
      'CHECK constraint failed',
    );
  });
});

describe('esquema: auditoría y configuración', () => {
  const insertAudit = (details = '{}') =>
    run("INSERT INTO audit_logs (actor_user_id, action, outcome, entity_type, entity_id, details) VALUES (?, 'user.create', 'success', 'user', 1, ?)", admin, details);

  it('la auditoría solo admite inserciones', () => {
    insertAudit('{"campo":"valor"}');
    expectSqliteError(assert, () => run("UPDATE audit_logs SET outcome = 'failure'"), 'audit_log_immutable');
    expectSqliteError(assert, () => run('DELETE FROM audit_logs'), 'audit_log_immutable');
  });

  it('los detalles de auditoría deben ser un objeto JSON', () => {
    expectSqliteError(assert, () => insertAudit('texto libre'), 'CHECK constraint failed');
    expectSqliteError(assert, () => insertAudit('"cadena"'), 'CHECK constraint failed');
  });

  it('settings exige claves válidas y valores JSON', () => {
    run("INSERT INTO settings (key, value) VALUES ('site.name', '\"CMS\"')");
    expectSqliteError(assert, () => run("INSERT INTO settings (key, value) VALUES ('site.desc', 'sin comillas')"), 'CHECK constraint failed');
    expectSqliteError(assert, () => run("INSERT INTO settings (key, value) VALUES ('Clave Mala', '1')"), 'CHECK constraint failed');
  });
});

describe('esquema 002: usuarios y permisos', () => {
  it('el nombre de usuario es inmutable, también en mayúsculas', () => {
    expectSqliteError(assert, () => run("UPDATE users SET username = 'otro' WHERE id = ?", editor), 'username_immutable');
    expectSqliteError(assert, () => run("UPDATE users SET username = 'EDITOR' WHERE id = ?", editor), 'username_immutable');
  });

  it('disabled es un estado final', () => {
    run("UPDATE users SET status = 'disabled' WHERE id = ?", editor);
    for (const status of ['active', 'suspended']) {
      expectSqliteError(assert, () => run('UPDATE users SET status = ? WHERE id = ?', status, editor), 'user_disabled_terminal');
    }
  });

  it('must_change_password es booleano y por defecto 0', () => {
    assert.equal(get('SELECT must_change_password AS m FROM users WHERE id = ?', editor).m, 0);
    expectSqliteError(assert, () => run('UPDATE users SET must_change_password = 2 WHERE id = ?', editor), 'CHECK constraint failed');
  });

  it('carga el catálogo de 9 permisos', () => {
    assert.equal(get('SELECT count(*) AS n FROM permissions').n, 9);
  });
});
