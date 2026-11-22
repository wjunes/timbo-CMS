import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BODY_LIMITS, checkHref, validateBody } from '../../backend/modules/contents/body.js';

const doc = (...content) => ({ type: 'doc', content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const link = (href, extra = {}) => ({ type: 'link', attrs: { href, ...extra } });

function rejects(value, code, path) {
  const r = validateBody(value);
  assert.equal(r.ok, false, `se esperaba rechazo (${code})`);
  assert.equal(r.code, code);
  if (path !== undefined) assert.equal(r.path, path);
}
const accepts = (value) => {
  const r = validateBody(value);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

describe('cuerpo Tiptap: documentos válidos', () => {
  it('acepta un documento vacío y devuelve su serialización', () => {
    assert.equal(accepts(doc()).json, '{"type":"doc","content":[]}');
  });

  it('acepta la salida habitual de Tiptap (atributos por defecto incluidos)', () => {
    accepts(doc(
      { type: 'heading', attrs: { level: 2, textAlign: null }, content: [t('Título')] },
      { type: 'paragraph', attrs: { textAlign: 'justify' }, content: [
        t('negrita', [{ type: 'bold' }]),
        { type: 'hardBreak' },
        t('enlace', [{ type: 'italic' }, link('https://example.org/a?b=1#c', { target: '_blank', rel: 'noopener noreferrer nofollow', class: null })]),
      ] },
      { type: 'paragraph' },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('uno')), { type: 'orderedList', attrs: { start: 3, type: null }, content: [{ type: 'listItem', content: [p(t('dos'))] }] }] }] },
      { type: 'blockquote', content: [p(t('cita', [{ type: 'underline' }]))] },
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(t('A'))] },
        { type: 'tableCell', attrs: { colspan: 2, rowspan: 1, colwidth: [120, 80] }, content: [p()] },
      ] }] },
    ));
  });

  it('acepta enlaces internos, anclas y mailto', () => {
    for (const href of ['/noticias/una', '/', '#seccion-2', 'mailto:a@example.org', 'http://example.org']) {
      assert.equal(checkHref(href), null, href);
    }
  });
});

describe('cuerpo Tiptap: estructura', () => {
  it('exige un objeto doc en la raíz', () => {
    rejects(null, 'invalid_node', '');
    rejects([], 'invalid_node', '');
    rejects('<p>hola</p>', 'invalid_node', '');
    rejects({ type: 'paragraph' }, 'node_not_allowed_here', '/type');
    rejects({ content: [] }, 'invalid_node', '/type');
  });

  it('rechaza nodos desconocidos (también los de Tiptap no admitidos) indicando la ruta', () => {
    rejects(doc(p(t('a')), { type: 'iframe', attrs: { src: 'https://x' } }), 'unknown_node', '/content/1/type');
    rejects(doc({ type: 'image', attrs: { src: 'https://x/y.png' } }), 'unknown_node', '/content/0/type');
    rejects(doc({ type: 'codeBlock', content: [t('x')] }), 'unknown_node');
    rejects(doc({ type: 'html', content: [] }), 'unknown_node');
  });

  it('rechaza nodos fuera de su lugar', () => {
    rejects(doc(t('suelto')), 'node_not_allowed_here', '/content/0/type');
    rejects(doc({ type: 'listItem', content: [p()] }), 'node_not_allowed_here');
    rejects(doc(p({ type: 'paragraph' })), 'node_not_allowed_here', '/content/0/content/0/type');
    rejects(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }] }), 'node_not_allowed_here');
    rejects(doc(p(), { type: 'doc', content: [] }), 'node_not_allowed_here');
  });

  it('exige contenido mínimo en listas, tablas, filas y celdas', () => {
    rejects(doc({ type: 'bulletList', content: [] }), 'empty_content', '/content/0/content');
    rejects(doc({ type: 'table' }), 'empty_content');
    rejects(doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [] }] }] }), 'empty_content');
  });

  it('rechaza propiedades desconocidas en nodos, textos y marcas', () => {
    rejects(doc({ type: 'paragraph', html: '<script>' }), 'unknown_property', '/content/0/html');
    rejects(doc(p({ type: 'text', text: 'a', style: 'x' })), 'unknown_property', '/content/0/content/0/style');
    rejects(doc(p(t('a', [{ type: 'bold', extra: 1 }]))), 'unknown_property');
    rejects(doc({ type: 'hardBreak', content: [] }), 'node_not_allowed_here');
    rejects(doc(p({ type: 'hardBreak', content: [] })), 'unknown_property');
  });

  it('una clave __proto__ o constructor es una propiedad desconocida (sin contaminar prototipos)', () => {
    rejects(JSON.parse('{"type":"doc","content":[],"__proto__":{"polluted":1}}'), 'unknown_property', '/__proto__');
    rejects(JSON.parse('{"type":"doc","content":[{"type":"paragraph","attrs":{"__proto__":{"x":1}}}]}'), 'unknown_attribute');
    rejects(doc({ type: 'constructor' }), 'unknown_node');
    rejects(doc(p(t('a', [{ type: 'toString' }]))), 'unknown_mark');
    assert.equal({}.polluted, undefined);
  });

  it('el contenido debe ser una lista y el texto una cadena no vacía', () => {
    rejects(doc({ type: 'paragraph', content: 'texto' }), 'invalid_content');
    rejects({ type: 'doc', content: {} }, 'invalid_content');
    rejects(doc(p({ type: 'text', text: '' })), 'invalid_text');
    rejects(doc(p({ type: 'text', text: 42 })), 'invalid_text');
  });

  it('rechaza caracteres de control y texto mal formado', () => {
    rejects(doc(p(t('a\u0000b'))), 'invalid_characters');
    rejects(doc(p(t('a\u001bb'))), 'invalid_characters');
    rejects(doc(p(t('\ud800'))), 'invalid_characters');
    accepts(doc(p(t('tab\tsalto\n'))));
  });
});

