/**
 * Editor enriquecido del panel (Bloque 08): Tiptap configurado con exactamente
 * los nodos y marcas que admite la lista blanca del backend
 * (backend/modules/contents/body.js). Se empaqueta con esbuild en
 * frontend/admin/assets/editor.bundle.js (`npm run build:editor`).
 *
 * Compatible con una CSP sin estilos ni scripts en línea:
 * - `injectCSS: false`: los estilos del editor están en admin.css.
 * - La alineación se guarda como atributo `textAlign` y se pinta como clase
 *   (`align-center`…), nunca como `style`.
 * - Tablas sin vista de nodo ni anchos en línea; celdas sin el atributo `align`.
 * - Imágenes solo de la biblioteca: el nodo guarda `mediaId` y `alt`, no una URL.
 * - El contenido admitido de citas, elementos de lista y celdas es el mismo que
 *   el de la lista blanca, para que el editor no produzca algo que se rechazará.
 */
import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Blockquote from '@tiptap/extension-blockquote';
import { ListItem } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

const ALIGNMENTS = ['left', 'center', 'right', 'justify'];

/** Alineación de párrafos y encabezados mediante clases. */
const TextAlign = Extension.create({
  name: 'textAlign',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        textAlign: {
          default: null,
          parseHTML: (el) => ALIGNMENTS.find((a) => el.classList.contains(`align-${a}`)) ?? null,
          renderHTML: (attrs) => (ALIGNMENTS.includes(attrs.textAlign) ? { class: `align-${attrs.textAlign}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setTextAlign: (value) => ({ commands }) => {
        const align = ALIGNMENTS.includes(value) && value !== 'left' ? value : null;
        return ['paragraph', 'heading'].map((type) => commands.updateAttributes(type, { textAlign: align })).some(Boolean);
      },
    };
  },
});

/**
 * Imagen de la biblioteca multimedia. `mediaSrc(id)` da la URL con la que el
 * panel la muestra; el documento solo guarda el identificador.
 */
function createMediaImage(mediaSrc) {
  return Node.create({
    name: 'image',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        mediaId: {
          default: null,
          parseHTML: (el) => {
            const id = Number(el.getAttribute('data-media-id'));
            return Number.isSafeInteger(id) && id > 0 ? id : null;
          },
          renderHTML: () => ({}),
        },
        alt: { default: '', parseHTML: (el) => el.getAttribute('alt') ?? '' },
      };
    },
    // Solo se reconocen imágenes propias: al pegar HTML externo, una <img> ajena no entra.
    parseHTML() {
      return [{ tag: 'img[data-media-id]' }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return ['img', mergeAttributes(HTMLAttributes, { src: mediaSrc(node.attrs.mediaId), 'data-media-id': String(node.attrs.mediaId) })];
    },
    addCommands() {
      return {
        insertMediaImage: ({ mediaId, alt = '' }) => ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { mediaId, alt } }),
      };
    },
  });
}

const PlainTable = Table.extend({
  addOptions() {
    return { ...this.parent?.(), resizable: false, View: null };
  },
  renderHTML() {
    return ['table', {}, ['tbody', 0]];
  },
});

const LIST_BLOCKS = '(bulletList | orderedList)';
const QuoteBlock = Blockquote.extend({ content: `(paragraph | heading | ${LIST_BLOCKS} | image)+` });
const Item = ListItem.extend({ content: `paragraph ${LIST_BLOCKS}*` });

function cell(base) {
  return base.extend({
    content: `(paragraph | ${LIST_BLOCKS} | image)+`,
    addAttributes() {
      const { align: _align, ...rest } = this.parent?.() ?? {};
      return rest;
    },
  });
}

/** Esquema del panel. Exportado para comprobar en pruebas que coincide con la lista blanca. */
export function editorExtensions({ mediaSrc = (id) => `/api/media/${id}/file` } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      code: false,
      codeBlock: false,
      strike: false,
      horizontalRule: false,
      blockquote: false,
      listItem: false,
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow', class: null },
        // El backend vuelve a validarlo; aquí solo se evita insertar destinos que rechazará.
        isAllowedUri: (url) => /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url),
      },
    }),
    QuoteBlock,
    Item,
    TextAlign,
    createMediaImage(mediaSrc),
    PlainTable,
    TableRow,
    cell(TableHeader),
    cell(TableCell),
  ];
}

/**
 * @param {{ element: HTMLElement, content: object, mediaSrc?: (id: number) => string,
 *           onUpdate?: (editor: Editor) => void, onSelectionUpdate?: (editor: Editor) => void }} options
 */
export function createEditor({ element, content, mediaSrc, onUpdate, onSelectionUpdate }) {
  return new Editor({
    element,
    content,
    injectCSS: false,
    extensions: editorExtensions({ mediaSrc }),
    onUpdate: ({ editor }) => onUpdate?.(editor),
    onSelectionUpdate: ({ editor }) => onSelectionUpdate?.(editor),
    onTransaction: ({ editor }) => onSelectionUpdate?.(editor),
  });
}

export { ALIGNMENTS };
