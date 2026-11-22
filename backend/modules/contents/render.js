/**
 * Renderizado del cuerpo (Tiptap JSON) a HTML seguro.
 *
 * Lo usa la vista previa del panel (Bloque 08) y lo reutilizará el sitio
 * público (Bloque 09). Solo recibe documentos que ya pasaron `validateBody`
 * (lista blanca, D-033) y, aun así, no confía en ellos:
 * - genera el HTML a partir de una tabla cerrada de nodos y marcas; un tipo
 *   desconocido es un error, no se copia;
 * - todo texto y todo valor de atributo se escapa (codificación contextual);
 * - nunca emite atributos `style` ni manejadores: la alineación es una clase
 *   fija (`align-center`…), compatible con una CSP sin estilos en línea;
 * - las imágenes y los enlaces a la biblioteca se resuelven con funciones del
 *   llamante (`mediaSrc`, `mediaHref`), porque el panel y el sitio público los
 *   sirven por rutas distintas.
 */
import { MEDIA_HREF } from './body.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const ALIGN_CLASSES = new Map([['center', 'align-center'], ['right', 'align-right'], ['justify', 'align-justify']]);
const ORDERED_TYPES = new Set(['1', 'a', 'A', 'i', 'I']);
const MARK_ORDER = ['link', 'bold', 'italic', 'underline']; // el enlace envuelve al resto

function attrs(list) {
  return list
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
    .join('');
}

const alignClass = (node) => ALIGN_CLASSES.get(node.attrs?.textAlign) ?? null;

/**
 * @param {object} doc documento validado
 * @param {{ mediaSrc: (id: number) => string, mediaHref: (id: number) => string,
 *           media?: Map<number, { width: number|null, height: number|null, alt?: string }> }} options
 *   Una imagen sin `alt` en el documento usa el texto alternativo de la biblioteca, si lo hay.
 * @returns {string}
 */
export function renderBody(doc, { mediaSrc, mediaHref, media = new Map() }) {
  if (doc?.type !== 'doc') throw new TypeError('Documento inválido');

  function linkHref(href) {
    const match = MEDIA_HREF.exec(href);
    return match ? mediaHref(Number(match[1])) : href;
  }

  function openMark(mark) {
    switch (mark.type) {
      case 'bold': return '<strong>';
      case 'italic': return '<em>';
      case 'underline': return '<u>';
      case 'link': {
        const blank = mark.attrs?.target === '_blank';
        // Con target=_blank siempre noopener; el resto de rel viene de la lista blanca.
        const rel = new Set((mark.attrs?.rel ?? '').split(' ').filter(Boolean));
        if (blank) ['noopener', 'noreferrer'].forEach((t) => rel.add(t));
        return `<a${attrs([['href', linkHref(mark.attrs.href)], ['target', blank ? '_blank' : null], ['rel', rel.size ? [...rel].join(' ') : null]])}>`;
      }
      default: throw new TypeError(`Marca no admitida: ${mark.type}`);
    }
  }
  const closeMark = (mark) => ({ bold: '</strong>', italic: '</em>', underline: '</u>', link: '</a>' })[mark.type];

  function text(node) {
    const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    const open = marks.map(openMark).join('');
    const close = marks.reverse().map(closeMark).join('');
    return `${open}${escapeHtml(node.text).replace(/\n/g, '<br>')}${close}`;
  }

  const children = (node) => (node.content ?? []).map(render).join('');

  function cell(tag, node) {
    const { colspan = 1, rowspan = 1 } = node.attrs ?? {};
    return `<${tag}${attrs([['colspan', colspan > 1 ? colspan : null], ['rowspan', rowspan > 1 ? rowspan : null]])}>${children(node)}</${tag}>`;
  }

  function render(node) {
    switch (node.type) {
      case 'text': return text(node);
      case 'hardBreak': return '<br>';
      case 'paragraph': return `<p${attrs([['class', alignClass(node)]])}>${children(node)}</p>`;
      case 'heading': {
        const level = [2, 3, 4].includes(node.attrs?.level) ? node.attrs.level : 2;
        return `<h${level}${attrs([['class', alignClass(node)]])}>${children(node)}</h${level}>`;
      }
      case 'bulletList': return `<ul>${children(node)}</ul>`;
      case 'orderedList': {
        const start = node.attrs?.start;
        const type = node.attrs?.type;
        return `<ol${attrs([['start', Number.isSafeInteger(start) && start !== 1 ? start : null], ['type', ORDERED_TYPES.has(type) ? type : null]])}>${children(node)}</ol>`;
      }
      case 'listItem': return `<li>${children(node)}</li>`;
      case 'blockquote': return `<blockquote>${children(node)}</blockquote>`;
      case 'table': return `<div class="table-wrap"><table><tbody>${children(node)}</tbody></table></div>`;
      case 'tableRow': return `<tr>${children(node)}</tr>`;
      case 'tableHeader': return cell('th', node);
      case 'tableCell': return cell('td', node);
      case 'image': {
        const id = node.attrs.mediaId;
        const info = media.get(id);
        return `<img${attrs([
          ['src', mediaSrc(id)], ['alt', node.attrs.alt || info?.alt || ''],
          ['width', info?.width ?? null], ['height', info?.height ?? null], ['loading', 'lazy'], ['decoding', 'async'],
        ])}>`;
      }
      default: throw new TypeError(`Nodo no admitido: ${node.type}`);
    }
  }

  return children(doc);
}
