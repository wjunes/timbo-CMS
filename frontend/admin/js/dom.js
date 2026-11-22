/**
 * Utilidades de interfaz sin frameworks.
 *
 * Los datos siempre entran en el DOM como texto (`textContent`) o como
 * propiedades: este módulo no usa innerHTML. La única excepción del panel es
 * la vista previa, que muestra el HTML generado y escapado por el servidor.
 */

/**
 * Crea un elemento. `props`: class, text, on<Evento> (funciones), dataset,
 * y el resto como propiedades o atributos (nunca `style` ni manejadores en texto).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' || key.startsWith('on')) throw new TypeError(`Atributo no permitido: ${key}`);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' });
export const formatDate = (iso) => (iso ? dateFormat.format(new Date(iso)) : '—');

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export const STATUS_LABELS = {
  draft: 'Borrador', pending_review: 'En revisión', changes_requested: 'Cambios solicitados', approved: 'Aprobada',
  published: 'Publicado', archived: 'Archivado', active: 'Activa', inactive: 'Inactiva', deleted: 'Eliminado',
};

export const badge = (status) => h('span', { class: `badge badge-${status}`, text: STATUS_LABELS[status] ?? status });

/** Zona de mensajes: muestra un aviso de error u ok. */
export function notice(kind, text) {
  return h('p', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status', text });
}

/** Ejecuta una acción mostrando su error en `target` y deshabilitando el botón mientras dura. */
export async function run(button, target, fn, describe) {
  if (button) button.disabled = true;
  target?.replaceChildren();
  try {
    return await fn();
  } catch (err) {
    target?.append(notice('error', describe(err)));
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Diálogo modal nativo. Devuelve el elemento <dialog>; `close()` lo retira. */
export function modal(title, ...content) {
  const dialog = h('dialog', { class: 'modal' },
    h('header', {}, h('h2', { text: title }), h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', text: '×', onClick: () => dialog.close() })),
    h('div', { class: 'modal-body' }, ...content));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
