import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../backend/middleware/http.js';
import { createRouter } from '../../backend/middleware/router.js';
import { rules, validate } from '../../backend/utils/validation.js';

describe('createRouter', () => {
  const router = createRouter();
  router.add({ method: 'GET', path: '/api/users', handler: 'list' });
  router.add({ method: 'GET', path: '/api/users/:id', handler: 'get' });
  router.add({ method: 'PATCH', path: '/api/users/:id', handler: 'patch' });
  router.add({ method: 'PUT', path: '/api/users/:id/sections/:sectionId', handler: 'assign' });

  it('resuelve rutas exactas y con parámetros numéricos', () => {
    assert.equal(router.match('/api/users').methods.get('GET').handler, 'list');
    const m = router.match('/api/users/42');
    assert.deepEqual(m.params, { id: 42 });
    assert.deepEqual([...m.methods.keys()], ['GET', 'PATCH']);
    assert.deepEqual(router.match('/api/users/7/sections/3').params, { id: 7, sectionId: 3 });
  });

  it('no coincide con parámetros no numéricos, cero, negativos o demasiado largos', () => {
    for (const p of ['/api/users/abc', '/api/users/0', '/api/users/-1', '/api/users/1.5', '/api/users/01', `/api/users/${'9'.repeat(17)}`, '/api/users/1/', '/api/users/1/x']) {
      assert.equal(router.match(p), null, p);
    }
  });

  it('rechaza rutas duplicadas', () => {
    assert.throws(() => router.add({ method: 'GET', path: '/api/users/:id', handler: 'x' }), /duplicada/);
  });
});

describe('validate', () => {
  const schema = {
    name: rules.string({ min: 1, max: 5 }),
    email: rules.email({ optional: true }),
    perms: rules.enumList(['a', 'b', 'c'], { optional: true }),
    secret: rules.string({ min: 1, max: 20, raw: true, optional: true }),
  };
  const fieldsOf = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'validation_failed');
      return err.details.fields;
    }
    assert.fail('no lanzó');
  };

  it('devuelve solo los campos del esquema, normalizados', () => {
    assert.deepEqual(validate({ name: '  Ana ', perms: ['c', 'a'] }, schema), { name: 'Ana', perms: ['a', 'c'] });
    assert.deepEqual(validate({ name: 'x', secret: '  con espacios ' }, schema), { name: 'x', secret: '  con espacios ' });
  });

  it('rechaza campos desconocidos (asignación masiva) y obligatorios ausentes', () => {
    assert.deepEqual(fieldsOf(() => validate({ name: 'a', role: 'general_admin' }, schema)), { role: 'unknown_field' });
    assert.deepEqual(fieldsOf(() => validate({}, schema)), { name: 'required' });
  });

  it('valida tipos, longitudes, caracteres de control, emails y listas', () => {
    assert.deepEqual(
      fieldsOf(() => validate({ name: 'demasiado largo', email: 'no-email', perms: ['a', 'z'] }, schema)),
      { name: 'too_long', email: 'invalid_format', perms: 'invalid_value' },
    );
    assert.deepEqual(fieldsOf(() => validate({ name: 42 }, schema)), { name: 'invalid_type' });
    assert.deepEqual(fieldsOf(() => validate({ name: 'a\u0007' }, schema)), { name: 'invalid_characters' });
    assert.deepEqual(fieldsOf(() => validate({ name: 'a', perms: ['a', 'a'] }, schema)), { perms: 'duplicated_value' });
    assert.deepEqual(fieldsOf(() => validate({ name: 'a', email: 'x@<script>.org' }, schema)), { email: 'invalid_format' });
  });

  it('requireAny exige al menos un campo', () => {
    assert.deepEqual(fieldsOf(() => validate({}, { a: rules.string({ optional: true }) }, { requireAny: true })), { _: 'empty_update' });
  });
});
