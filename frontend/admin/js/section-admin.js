/**
 * Alta y configuración de secciones (Bloque 10, D-045; solo administración general).
 *
 * Usa la API del Bloque 05: crear, editar (nombre, descripción, slug, padre,
 * presentación y flujo editorial), ordenar entre hermanas, activar, desactivar,
 * archivar y eliminar (solo si está vacía y no es del sistema).
 */
import { api, errorMessage } from './api.js';
import { badge, h, mount, notice, run } from './dom.js';
import { sectionHeader, sectionTabs } from './section.js';
import { navigate } from './state.js';

const WORKFLOWS = [['direct', 'Directa'], ['approval', 'Con aprobación del administrador general']];
const MAX_DEPTH = 3;

const option = (value, text, selected) => h('option', { value, text, selected: selected || undefined });

function parentSelect(sections, { current = null, exclude = null } = {}) {
  // Un padre válido: no archivado, con profundidad < 3 y fuera del propio subárbol.
  const banned = new Set();
  if (exclude) {
    banned.add(exclude.id);
    for (const s of sections) if (s.path.startsWith(`${exclude.path}/`)) banned.add(s.id);
  }
  return h('select', {},
    option('', '(ninguno: sección principal)', current === null),
    sections.filter((s) => !banned.has(s.id) && s.status !== 'archived' && s.depth < MAX_DEPTH)
      .map((s) => option(String(s.id), `${'— '.repeat(s.depth - 1)}${s.name} (/${s.path})`, s.id === current)));
}

async function catalogs() {
  const [{ types }, { presentations }] = await Promise.all([api('/api/section-types'), api('/api/presentations')]);
  return { types, presentations };
}

/** Formulario de alta, para la lista de secciones. */
export async function newSectionForm(sections) {
  const { types, presentations } = await catalogs();
  const msg = h('div', { class: 'messages' });
  const name = h('input', { required: true, maxLength: 120 });
  const type = h('select', {}, types.map((t) => option(t.code, t.name)));
  const parent = parentSelect(sections);
  const slug = h('input', { maxLength: 100, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'se genera a partir del nombre' });
  const presentation = h('select', {}, option('', '(la del tipo)', true), presentations.map((p) => option(p.code, p.name)));
  const workflow = h('select', {}, WORKFLOWS.map(([v, t]) => option(v, t, v === 'approval')));
  const submit = h('button', { type: 'submit', class: 'primary', text: 'Crear sección' });
  return h('details', { class: 'card' }, h('summary', { text: 'Nueva sección' }),
    h('form', { onSubmit: async (e) => {
      e.preventDefault();
      const body = { name: name.value, type: type.value, workflow: workflow.value, parentId: parent.value ? Number(parent.value) : null };
      if (slug.value.trim()) body.slug = slug.value.trim();
      if (presentation.value) body.presentation = presentation.value;
      const data = await run(submit, msg, () => api('/api/sections', { method: 'POST', body }), errorMessage);
      if (data) navigate(`#/sections/${data.section.id}/settings`);
    } }, msg,
    h('div', { class: 'cols' },
      h('label', {}, 'Nombre', name), h('label', {}, 'Tipo', type),
      h('label', {}, 'Sección padre', parent), h('label', {}, 'Slug (URL)', slug),
      h('label', {}, 'Presentación', presentation), h('label', {}, 'Publicación', workflow)),
    submit));
}

