import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateBody } from '../../backend/modules/contents/body.js';
import { escapeHtml, renderBody } from '../../backend/modules/contents/render.js';

const opts = { mediaSrc: (id) => `/src/${id}`, mediaHref: (id) => `/href/${id}`, media: new Map([[7, { width: 640, height: 480 }]]) };
const doc = (...content) => ({ type: 'doc', content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const render = (d) => {
  assert.equal(validateBody(d).ok, true, 'el documento de la prueba debe ser válido');
  return renderBody(d, opts);
};

describe('renderizado seguro del cuerpo', () => {
  it('escapa todo el texto', () => {
    assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const html = render(doc(p(t('<script>alert(1)</script> & "x"'))));
    assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
  });

  it('marcas anidadas con el enlace por fuera y rel seguro con _blank', () => {
    const html = render(doc(p(t('x', [{ type: 'bold' }, { type: 'link', attrs: { href: "https://e.org/?a=1&b='2'", target: '_blank' } }, { type: 'italic' }]))));
    assert.equal(html, '<p><a href="https://e.org/?a=1&amp;b=&#39;2&#39;" target="_blank" rel="noopener noreferrer"><strong><em>x</em></strong></a></p>');
  });

  it('alineación como clase, nunca como style', () => {
    const html = render(doc({ type: 'heading', attrs: { level: 3, textAlign: 'center' }, content: [t('T')] }, { type: 'paragraph', attrs: { textAlign: 'left' }, content: [t('a')] }));
    assert.equal(html, '<h3 class="align-center">T</h3><p>a</p>');
    assert.doesNotMatch(html, /style=/);
  });

  it('listas, cita, tabla y salto de línea', () => {
    const cell = (tag, text) => ({ type: tag, attrs: { colspan: 2, rowspan: 1, colwidth: [100, 50] }, content: [p(t(text))] });
    const html = render(doc(
      { type: 'orderedList', attrs: { start: 3, type: 'a' }, content: [{ type: 'listItem', content: [p(t('uno'))] }] },
      { type: 'blockquote', content: [p(t('c'), { type: 'hardBreak' }, t('d'))] },
      { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'h')] }, { type: 'tableRow', content: [cell('tableCell', 'v')] }] },
    ));
    assert.equal(html, '<ol start="3" type="a"><li><p>uno</p></li></ol><blockquote><p>c<br>d</p></blockquote>'
      + '<div class="table-wrap"><table><tbody><tr><th colspan="2"><p>h</p></th></tr><tr><td colspan="2"><p>v</p></td></tr></tbody></table></div>');
  });

  it('imágenes y enlaces de la biblioteca se resuelven con las funciones del llamante', () => {
    const html = render(doc({ type: 'image', attrs: { mediaId: 7, alt: 'Foto "x" <y>' } }, p(t('pdf', [{ type: 'link', attrs: { href: '/media/9' } }]))));
    assert.equal(html, '<img src="/src/7" alt="Foto &quot;x&quot; &lt;y&gt;" width="640" height="480" loading="lazy" decoding="async"><p><a href="/href/9">pdf</a></p>');
  });

  it('no copia nada desconocido aunque llegue un documento sin validar', () => {
    assert.throws(() => renderBody(doc({ type: 'iframe' }), opts), /Nodo no admitido/);
    assert.throws(() => renderBody(doc(p(t('x', [{ type: 'script' }]))), opts), /Marca no admitida/);
    assert.throws(() => renderBody({ type: 'paragraph' }, opts), /Documento inválido/);
  });
});
