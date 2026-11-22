/**
 * Edición de un borrador con el editor enriquecido (Tiptap, bundle local).
 *
 * El documento se envía como JSON estructurado; el backend lo valida contra la
 * lista blanca y comprueba sus archivos. Guardado con control optimista
 * (`revision`): si otra persona guardó antes, se avisa sin sobrescribir.
 */
import { createEditor } from '/admin/assets/editor.bundle.js';
import { ApiError, api, errorMessage } from './api.js';
import { badge, h, modal, mount, notice, run } from './dom.js';
import { pickMedia } from './media.js';
import { previewDialog } from './preview.js';
import { can, navigate } from './state.js';

let current = null; // editor activo; se destruye al salir de la vista

function destroyCurrent() {
  current?.destroy();
  current = null;
}

/** Mismas reglas que el backend (body.js): http(s), mailto, rutas del sitio y anclas. */
export function hrefProblem(href) {
  if (!href || href.length > 2048 || /[\s\\<>"`]/.test(href)) return 'El destino está vacío o tiene caracteres no válidos.';
  if (href.startsWith('//')) return 'No se admiten direcciones que empiezan por //.';
  if (href.startsWith('/') || /^#[A-Za-z0-9_-]{1,200}$/.test(href)) return null;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(href.split('?')[0])) return null;
  try {
    const url = new URL(href);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return null;
  } catch {
    // no es una URL absoluta
  }
  return 'Solo se admiten enlaces http(s), mailto:, rutas del sitio (/…) y anclas (#…).';
}

function linkDialog(editor, sectionId) {
  const existing = editor.getAttributes('link');
  const msg = h('div', { class: 'messages' });
  const href = h('input', { value: existing.href ?? '', maxLength: 2048, placeholder: 'https://… · /ruta · mailto:… · #ancla', required: true });
  const blank = h('input', { type: 'checkbox', checked: existing.target === '_blank' });
  const pick = h('button', { type: 'button', text: 'Elegir de la biblioteca…', onClick: async () => {
    const m = await pickMedia(sectionId, { kind: 'any' });
    if (m) href.value = `/media/${m.id}`;
  } });
  const dialog = modal('Enlace', h('form', { onSubmit: (e) => {
    e.preventDefault();
    const problem = hrefProblem(href.value.trim());
    if (problem) {
      msg.replaceChildren(notice('error', problem));
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.value.trim(), target: blank.checked ? '_blank' : null }).run();
    dialog.close();
  } }, msg, h('label', {}, 'Destino', href), pick, h('label', { class: 'check' }, blank, 'Abrir en una pestaña nueva'),
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary', text: 'Aplicar' }),
    existing.href ? h('button', { type: 'button', text: 'Quitar enlace', onClick: () => {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      dialog.close();
    } }) : null)));
  href.focus();
}

function toolbar(editor, sectionId) {
  const buttons = [];
  const btn = (label, title, command, isActive, canRun) => {
    const b = h('button', { type: 'button', class: 'tool', title, 'aria-label': title, text: label, onMousedown: (e) => e.preventDefault(), onClick: () => command() });
    buttons.push({ b, isActive, canRun });
    return b;
  };
  const chain = () => editor.chain().focus();
  const group = (...items) => h('div', { class: 'tool-group', role: 'group' }, items);
  const update = () => {
    for (const { b, isActive, canRun } of buttons) {
      if (isActive) b.setAttribute('aria-pressed', String(Boolean(isActive())));
      if (canRun) b.disabled = !canRun();
    }
  };
  const inTable = () => editor.isActive('table');

  const bar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Formato' },
    group(
      btn('↶', 'Deshacer', () => chain().undo().run(), null, () => editor.can().undo()),
      btn('↷', 'Rehacer', () => chain().redo().run(), null, () => editor.can().redo())),
    group(
      btn('B', 'Negrita', () => chain().toggleBold().run(), () => editor.isActive('bold')),
      btn('I', 'Cursiva', () => chain().toggleItalic().run(), () => editor.isActive('italic')),
      btn('U', 'Subrayado', () => chain().toggleUnderline().run(), () => editor.isActive('underline'))),
    group(
      btn('¶', 'Párrafo', () => chain().setParagraph().run(), () => editor.isActive('paragraph')),
      ...[2, 3, 4].map((level) => btn(`H${level}`, `Encabezado ${level}`, () => chain().toggleHeading({ level }).run(), () => editor.isActive('heading', { level })))),
    group(
      btn('•', 'Lista con viñetas', () => chain().toggleBulletList().run(), () => editor.isActive('bulletList')),
      btn('1.', 'Lista numerada', () => chain().toggleOrderedList().run(), () => editor.isActive('orderedList')),
      btn('❝', 'Cita', () => chain().toggleBlockquote().run(), () => editor.isActive('blockquote'))),
    group(
      ...[['left', '⯇', 'Alinear a la izquierda'], ['center', '≡', 'Centrar'], ['right', '⯈', 'Alinear a la derecha'], ['justify', '☰', 'Justificar']]
        .map(([a, label, title]) => btn(label, title, () => chain().setTextAlign(a).run(),
          () => (a === 'left' ? !['center', 'right', 'justify'].some((x) => editor.isActive({ textAlign: x })) : editor.isActive({ textAlign: a }))))),
    group(
      btn('🔗', 'Enlace', () => linkDialog(editor, sectionId), () => editor.isActive('link')),
      btn('🖼', 'Imagen de la biblioteca', async () => {
        const m = await pickMedia(sectionId, { kind: 'image', canUpload: can('media.upload', sectionId) });
        if (m) chain().insertMediaImage({ mediaId: m.id, alt: m.altText }).run();
      })),
    group(
      btn('▦', 'Insertar tabla', () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), null, () => !inTable()),
      btn('+F', 'Añadir fila', () => chain().addRowAfter().run(), null, inTable),
      btn('+C', 'Añadir columna', () => chain().addColumnAfter().run(), null, inTable),
      btn('−F', 'Eliminar fila', () => chain().deleteRow().run(), null, inTable),
      btn('−C', 'Eliminar columna', () => chain().deleteColumn().run(), null, inTable),
      btn('✕▦', 'Eliminar tabla', () => chain().deleteTable().run(), null, inTable)));
  return { bar, update };
}

