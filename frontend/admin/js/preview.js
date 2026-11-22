/**
 * Vista previa: el servidor valida el cuerpo y devuelve el HTML seguro, el
 * mismo que generará el sitio público (todo el texto escapado, sin estilos ni
 * scripts). Es el único HTML que el panel inserta, y lo hace a través de un
 * <template> (contenido inerte) bajo la CSP estricta del panel.
 */
import { api, errorMessage } from './api.js';
import { h, modal, notice } from './dom.js';

export async function renderPreviewInto(container, contentId, body) {
  container.replaceChildren(h('p', { class: 'muted', text: 'Generando vista previa…' }));
  try {
    const { html } = await api(`/api/contents/${contentId}/preview`, { method: 'POST', body: { body } });
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    container.replaceChildren(tpl.content);
  } catch (err) {
    container.replaceChildren(notice('error', errorMessage(err)));
  }
}

export function previewDialog(contentId, { title, summary, body }) {
  const article = h('div', { class: 'rendered' });
  modal('Vista previa', h('article', { class: 'preview' }, h('h1', { text: title }), summary ? h('p', { class: 'summary', text: summary }) : null, article));
  return renderPreviewInto(article, contentId, body);
}