describe('cuerpo Tiptap: atributos y marcas', () => {
  it('solo atributos de la lista y con valores permitidos', () => {
    rejects(doc({ type: 'paragraph', attrs: { style: 'color:red' } }), 'unknown_attribute', '/content/0/attrs/style');
    rejects(doc({ type: 'paragraph', attrs: { textAlign: 'start' } }), 'invalid_attribute_value');
    rejects(doc({ type: 'paragraph', attrs: { onclick: 'x()' } }), 'unknown_attribute');
    rejects(doc({ type: 'paragraph', attrs: 'x' }), 'invalid_attributes');
    rejects(doc({ type: 'heading', attrs: { level: 1 }, content: [] }), 'invalid_attribute_value');
    rejects(doc({ type: 'heading', attrs: { level: '2' } }), 'invalid_attribute_value');
    rejects(doc({ type: 'heading', content: [t('sin nivel')] }), 'missing_attribute', '/content/0/attrs/level');
    rejects(doc({ type: 'heading', attrs: {} }), 'missing_attribute');
    rejects(doc({ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [p()] }] }), 'invalid_attribute_value');
    rejects(doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 99 }, content: [p()] }] }] }), 'invalid_attribute_value');
  });

  it('rechaza marcas desconocidas, repetidas o mal formadas', () => {
    rejects(doc(p(t('a', [{ type: 'textStyle', attrs: { color: 'red' } }]))), 'unknown_mark');
    rejects(doc(p(t('a', [{ type: 'bold' }, { type: 'bold' }]))), 'duplicated_mark');
    rejects(doc(p(t('a', 'bold'))), 'invalid_marks');
    rejects(doc(p(t('a', [null]))), 'invalid_mark');
    rejects(doc(p(t('a', [{ type: 'bold', attrs: { x: 1 } }]))), 'unknown_attribute');
  });

  it('los enlaces exigen href y solo admiten target, rel y class acotados', () => {
    rejects(doc(p(t('a', [{ type: 'link' }]))), 'missing_attribute');
    rejects(doc(p(t('a', [{ type: 'link', attrs: { target: '_blank' } }]))), 'missing_attribute');
    rejects(doc(p(t('a', [link('/x', { target: '_top' })]))), 'invalid_attribute_value');
    rejects(doc(p(t('a', [link('/x', { rel: 'opener' })]))), 'invalid_attribute_value');
    rejects(doc(p(t('a', [link('/x', { class: 'boton' })]))), 'invalid_attribute_value');
    rejects(doc(p(t('a', [link('/x', { onmouseover: 'x' })]))), 'unknown_attribute');
  });

  it('bloquea esquemas peligrosos y destinos ambiguos', () => {
    const blocked = [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'jav\tascript:alert(1)', ' javascript:alert(1)', 'javascript&colon;alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.org',
      '//evil.example/x', '/\\evil.example', 'relativa/sin/barra', 'https://user:pass@example.org', 'https://', 'http://exa mple.org',
      'mailto:', '"><script>', `https://e.org/${'a'.repeat(BODY_LIMITS.maxHrefLength)}`,
    ];
    for (const href of blocked) {
      assert.notEqual(checkHref(href), null, `debería rechazarse: ${href}`);
      assert.equal(validateBody(doc(p(t('a', [link(href)])))).ok, false, href);
    }
    rejects(doc(p(t('a', [link('javascript:alert(1)')]))), 'link_href_not_allowed', '/content/0/content/0/marks/0/attrs/href');
  });
});

describe('cuerpo Tiptap: límites', () => {
  it('limita la profundidad', () => {
    let item = { type: 'listItem', content: [p(t('fondo'))] };
    for (let i = 0; i < 10; i++) item = { type: 'listItem', content: [p(), { type: 'bulletList', content: [item] }] };
    rejects(doc({ type: 'bulletList', content: [item] }), 'too_deep');
  });

  it('limita el número de nodos', () => {
    const many = Array.from({ length: BODY_LIMITS.maxNodes }, () => p());
    rejects(doc(...many), 'too_many_nodes');
  });

  it('limita la longitud de cada texto y del total', () => {
    rejects(doc(p(t('x'.repeat(BODY_LIMITS.maxTextLength + 1)))), 'text_too_long');
    const chunk = 'y'.repeat(BODY_LIMITS.maxTextLength);
    const count = Math.ceil(BODY_LIMITS.maxTotalText / BODY_LIMITS.maxTextLength) + 1;
    rejects(doc(...Array.from({ length: count }, () => p(t(chunk)))), 'text_too_long');
  });

  it('limita el tamaño serializado en bytes (UTF-8)', () => {
    // 1 000 000 caracteres de 3 bytes: dentro del límite de texto, pero ~3 MB serializado.
    const chunk = '€'.repeat(BODY_LIMITS.maxTextLength);
    const count = BODY_LIMITS.maxTotalText / BODY_LIMITS.maxTextLength;
    rejects(doc(...Array.from({ length: count }, () => p(t(chunk)))), 'too_large', '');
  });
});
