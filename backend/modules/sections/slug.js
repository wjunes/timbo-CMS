/**
 * Slugs de sección: generación a partir del nombre y reglas compartidas con el
 * esquema (migración 001). La base de datos vuelve a comprobarlas.
 */

export const SLUG_MAX_LENGTH = 100;

/** `[a-z0-9]` en grupos separados por un único guion; sin guiones al inicio ni al final. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Prefijos reservados para rutas del sistema en el primer nivel de URL (CHECK en `sections`). */
export const RESERVED_ROOT_SLUGS = Object.freeze(['admin', 'api', 'assets', 'media', 'static', 'health', 'login', 'logout']);

/** Letras latinas sin descomposición Unicode. */
const LATIN_EXTRA = Object.freeze({ ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th' });

/**
 * Convierte un nombre en slug: quita tildes y diacríticos, pasa a minúsculas y
 * sustituye cualquier otro carácter por guiones. Devuelve '' si no queda nada.
 * @param {string} name
 */
export function slugify(name) {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđłþ]/g, (c) => LATIN_EXTRA[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/** @param {string} slug @param {boolean} isRoot */
export const isReservedSlug = (slug, isRoot) => isRoot && RESERVED_ROOT_SLUGS.includes(slug);
