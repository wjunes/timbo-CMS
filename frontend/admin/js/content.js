/**
 * Vista de un contenido: versiones, acciones editoriales (Bloque 07) y revisiones.
 * Cada botón aparece solo si la acción es posible; el backend decide siempre.
 */
import { api, errorMessage } from './api.js';
import { badge, formatDate, h, modal, mount, notice, run } from './dom.js';
import { previewDialog } from './preview.js';
import { can, isGeneralAdmin, navigate, state } from './state.js';

export async function renderContent(root, layout, contentId) {
  const { content, versions } = await api(`/api/contents/${contentId}/versions`);
  const { section } = await api(`/api/sections/${content.sectionId}`);
  const msg = h('div', { class: 'messages' });
  const reload = () => navigate(`#/contents/${contentId}`);
  const sid = section.id;
  const live = section.status !== 'archived';
  const editable = live && content.status !== 'archived';

  const act = (label, fn, { kind = '', confirmText } = {}) => {
    const button = h('button', { type: 'button', class: kind, text: label, onClick: async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      const ok = await run(button, msg, fn, errorMessage);
      if (ok !== undefined) reload();
    } });
    return button;
  };
  const post = (path, body) => api(path, { method: 'POST', body });
  const vpath = (v, action) => `/api/contents/${contentId}/versions/${v.id}/${action}`;

  // --- Acciones del contenido
  const contentActions = [];
  if (editable && !content.openVersion && can('content.edit', sid)) {
    contentActions.push(act('Nueva versión', async () => {
      const data = await post(`/api/contents/${contentId}/versions`, {});
      navigate(`#/contents/${contentId}/versions/${data.version.id}/edit`);
      return undefined;
    }, { kind: 'primary' }));
  }
  if (live && content.status === 'published' && can('content.unpublish', sid)) {
    contentActions.push(act('Despublicar', () => post(`/api/contents/${contentId}/unpublish`), { confirmText: '¿Retirar el contenido del sitio público?' }));
  }
  if (live && content.status !== 'archived' && can('content.archive', sid)) {
    contentActions.push(act('Archivar', () => post(`/api/contents/${contentId}/archive`), { confirmText: '¿Archivar el contenido? Si está publicado, se despublica.' }));
  }
  if (live && content.status === 'archived' && can('content.archive', sid)) {
    contentActions.push(act('Restaurar', () => post(`/api/contents/${contentId}/restore`)));
  }
  if (live && content.status !== 'published' && can('content.delete', sid)) {
    contentActions.push(act('Eliminar', async () => {
      await api(`/api/contents/${contentId}`, { method: 'DELETE' });
      navigate(`#/sections/${sid}`);
      return undefined;
    }, { kind: 'danger', confirmText: '¿Eliminar el contenido? Dejará de estar disponible en el panel.' }));
  }

  // --- Acciones de cada versión
  function versionActions(v) {
    const list = [h('button', { type: 'button', text: 'Ver', onClick: () => showVersion(v) })];
    if (v.status === 'draft' && editable) {
      const mine = v.createdBy?.id === state.user.id;
      if (can('content.edit', sid) || (mine && can('content.create', sid))) {
        list.push(h('a', { class: 'button', href: `#/contents/${contentId}/versions/${v.id}/edit`, text: 'Editar' }));
      }
      if (section.workflow === 'approval' && can('content.submit', sid)) {
        list.push(act('Enviar a revisión', () => post(vpath(v, 'submit'), { revision: v.revision }), { kind: 'primary' }));
      }
      if (section.workflow === 'direct' && can('content.publish', sid)) {
        list.push(act('Publicar', () => post(vpath(v, 'publish'), { revision: v.revision }), { kind: 'primary', confirmText: '¿Publicar esta versión?' }));
      }
      if (versions.length > 1 && (can('content.edit', sid) || (mine && can('content.create', sid)))) {
        list.push(act('Descartar', () => api(`/api/contents/${contentId}/versions/${v.id}`, { method: 'DELETE' }), { kind: 'danger', confirmText: '¿Descartar este borrador?' }));
      }
    }
    if (v.status === 'pending_review' && editable && isGeneralAdmin()) {
      list.push(act('Aprobar', () => post(vpath(v, 'approve'), {}), { kind: 'primary' }));
      list.push(h('button', { type: 'button', text: 'Solicitar cambios', onClick: () => requestChanges(v) }));
    }
    if (v.status === 'approved' && editable && can('content.publish', sid)) {
      list.push(act('Publicar', () => post(vpath(v, 'publish'), {}), { kind: 'primary', confirmText: '¿Publicar la versión aprobada?' }));
    }
    if (['pending_review', 'approved', 'changes_requested', 'published', 'archived'].includes(v.status)) {
      list.push(h('button', { type: 'button', text: 'Revisiones', onClick: () => showReviews(v) }));
    }
    return h('div', { class: 'actions' }, list);
  }

  function requestChanges(v) {
    const dmsg = h('div', { class: 'messages' });
    const comment = h('textarea', { required: true, maxLength: 5000, rows: 5 });
    const submit = h('button', { type: 'submit', class: 'primary', text: 'Solicitar cambios' });
    const dialog = modal(`Solicitar cambios en v${v.versionNumber}`, h('form', { onSubmit: async (e) => {
      e.preventDefault();
      const ok = await run(submit, dmsg, () => post(vpath(v, 'request-changes'), { comment: comment.value }), errorMessage);
      if (ok) {
        dialog.close();
        reload();
      }
    } }, dmsg, h('label', {}, 'Comentario para quien redactó', comment), submit));
  }

  async function showReviews(v) {
    const body = h('div', {}, h('p', { class: 'muted', text: 'Cargando…' }));
    modal(`Revisiones de v${v.versionNumber}`, body);
    try {
      const { reviews } = await api(vpath(v, 'reviews'));
      body.replaceChildren(...(reviews.length ? reviews.map((r) => h('div', { class: 'review' },
        h('p', {}, badge(r.decision), ` ${r.reviewer.displayName} · ${formatDate(r.createdAt)}`),
        // Texto plano: el comentario nunca se interpreta como HTML.
        r.comment ? h('p', { class: 'comment', text: r.comment }) : null)) : [notice('info', 'Sin revisiones.')]));
    } catch (err) {
      body.replaceChildren(notice('error', errorMessage(err)));
    }
  }

  async function showVersion(v) {
    try {
      const { version } = await api(`/api/contents/${contentId}/versions/${v.id}`);
      await previewDialog(contentId, version);
    } catch (err) {
      msg.replaceChildren(notice('error', errorMessage(err)));
    }
  }

  const header = h('div', { class: 'heading' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/sections', text: 'Secciones' }), ' / ', h('a', { href: `#/sections/${sid}`, text: section.name })),
    h('h1', {}, content.title, ' ', badge(content.status)),
    h('p', { class: 'muted' }, 'Slug: ', h('span', { class: 'mono', text: content.slug }),
      content.publishedVersion ? ` · Publicada: v${content.publishedVersion.versionNumber}` : ' · Sin versión publicada'));

  const table = h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Versión' }), h('th', { text: 'Título' }), h('th', { text: 'Estado' }), h('th', { text: 'Autoría' }), h('th', { text: 'Acciones' }))),
    h('tbody', {}, versions.map((v) => h('tr', {},
      h('td', { text: `v${v.versionNumber}` }),
      h('td', { text: v.title }),
      h('td', {}, badge(v.status)),
      h('td', { class: 'small' },
        `Creó ${v.createdBy.displayName} (${formatDate(v.createdAt)})`,
        v.approvedBy ? h('br') : null, v.approvedBy ? `Aprobó ${v.approvedBy.displayName} (${formatDate(v.approvedAt)})` : null,
        v.publishedBy ? h('br') : null, v.publishedBy ? `Publicó ${v.publishedBy.displayName} (${formatDate(v.publishedAt)})` : null),
      h('td', {}, versionActions(v))))));

  mount(root, ...layout(
    section.status === 'archived' ? notice('info', 'La sección está archivada: solo lectura.') : null,
    header,
    msg,
    h('div', { class: 'actions' }, contentActions),
    h('h2', { text: 'Versiones' }),
    table));
}