export async function renderEditor(root, layout, contentId, versionId) {
  destroyCurrent();
  const [{ version }, { content }] = await Promise.all([
    api(`/api/contents/${contentId}/versions/${versionId}`),
    api(`/api/contents/${contentId}`),
  ]);
  const back = h('a', { href: `#/contents/${contentId}`, text: `← ${version.title}` });
  if (version.status !== 'draft') {
    mount(root, ...layout(back, notice('info', 'Esta versión ya no es un borrador y no se puede editar.')));
    return;
  }

  const msg = h('div', { class: 'messages' });
  const status = h('span', { class: 'save-status', 'aria-live': 'polite', text: 'Sin cambios' });
  const title = h('input', { value: version.title, maxLength: 300, required: true, 'aria-label': 'Título' });
  const summary = h('textarea', { maxLength: 2000, rows: 2, placeholder: 'Resumen (opcional)', 'aria-label': 'Resumen', text: version.summary });
  const area = h('div', { class: 'editor-area' });
  let revision = version.revision;
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    status.textContent = 'Cambios sin guardar';
  };

  let tools = null;
  const editor = createEditor({
    element: area,
    content: version.body,
    onUpdate: markDirty,
    onSelectionUpdate: () => tools?.update(),
  });
  current = editor;
  tools = toolbar(editor, content.sectionId);
  tools.update();
  title.addEventListener('input', markDirty);
  summary.addEventListener('input', markDirty);

  const save = h('button', { type: 'button', class: 'primary', text: 'Guardar', onClick: async () => {
    const data = await run(save, msg, () => api(`/api/contents/${contentId}/versions/${versionId}`, {
      method: 'PATCH', body: { revision, title: title.value, summary: summary.value, body: editor.getJSON() },
    }), (err) => (err instanceof ApiError && err.code === 'revision_conflict'
      ? `${errorMessage(err)} (revisión actual: ${err.body.currentRevision}). Tus cambios siguen en pantalla: cópialos antes de recargar.`
      : errorMessage(err)));
    if (data) {
      revision = data.version.revision;
      dirty = false;
      status.textContent = `Guardado (revisión ${revision})`;
    }
  } });
  const preview = h('button', { type: 'button', text: 'Vista previa', onClick: () =>
    previewDialog(contentId, { title: title.value, summary: summary.value, body: editor.getJSON() }) });

  const leave = (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', leave);
  window.addEventListener('hashchange', () => {
    window.removeEventListener('beforeunload', leave);
    if (current === editor) destroyCurrent();
  }, { once: true });

  mount(root, ...layout(
    h('div', { class: 'heading' }, h('p', { class: 'crumbs' }, back), h('h1', {}, `Editar v${version.versionNumber} `, badge(version.status))),
    msg,
    h('div', { class: 'editor-form' },
      h('label', {}, 'Título', title),
      h('label', {}, 'Resumen', summary),
      h('div', { class: 'editor-shell' }, tools.bar, area),
      h('div', { class: 'actions sticky' }, save, preview, status))));
}
