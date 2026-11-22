/**
 * Validación del cuerpo de una versión (Tiptap JSON, `body_format = 'tiptap_json'`).
 *
 * Lista blanca estricta (D-033): solo se aceptan los nodos, marcas y atributos
 * enumerados aquí, con valores acotados. Lo que no encaja se RECHAZA (no se
 * corrige ni se descarta en silencio) indicando dónde está el problema, para que
 * el contenido guardado sea exactamente el que el autor envió.
 *
 * - Sin HTML: el documento es una estructura de datos; el renderizado (Bloque 09)
 *   escapará todo el texto y generará el HTML a partir de esta misma lista.
 * - Enlaces: solo http(s), mailto, rutas absolutas del propio sitio y anclas.
 * - Límites de profundidad, número de nodos, longitud de textos y tamaño total.
 * - Las búsquedas usan Map/Set y `Object.hasOwn`, nunca el prototipo: claves
 *   como `__proto__` o `constructor` son simplemente desconocidas.
 * - Las imágenes se incorporan con la multimedia (Bloque 08).
 */

export const BODY_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024, // igual que el CHECK de content_versions.body
  maxDepth: 16,
  maxNodes: 20_000,
  maxTextLength: 20_000, // por nodo de texto
  maxTotalText: 1_000_000,
  maxHrefLength: 2048,
});

export const EMPTY_BODY = Object.freeze({ type: 'doc', content: Object.freeze([]) });

const TEXT_ALIGN = [null, 'left', 'center', 'right', 'justify'];
const ORDERED_LIST_TYPES = [null, '1', 'a', 'A', 'i', 'I'];
const LINK_REL_TOKENS = new Set(['noopener', 'noreferrer', 'nofollow']);

// --- Validadores de atributos: devuelven null si es válido o un código de error.
const oneOf = (allowed) => (v) => (allowed.includes(v) ? null : 'invalid_attribute_value');
const int = (min, max, { nullable = false } = {}) => (v) =>
  (nullable && v === null) || (Number.isSafeInteger(v) && v >= min && v <= max) ? null : 'invalid_attribute_value';
const colwidth = (v) =>
  v === null || (Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((w) => Number.isSafeInteger(w) && w >= 1 && w <= 5000))
    ? null
    : 'invalid_attribute_value';
const onlyNull = (v) => (v === null ? null : 'invalid_attribute_value');
const linkTarget = oneOf([null, '_blank']);
function linkRel(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 100) return 'invalid_attribute_value';
  const tokens = v.split(' ');
  return tokens.every((t) => LINK_REL_TOKENS.has(t)) ? null : 'invalid_attribute_value';
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/; // se admiten \t y \n
const URL_FORBIDDEN = /[\u0000- \u007f\\<>"`]/; // espacios, controles, barra invertida, comillas

/** @returns {string|null} código de error o null si el destino es aceptable. */
export function checkHref(href) {
  if (typeof href !== 'string') return 'invalid_attribute_value';
  if (href.length === 0 || href.length > BODY_LIMITS.maxHrefLength || !href.isWellFormed()) return 'link_href_invalid';
  if (URL_FORBIDDEN.test(href)) return 'link_href_invalid';
  // Rutas del propio sitio ("/a/b", sin "//" que sería otro dominio) y anclas.
  if (href.startsWith('/')) return href.startsWith('//') ? 'link_href_not_allowed' : null;
  if (href.startsWith('#')) return /^#[A-Za-z0-9_-]{1,200}$/.test(href) ? null : 'link_href_invalid';
  let url;
  try {
    url = new URL(href);
  } catch {
    return 'link_href_not_allowed'; // relativas sin "/" u otros esquemas no reconocibles
  }
  if (url.protocol === 'mailto:') return /^mailto:[^@\s]+@[^@\s]+$/i.test(href.split('?')[0]) ? null : 'link_href_invalid';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'link_href_not_allowed';
  if (!url.hostname || url.username || url.password) return 'link_href_not_allowed';
  return null;
}

/**
 * Esquema de nodos. `content` es la lista de tipos de hijo admitidos;
 * `minContent` exige un mínimo de hijos; `first` restringe el tipo del primer hijo.
 */
const INLINE = ['text', 'hardBreak'];
const LIST = ['bulletList', 'orderedList'];
const CELL_BLOCKS = ['paragraph', ...LIST];

const NODES = new Map(Object.entries({
  doc: { content: ['paragraph', 'heading', ...LIST, 'blockquote', 'table'], attrs: {} },
  paragraph: { content: INLINE, attrs: { textAlign: oneOf(TEXT_ALIGN) } },
  heading: { content: INLINE, attrs: { level: oneOf([2, 3, 4]), textAlign: oneOf(TEXT_ALIGN) }, requiredAttrs: ['level'] },
  bulletList: { content: ['listItem'], minContent: 1, attrs: {} },
  orderedList: { content: ['listItem'], minContent: 1, attrs: { start: int(1, 100_000), type: oneOf(ORDERED_LIST_TYPES) } },
  listItem: { content: ['paragraph', ...LIST], minContent: 1, first: 'paragraph', attrs: {} },
  blockquote: { content: ['paragraph', 'heading', ...LIST], minContent: 1, attrs: {} },
  table: { content: ['tableRow'], minContent: 1, attrs: {} },
  tableRow: { content: ['tableHeader', 'tableCell'], minContent: 1, attrs: {} },
  tableHeader: { content: CELL_BLOCKS, minContent: 1, attrs: { colspan: int(1, 20), rowspan: int(1, 100), colwidth } },
  tableCell: { content: CELL_BLOCKS, minContent: 1, attrs: { colspan: int(1, 20), rowspan: int(1, 100), colwidth } },
  hardBreak: { leaf: true, attrs: {} },
}));

const MARKS = new Map(Object.entries({
  bold: { attrs: {} },
  italic: { attrs: {} },
  underline: { attrs: {} },
  link: { attrs: { href: checkHref, target: linkTarget, rel: linkRel, class: onlyNull }, requiredAttrs: ['href'] },
}));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BodyError extends Error {
  constructor(code, path) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

/** Ruta legible tipo JSON Pointer (RFC 6901) del elemento con error. */
const pointer = (parts) => (parts.length ? `/${parts.join('/')}` : '');

function checkAttrs(value, spec, path) {
  if (value === undefined) {
    if (spec.requiredAttrs?.length) throw new BodyError('missing_attribute', pointer([...path, 'attrs', spec.requiredAttrs[0]]));
    return;
  }
  if (!isPlainObject(value)) throw new BodyError('invalid_attributes', pointer([...path, 'attrs']));
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(spec.attrs, key)) throw new BodyError('unknown_attribute', pointer([...path, 'attrs', key]));
    const error = spec.attrs[key](value[key]);
    if (error) throw new BodyError(error, pointer([...path, 'attrs', key]));
  }
  for (const key of spec.requiredAttrs ?? []) {
    if (!Object.hasOwn(value, key)) throw new BodyError('missing_attribute', pointer([...path, 'attrs', key]));
  }
}