export async function renderSectionSettings(root, layout, sectionId) {
  const [{ section }, { sections }, { presentations }] = await Promise.all([
    api(`/api/sections/${sectionId}`), api('/api/sections'), catalogs(),
  ]);
  const reload = () => renderSectionSettings(root, layout, sectionId);
  const archived = section.status === 'archived';

  // Edición
  const msg = h('div', { class: 'messages' });
  const name = h('input', { value: section.name, required: true, maxLength: 120, disabled: archived });
  const description = h('textarea', { maxLength: 1000, rows: 3, disabled: archived });
  description.value = section.description ?? '';
  const slug = h('input', { value: section.slug, required: true, maxLength: 100, pattern: '[a-z0-9]+(-[a-z0-9]+)*', disabled: archived });
  const parent = parentSelect(sections, { current: section.parentId, exclude: section });
  parent.disabled = archived;
  const presentation = h('select', { disabled: archived }, presentations.map((p) => option(p.code, p.name, p.code === section.presentation)));
  const workflow = h('select', { disabled: archived }, WORKFLOWS.map(([v, t]) => option(v, t, v === section.workflow)));
  const save = h('button', { type: 'submit', class: 'primary', text: 'Guardar cambios', disabled: archived });
  const edit = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    const wanted = {
      name: name.value, description: description.value, slug: slug.value, presentation: presentation.value, workflow: workflow.value,
      parentId: parent.value ? Number(parent.value) : null,
    };
    const current = { name: section.name, description: section.description ?? '', slug: section.slug, presentation: section.presentation, workflow: section.workflow, parentId: section.parentId };
    const body = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => v !== current[k]));
    if (!Object.keys(body).length) {
      msg.replaceChildren(notice('info', 'No hay cambios.'));
      return;
    }
    if ((body.slug || body.parentId !== undefined) && !window.confirm('Cambiar el slug o la sección padre cambia la dirección pública. La antigua redirigirá a la nueva. ¿Continuar?')) return;
    if (await run(save, msg, () => api(`/api/sections/${section.id}`, { method: 'PATCH', body }), errorMessage)) reload();
  } },
  h('h2', { text: 'Datos de la sección' }), msg,
  archived ? notice('info', 'La sección está archivada: es de solo lectura. Actívala o desactívala para editarla.') : null,
  h('div', { class: 'cols' },
    h('label', {}, 'Nombre', name), h('label', {}, 'Slug (URL)', slug),
    h('label', {}, 'Sección padre', parent), h('label', {}, 'Presentación', presentation),
    h('label', {}, 'Publicación', workflow)),
  h('label', {}, 'Descripción', description),
  h('p', { class: 'muted small', text: `Tipo: ${section.type}. Pasar a publicación directa no es posible mientras haya versiones en revisión.` }),
  save);

  // Estado y orden
  const stateMsg = h('div', { class: 'messages' });
  const act = (label, fn, { kind = '', confirmText } = {}) => {
    const b = h('button', { type: 'button', class: kind, text: label, onClick: async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      if (await run(b, stateMsg, fn, errorMessage) !== undefined) reload();
    } });
    return b;
  };
  const post = (p) => () => api(`/api/sections/${section.id}/${p}`, { method: 'POST' });
  const siblings = sections.filter((s) => s.parentId === section.parentId);
  const idx = siblings.findIndex((s) => s.id === section.id);
  const move = (delta) => () => {
    const ids = siblings.map((s) => s.id);
    [ids[idx], ids[idx + delta]] = [ids[idx + delta], ids[idx]];
    return api('/api/sections/order', { method: 'PUT', body: { parentId: section.parentId, ids } });
  };
  const status = h('section', { class: 'card' }, h('h2', { text: 'Estado y orden' }), stateMsg,
    h('p', {}, 'Estado: ', badge(section.status), section.isSystem ? h('span', { class: 'muted small', text: ' · sección del sistema (no se archiva ni se elimina)' }) : null),
    h('p', { class: 'muted small', text: 'Inactiva: no aparece en el sitio público, pero se puede seguir editando. Archivada: además, es de solo lectura.' }),
    h('div', { class: 'actions' },
      section.status !== 'active' ? act('Activar', post('activate'), { kind: 'primary' }) : null,
      section.status !== 'inactive' ? act('Desactivar', post('deactivate'), { confirmText: '¿Retirar la sección y sus subsecciones del sitio público?' }) : null,
      section.status !== 'archived' && !section.isSystem ? act('Archivar', post('archive'), { confirmText: '¿Archivar la sección? Quedará fuera del sitio y en solo lectura.' }) : null,
      idx > 0 ? act('Subir', move(-1)) : null,
      idx < siblings.length - 1 ? act('Bajar', move(1)) : null,
      !section.isSystem ? act('Eliminar', () => api(`/api/sections/${section.id}`, { method: 'DELETE' }).then(() => navigate('#/sections')),
        { kind: 'danger', confirmText: '¿Eliminar la sección? Solo es posible si no tiene subsecciones, contenidos ni archivos.' }) : null));

  mount(root, ...layout(sectionHeader(section), sectionTabs(section, 'settings'), edit, status));
}
