/**
 * Vista de una sección: sus contenidos y la creación de uno nuevo.
 */
import { api, errorMessage } from './api.js';
import { badge, formatDate, h, mount, notice, run } from './dom.js';
import { can, navigate } from './state.js';

export function sectionTabs(section, active) {
  return h('nav', { class: 'tabs', 'aria-label': 'Sección' },
    h('a', { href: `#/sections/${section.id}`, class: active === 'contents' ? 'active' : '', text: 'Contenidos' }),
    h('a', { href: `#/sections/${section.id}/media`, class: active === 'media' ? 'active' : '', text: 'Biblioteca multimedia' }));
}

export function sectionHeader(section) {
  return h('div', { class: 'heading' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/sections', text: 'Secciones' }), ' / ', section.path),
    h('h1', {}, section.name, ' ', badge(section.status)),
    h('p', { class: 'muted', text: section.workflow === 'approval' ? 'Publicación con aprobación del administrador general.' : 'Publicación directa.' }));
}

export async function renderSection(root, layout, sectionId) {
  const [{ section }, { contents }] = await Promise.all([
    api(`/api/sections/${sectionId}`),
    api(`/api/sections/${sectionId}/contents`),
  ]);
  const writable = section.status !== 'archived';

  let createForm = null;
  if (writable && can('content.create', section.id)) {
    const msg = h('div', { class: 'messages' });
    const title = h('input', { required: true, maxLength: 300, placeholder: 'Título del contenido nuevo' });
    const submit = h('button', { type: 'submit', class: 'primary', text: 'Crear borrador' });
    createForm = h('form', { class: 'inline-form', onSubmit: async (e) => {
      e.preventDefault();
      const data = await run(submit, msg, () => api(`/api/sections/${section.id}/contents`, { method: 'POST', body: { title: title.value } }), errorMessage);
      if (data) navigate(`#/contents/${data.content.id}/versions/${data.version.id}/edit`);
    } }, title, submit, msg);
  }

  const table = contents.length
    ? h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Título' }), h('th', { text: 'Slug' }), h('th', { text: 'Estado' }), h('th', { text: 'En curso' }), h('th', { text: 'Actualizado' }))),
      h('tbody', {}, contents.map((c) => h('tr', {},
        h('td', {}, h('a', { href: `#/contents/${c.id}`, text: c.title })),
        h('td', { class: 'mono', text: c.slug }),
        h('td', {}, badge(c.status)),
        h('td', {}, c.openVersion ? [`v${c.openVersion.versionNumber} `, badge(c.openVersion.status)] : '—'),
        h('td', { text: formatDate(c.updatedAt) })))))
    : notice('info', 'La sección no tiene contenidos.');

  mount(root, ...layout(sectionHeader(section), sectionTabs(section, 'contents'), createForm, table));
}
