import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../backend/middleware/http.js';
import { RESERVED_ROOT_SLUGS, SLUG_PATTERN, isReservedSlug, slugify } from '../../backend/modules/sections/slug.js';
import { rules, validate } from '../../backend/utils/validation.js';
import { closeDatabase, migratedMemoryDb } from '../helpers/db.js';

const fieldsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError);
    return err.details.fields;
  }
  assert.fail('se esperaba validation_failed');
};

describe('slugify', () => {
  const cases = [
    ['Preguntas frecuentes', 'preguntas-frecuentes'],
    ['Año Académico 2026', 'ano-academico-2026'],
    ['  --Hola,   mundo!--  ', 'hola-mundo'],
    ['Ça va über straße', 'ca-va-uber-strasse'],
    ['ＡＢＣ１２３', 'abc123'],
    ['¿¡!?', ''],
    ['<script>alert(1)</script>', 'script-alert-1-script'],
    ['../../etc/passwd', 'etc-passwd'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => assert.equal(slugify(input), expected));
  }

  it('el resultado siempre cumple el patrón o es vacío, y no termina en guion al truncar', () => {
    const long = `${'a'.repeat(99)} bcd`;
    const s = slugify(long);
    assert.ok(s.length <= 100);
    assert.match(s, SLUG_PATTERN);
    for (const sample of ['Árbol', 'x y z', '1-2-3', 'Ñandú']) assert.match(slugify(sample), SLUG_PATTERN);
  });

  it('los prefijos reservados coinciden con el CHECK de la base y solo aplican en la raíz', () => {
    const db = migratedMemoryDb();
    try {
      for (const slug of RESERVED_ROOT_SLUGS) {
        assert.equal(isReservedSlug(slug, true), true);
        assert.equal(isReservedSlug(slug, false), false);
        assert.throws(() => db.prepare("INSERT INTO sections (section_type_id, slug, name, presentation) VALUES (1, ?, 'X', 'page')").run(slug), /CHECK/);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

describe('validación: reglas oneOf, integer, idList y nullable', () => {
  it('oneOf acepta solo valores del conjunto', () => {
    assert.deepEqual(validate({ w: 'direct' }, { w: rules.oneOf(['direct', 'approval']) }), { w: 'direct' });
    assert.deepEqual(fieldsOf(() => validate({ w: 'auto' }, { w: rules.oneOf(['direct']) })), { w: 'invalid_value' });
    assert.deepEqual(fieldsOf(() => validate({ w: ['direct'] }, { w: rules.oneOf(['direct']) })), { w: 'invalid_type' });
  });

  it('integer exige enteros seguros dentro del rango', () => {
    const schema = { n: rules.integer({ min: 1, max: 10 }) };
    assert.deepEqual(validate({ n: 3 }, schema), { n: 3 });
    for (const [v, code] of [['3', 'invalid_type'], [1.5, 'invalid_type'], [2 ** 60, 'invalid_type'], [0, 'too_small'], [11, 'too_large']]) {
      assert.deepEqual(fieldsOf(() => validate({ n: v }, schema)), { n: code });
    }
  });

  it('nullable acepta null, pero un campo requerido sigue siendo obligatorio', () => {
    const schema = { p: rules.integer({ min: 1, nullable: true }) };
    assert.deepEqual(validate({ p: null }, schema), { p: null });
    assert.deepEqual(fieldsOf(() => validate({}, schema)), { p: 'required' });
    assert.deepEqual(fieldsOf(() => validate({ p: null }, { p: rules.integer() })), { p: 'invalid_type' });
  });

  it('idList conserva el orden y rechaza duplicados, no enteros y listas largas', () => {
    assert.deepEqual(validate({ ids: [3, 1, 2] }, { ids: rules.idList() }), { ids: [3, 1, 2] });
    assert.deepEqual(fieldsOf(() => validate({ ids: [1, 1] }, { ids: rules.idList() })), { ids: 'duplicated_value' });
    assert.deepEqual(fieldsOf(() => validate({ ids: [1, '2'] }, { ids: rules.idList() })), { ids: 'invalid_value' });
    assert.deepEqual(fieldsOf(() => validate({ ids: [0] }, { ids: rules.idList() })), { ids: 'invalid_value' });
    assert.deepEqual(fieldsOf(() => validate({ ids: [1, 2, 3] }, { ids: rules.idList({ max: 2 }) })), { ids: 'invalid_type' });
  });
});

describe('validación: claves especiales', () => {
  it('"__proto__" en el cuerpo se rechaza como campo desconocido', () => {
    const body = JSON.parse('{"a":"x","__proto__":{"admin":true}}');
    const fields = fieldsOf(() => validate(body, { a: rules.string() }));
    assert.deepEqual(Object.entries(fields), [['__proto__', 'unknown_field']]);
    assert.equal({}.admin, undefined);
  });
});
