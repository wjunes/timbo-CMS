import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { HttpError } from '../../backend/middleware/http.js';
import { createAuthorizer } from '../../backend/modules/permissions/authorizer.js';
import { createPermissionRepository } from '../../backend/modules/permissions/repository.js';
import { closeDatabase, insertUser, migratedMemoryDb } from '../helpers/db.js';

describe('createAuthorizer', () => {
  let db;
  let authz;
  let admin;
  let editor;
  const NEWS = 2;
  const ARTICLES = 3;

  beforeEach(() => {
    db = migratedMemoryDb();
    authz = createAuthorizer(db);
    admin = insertUser(db, { role: 'general_admin', username: 'admin' });
    editor = insertUser(db, { username: 'editor' });
    const perms = createPermissionRepository(db);
    perms.assign(editor, NEWS, admin);
    perms.grant(editor, NEWS, 'content.create', admin);
  });
  afterEach(() => closeDatabase(db));

  it('general_admin tiene todos los permisos en cualquier sección', () => {
    assert.equal(authz.can({ id: admin }, 'content.publish', NEWS), true);
    assert.equal(authz.can({ id: admin }, 'media.delete', ARTICLES), true);
  });

  it('section_admin solo tiene los permisos concedidos en sus secciones asignadas', () => {
    assert.equal(authz.can({ id: editor }, 'content.create', NEWS), true);
    assert.equal(authz.can({ id: editor }, 'content.publish', NEWS), false);
    assert.equal(authz.can({ id: editor }, 'content.create', ARTICLES), false);
  });

  it('ignora el rol que traiga el objeto: lo relee de la base de datos', () => {
    assert.equal(authz.can({ id: editor, role: 'general_admin' }, 'content.publish', NEWS), false);
  });

  it('un usuario suspendido o desactivado no tiene permisos', () => {
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(editor);
    assert.equal(authz.can({ id: editor }, 'content.create', NEWS), false);
  });

  it('usuarios inexistentes o identificadores inválidos no tienen permisos', () => {
    assert.equal(authz.can({ id: 9999 }, 'content.create', NEWS), false);
    assert.equal(authz.can({ id: '1' }, 'content.create', NEWS), false);
    assert.equal(authz.can(null, 'content.create', NEWS), false);
    assert.equal(authz.can({ id: editor }, 'content.create', '2'), false);
  });

  it('un código de permiso inexistente es un error de programación', () => {
    assert.throws(() => authz.can({ id: admin }, 'content.hack', NEWS), TypeError);
  });

  it('require lanza 403 forbidden', () => {
    assert.throws(() => authz.require({ id: editor }, 'content.publish', NEWS), (e) => e instanceof HttpError && e.status === 403 && e.code === 'forbidden');
    authz.require({ id: editor }, 'content.create', NEWS);
  });

  it('retirar la sección retira sus permisos', () => {
    createPermissionRepository(db).revoke(editor, NEWS);
    assert.equal(authz.can({ id: editor }, 'content.create', NEWS), false);
  });
});
