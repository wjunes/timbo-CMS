/**
 * Validación estricta de cuerpos JSON.
 *
 * `validate(body, schema)` devuelve un objeto con solo los campos del esquema,
 * ya normalizados, o lanza HttpError 400 `validation_failed` con
 * `fields: { campo: código }`. Los campos desconocidos se rechazan.
 *
 * Reglas: string, email, enumList (lista de valores únicos de un conjunto), boolean,
 * oneOf (un valor de un conjunto), integer e idList (lista de identificadores únicos).
 * Todas admiten `optional: true` y `nullable: true` (acepta `null`).
 */
import { HttpError } from '../middleware/http.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const rules = Object.freeze({
  /** @param {{ min?: number, max?: number, pattern?: RegExp, trim?: boolean, optional?: boolean, raw?: boolean }} o */
  string: (o = {}) => ({ type: 'string', ...o }),
  email: (o = {}) => ({ type: 'email', ...o }),
  /** @param {readonly string[]} allowed */
  enumList: (allowed, o = {}) => ({ type: 'enumList', allowed, ...o }),
  boolean: (o = {}) => ({ type: 'boolean', ...o }),
  /** @param {readonly string[]} allowed */
  oneOf: (allowed, o = {}) => ({ type: 'oneOf', allowed, ...o }),
  /** @param {{ min?: number, max?: number, optional?: boolean, nullable?: boolean }} o */
  integer: (o = {}) => ({ type: 'integer', ...o }),
  /** @param {{ max?: number, optional?: boolean }} o */
  idList: (o = {}) => ({ type: 'idList', ...o }),
});

const isId = (x) => Number.isSafeInteger(x) && x > 0;

function check(value, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return ['invalid_type'];
      // raw: se conserva tal cual (contraseñas); el resto se recorta y no admite caracteres de control.
      const v = rule.raw ? value : value.trim();
      if (!rule.raw && CONTROL_CHARS.test(v)) return ['invalid_characters'];
      const length = [...v].length;
      if (rule.min !== undefined && length < rule.min) return ['too_short'];
      if (rule.max !== undefined && length > rule.max) return ['too_long'];
      if (rule.pattern && !rule.pattern.test(v)) return ['invalid_format'];
      return [null, v];
    }
    case 'email': {
      if (typeof value !== 'string') return ['invalid_type'];
      const v = value.trim();
      if (v.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v)) return ['invalid_format'];
      return [null, v];
    }
    case 'enumList': {
      if (!Array.isArray(value) || value.length > rule.allowed.length) return ['invalid_type'];
      if (value.some((x) => typeof x !== 'string' || !rule.allowed.includes(x))) return ['invalid_value'];
      if (new Set(value).size !== value.length) return ['duplicated_value'];
      return [null, [...value].sort()];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [null, value] : ['invalid_type'];
    case 'oneOf':
      if (typeof value !== 'string') return ['invalid_type'];
      return rule.allowed.includes(value) ? [null, value] : ['invalid_value'];
    case 'integer': {
      if (!Number.isSafeInteger(value)) return ['invalid_type'];
      if (rule.min !== undefined && value < rule.min) return ['too_small'];
      if (rule.max !== undefined && value > rule.max) return ['too_large'];
      return [null, value];
    }
    case 'idList': {
      if (!Array.isArray(value) || value.length > (rule.max ?? 1000)) return ['invalid_type'];
      if (!value.every(isId)) return ['invalid_value'];
      if (new Set(value).size !== value.length) return ['duplicated_value'];
      return [null, [...value]];
    }
    default:
      throw new TypeError(`Regla desconocida: ${rule.type}`);
  }
}

/**
 * @param {Record<string, unknown>} body
 * @param {Record<string, ReturnType<typeof rules[keyof typeof rules]>>} schema
 * @param {{ requireAny?: boolean }} [options] requireAny: al menos un campo presente (PATCH).
 */
export function validate(body, schema, { requireAny = false } = {}) {
  // Sin prototipo: una clave "__proto__" del cliente se registra como campo desconocido
  // en lugar de intentar cambiar el prototipo (y perderse el error).
  const fields = Object.create(null);
  const out = {};
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(schema, key)) fields[key] = 'unknown_field';
  }
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.hasOwn(body, key) || body[key] === undefined) {
      if (!rule.optional) fields[key] = 'required';
      continue;
    }
    if (body[key] === null && rule.nullable) {
      out[key] = null;
      continue;
    }
    const [error, value] = check(body[key], rule);
    if (error) fields[key] = error;
    else out[key] = value;
  }
  if (requireAny && Object.keys(out).length === 0 && Object.keys(fields).length === 0) fields._ = 'empty_update';
  if (Object.keys(fields).length) {
    // fromEntries crea propiedades propias (también "__proto__") en un objeto normal.
    throw new HttpError(400, 'validation_failed', {}, { fields: Object.fromEntries(Object.entries(fields)) });
  }
  return out;
}
