/**
 * Biblioteca multimedia de una sección (Bloque 08) y selector para el editor.
 * Subida en bruto: el archivo es el cuerpo de la petición (ver api.js).
 */
import { ApiError, api, errorMessage } from './api.js';
import { formatBytes, formatDate, h, modal, mount, notice, run } from './dom.js';
import { sectionHeader, sectionTabs } from './section.js';
import { can } from './state.js';

export const ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf';

const thumb = (m) => (m.kind === 'image'
  ? h('img', { src: m.fileUrl, alt: m.altText, loading: 'lazy', width: m.width, height: m.height })
  : h('span', { class: 'doc-icon', text: m.extension.toUpperCase() }));

/** Sube los archivos uno a uno; informa en `target`. Devuelve los subidos. */
async function uploadFiles(sectionId, files, target) {
  const done = [];
  for (const file of files) {
    const line = h('p', { class: 'muted', text: `Subiendo ${file.name}…` });
    target.append(line);
    try {
      const { media } = await api(`/api/sections/${sectionId}/media`, { method: 'POST', file });
      line.replaceWith(notice('ok', `${file.name}: subido.`));
      done.push(media);
    } catch (err) {
      line.replaceWith(notice('error', `${file.name}: ${errorMessage(err)}`));
    }
  }
  return done;
}

function uploader(sectionId, onUploaded) {
  const status = h('div', { class: 'messages' });
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, onChange: async () => {
    const files = [...input.files];
    input.value = '';
    status.replaceChildren();
    const done = await uploadFiles(sectionId, files, status);
    if (done.length) onUploaded(done);
  } });
  return h('div', { class: 'uploader' }, h('label', { class: 'button' }, 'Subir archivos', input),
    h('span', { class: 'muted', text: ' PNG, JPEG, WebP o PDF. Se eliminan los metadatos (EXIF, GPS…).' }), status);
}

function usageList(usage) {
  return h('ul', {}, usage.map((u) => h('li', {},
    h('a', { href: `#/contents/${u.content.id}`, text: u.version.title }), ` (v${u.version.versionNumber}, ${u.version.status})`)));
}

function card(m, section, refresh) {
  const msg = h('div', { class: 'messages' });
  const writable = section.status !== 'archived';
  const parts = [
    h('div', { class: 'thumb' }, thumb(m)),
    h('p', { class: 'name', text: m.originalName, title: m.originalName }),
    h('p', { class: 'small muted', text: [m.width ? `${m.width}×${m.height}` : null, formatBytes(m.sizeBytes), formatDate(m.createdAt)].filter(Boolean).join(' · ') }),
  ];
  if (m.kind === 'image' && writable && can('media.upload', section.id)) {
    const alt = h('input', { value: m.altText, maxLength: 500, placeholder: 'Texto alternativo', 'aria-label': `Texto alternativo de ${m.originalName}` });
    const save = h('button', { type: 'submit', text: 'Guardar' });
    parts.push(h('form', { class: 'alt-form', onSubmit: async (e) => {
      e.preventDefault();
      const ok = await run(save, msg, () => api(`/api/media/${m.id}`, { method: 'PATCH', body: { altText: alt.value } }), errorMessage);
      if (ok) msg.append(notice('ok', 'Guardado.'));
    } }, alt, save));
  } else if (m.altText) {
    parts.push(h('p', { class: 'small', text: `Alt: ${m.altText}` }));
  }
  const actions = [h('a', { class: 'button', href: m.fileUrl, download: m.originalName, text: 'Descargar' })];
  if (writable && can('media.delete', section.id)) {
    const del = h('button', { type: 'button', class: 'danger', text: 'Eliminar', onClick: async () => {
      if (!window.confirm(`¿Eliminar ${m.originalName}?`)) return;
      del.disabled = true;
      msg.replaceChildren();
      try {
        await api(`/api/media/${m.id}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        msg.append(notice('error', errorMessage(err)));
        if (err instanceof ApiError && err.code === 'media_in_use') msg.append(usageList(err.body.usage ?? []));
      } finally {
        del.disabled = false;
      }
    } });
    actions.push(del);
  }
  parts.push(h('div', { class: 'actions' }, actions), msg);
  return h('div', { class: 'media-card' }, parts);
}

export async function renderLibrary(root, layout, sectionId) {
  const [{ section }, { media }] = await Promise.all([api(`/api/sections/${sectionId}`), api(`/api/sections/${sectionId}/media`)]);
  const refresh = () => renderLibrary(root, layout, sectionId);
  const writable = section.status !== 'archived';
  mount(root, ...layout(
    sectionHeader(section),
    sectionTabs(section, 'media'),
    writable && can('media.upload', section.id) ? uploader(section.id, refresh) : null,
    media.length ? h('div', { class: 'media-grid' }, media.map((m) => card(m, section, refresh))) : notice('info', 'La biblioteca está vacía.')));
}

/**
 * Selector de archivo para el editor. `kind`: 'image' o 'any'.
 * @returns {Promise<object|null>} el archivo elegido o null.
 */
export function pickMedia(sectionId, { kind = 'image', canUpload = false } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    const grid = h('div', { class: 'media-grid picker' }, h('p', { class: 'muted', text: 'Cargando…' }));
    const load = async () => {
      try {
        const { media } = await api(`/api/sections/${sectionId}/media`);
        const list = media.filter((m) => kind === 'any' || m.kind === kind);
        grid.replaceChildren(...(list.length ? list.map((m) => h('button', { type: 'button', class: 'media-card pick', onClick: () => {
          chosen = m;
          dialog.close();
        } }, h('div', { class: 'thumb' }, thumb(m)), h('p', { class: 'name', text: m.originalName }))) : [notice('info', 'No hay archivos de este tipo en la biblioteca.')]));
      } catch (err) {
        grid.replaceChildren(notice('error', errorMessage(err)));
      }
    };
    const dialog = modal(kind === 'image' ? 'Insertar imagen' : 'Enlazar archivo de la biblioteca',
      canUpload ? uploader(sectionId, load) : null, grid);
    dialog.classList.add('wide');
    dialog.addEventListener('close', () => resolve(chosen));
    load();
  });
}