function checkKeys(node, allowed, path) {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) throw new BodyError('unknown_property', pointer([...path, key]));
  }
}

const TEXT_KEYS = new Set(['type', 'text', 'marks']);
const NODE_KEYS = new Set(['type', 'attrs', 'content']);
const MARK_KEYS = new Set(['type', 'attrs']);

/**
 * Valida un documento ya parseado (objeto). Lanza BodyError con `code` y `path`.
 * @returns {{ nodes: number, textLength: number }}
 */
function validateDocument(doc) {
  const stats = { nodes: 0, textLength: 0 };

  function visit(node, allowedTypes, path, depth) {
    if (depth > BODY_LIMITS.maxDepth) throw new BodyError('too_deep', pointer(path));
    if (++stats.nodes > BODY_LIMITS.maxNodes) throw new BodyError('too_many_nodes', pointer(path));
    if (!isPlainObject(node)) throw new BodyError('invalid_node', pointer(path));
    const { type } = node;
    if (typeof type !== 'string') throw new BodyError('invalid_node', pointer([...path, 'type']));
    if (!allowedTypes.includes(type)) {
      throw new BodyError(NODES.has(type) || type === 'text' ? 'node_not_allowed_here' : 'unknown_node', pointer([...path, 'type']));
    }

    if (type === 'text') {
      checkKeys(node, TEXT_KEYS, path);
      const { text } = node;
      if (typeof text !== 'string' || text.length === 0) throw new BodyError('invalid_text', pointer([...path, 'text']));
      if (text.length > BODY_LIMITS.maxTextLength) throw new BodyError('text_too_long', pointer([...path, 'text']));
      if (!text.isWellFormed() || CONTROL_CHARS.test(text)) throw new BodyError('invalid_characters', pointer([...path, 'text']));
      stats.textLength += text.length;
      if (stats.textLength > BODY_LIMITS.maxTotalText) throw new BodyError('text_too_long', pointer([...path, 'text']));
      if (node.marks !== undefined) checkMarks(node.marks, [...path, 'marks']);
      return;
    }

    const spec = NODES.get(type);
    checkKeys(node, NODE_KEYS, path);
    checkAttrs(node.attrs, spec, path);

    if (spec.leaf) {
      if (node.content !== undefined) throw new BodyError('unknown_property', pointer([...path, 'content']));
      return;
    }
    const content = node.content ?? [];
    if (!Array.isArray(content)) throw new BodyError('invalid_content', pointer([...path, 'content']));
    if (content.length < (spec.minContent ?? 0)) throw new BodyError('empty_content', pointer([...path, 'content']));
    content.forEach((child, i) => {
      const childPath = [...path, 'content', i];
      if (i === 0 && spec.first && isPlainObject(child) && child.type !== spec.first) {
        throw new BodyError('node_not_allowed_here', pointer([...childPath, 'type']));
      }
      visit(child, spec.content, childPath, depth + 1);
    });
  }

  function checkMarks(marks, path) {
    if (!Array.isArray(marks) || marks.length > MARKS.size) throw new BodyError('invalid_marks', pointer(path));
    const seen = new Set();
    marks.forEach((mark, i) => {
      const markPath = [...path, i];
      if (!isPlainObject(mark) || typeof mark.type !== 'string') throw new BodyError('invalid_mark', pointer(markPath));
      const spec = MARKS.get(mark.type);
      if (!spec) throw new BodyError('unknown_mark', pointer([...markPath, 'type']));
      if (seen.has(mark.type)) throw new BodyError('duplicated_mark', pointer([...markPath, 'type']));
      seen.add(mark.type);
      checkKeys(mark, MARK_KEYS, markPath);
      checkAttrs(mark.attrs, spec, markPath);
    });
  }

  visit(doc, ['doc'], [], 0);
  return stats;
}

/**
 * Valida el cuerpo recibido por la API y devuelve su serialización para guardarla.
 * @returns {{ ok: true, json: string } | { ok: false, code: string, path: string }}
 */
export function validateBody(value) {
  try {
    validateDocument(value);
  } catch (err) {
    if (err instanceof BodyError) return { ok: false, code: err.code, path: err.path };
    throw err;
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > BODY_LIMITS.maxBytes) return { ok: false, code: 'too_large', path: '' };
  return { ok: true, json };
}
