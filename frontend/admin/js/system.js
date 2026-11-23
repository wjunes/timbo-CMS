/**
 * Sistema (Bloque 10; solo administración general): configuración del sitio,
 * consulta y verificación de la auditoría, copias de seguridad y purga de archivos.
 */
import { api, errorMessage } from './api.js';
import { formatBytes, formatDate, h, mount, notice, run } from './dom.js';

const TABS = [['settings', 'Configuración'], ['audit', 'Auditoría'], ['backups', 'Copias de seguridad'], ['purge', 'Purga de archivos']];

function tabs(active) {
  return h('nav', { class: 'tabs', 'aria-label': 'Sistema' },
    TABS.map(([id, label]) => h('a', { href: `#/system/${id}`, class: id === active ? 'active' : '', 'aria-current': id === active ? 'page' : undefined, text: label })));
}

const page = (layout, active, ...content) => layout(h('h1', { text: 'Sistema' }), tabs(active), ...content);

// --- Configuración ----------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Muestra de un modo de una paleta. Los colores se aplican con la API CSSOM
 * (`style.setProperty`), que la CSP admite y que no interpreta texto: un valor que no
 * sea '#rrggbb' se descarta. Así no hace falta ningún atributo `style` (h() los prohíbe).
 */
function swatch(label, colors) {
  const paint = (el, props) => {
    for (const [prop, key] of props) if (HEX.test(colors[key])) el.style.setProperty(prop, colors[key]);
    return el;
  };
  return paint(h('span', { class: 'swatch' },
    paint(h('span', { class: 'bar', text: label }), [['background-color', 'headerBg'], ['color', 'headerText']]),
    h('span', { class: 'body' },
      paint(h('span', { text: 'Texto' }), [['color', 'text']]),
      paint(h('span', { text: 'Enlace' }), [['color', 'accent']]))), [['background-color', 'bg'], ['border-color', 'border']]);
}

function palettePicker(palettes, selected) {
  return h('fieldset', { class: 'palettes' },
    h('legend', { text: 'Paleta de colores' }),
    palettes.map((p) => h('label', { class: 'palette' },
      h('span', { class: 'title' },
        h('input', { type: 'radio', name: 'palette', value: p.id, checked: p.id === selected }),
        p.name, p.custom ? h('span', { class: 'badge', text: 'Exclusiva' }) : null),
      h('span', { class: 'swatches' }, swatch('Claro', p.light), swatch('Oscuro', p.dark)))));
}

export async function renderSettings(root, layout) {
  const { settings, palettes } = await api('/api/settings');
  const msg = h('div', { class: 'messages' });
  const siteName = h('input', { value: settings.siteName, required: true, maxLength: 120 });
  const siteDescription = h('input', { value: settings.siteDescription, maxLength: 300 });
  const picker = palettePicker(palettes, settings.sitePalette);
  const save = h('button', { type: 'submit', class: 'primary', text: 'Guardar' });
  const form = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    const sitePalette = picker.querySelector('input[name=palette]:checked')?.value ?? settings.sitePalette;
    const data = await run(save, msg, () => api('/api/settings', { method: 'PATCH', body: { siteName: siteName.value, siteDescription: siteDescription.value, sitePalette } }), errorMessage);
    if (data) msg.append(notice('ok', 'Configuración guardada. El sitio público ya la muestra.'));
  } },
  h('h2', { text: 'Sitio público' }), msg,
  h('label', {}, 'Nombre del sitio', siteName),
  h('label', {}, 'Descripción', siteDescription),
  h('p', { class: 'muted small', text: 'Texto plano: el sitio lo muestra tal cual, sin interpretar HTML.' }),
  picker,
  h('p', { class: 'muted small', text: 'Cada paleta tiene un modo claro y uno oscuro, con el contraste mínimo de accesibilidad comprobado. Los visitantes eligen el modo en la cabecera del sitio; si no eligen, se usa el de su dispositivo.' }),
  save);
  mount(root, ...page(layout, 'settings', form));
}

// --- Auditoría ----------------------------------------------------------------

const OUTCOMES = { success: 'Correcto', failure: 'Fallo', denied: 'Denegado' };

function detailsText(d) {
  const text = JSON.stringify(d);
  return text === '{}' ? '' : text;
}

export async function renderAudit(root, layout) {
  const msg = h('div', { class: 'messages' });
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const action = h('input', { placeholder: 'p. ej. auth.login o backup.', maxLength: 64, pattern: '[a-z0-9_.]+' });
  const outcome = h('select', {}, h('option', { value: '', text: 'Todos' }), Object.entries(OUTCOMES).map(([v, t]) => h('option', { value: v, text: t })));
  const actor = h('input', { type: 'number', min: 1, placeholder: 'id' });
  const body = h('tbody');
  const more = h('button', { type: 'button', text: 'Cargar más', hidden: true });
  let before = null;

  const query = () => {
    const q = new URLSearchParams();
    if (from.value) q.set('from', from.value);
    if (to.value) q.set('to', to.value);
    if (action.value.trim()) q.set('action', action.value.trim());
    if (outcome.value) q.set('outcome', outcome.value);
    if (actor.value) q.set('actor', actor.value);
    if (before) q.set('before', String(before));
    q.set('limit', '50');
    return q;
  };

  async function load(reset) {
    if (reset) {
      before = null;
      body.replaceChildren();
    }
    const data = await run(more, msg, () => api(`/api/audit?${query()}`), errorMessage);
    if (!data) return;
    for (const e of data.entries) {
      body.append(h('tr', {},
        h('td', { class: 'mono', text: String(e.id) }),
        h('td', { text: formatDate(e.occurredAt) }),
        h('td', { text: e.actor ? `${e.actor.username} (${e.actor.id})` : 'sistema' }),
        h('td', { class: 'mono', text: e.action }),
        h('td', {}, h('span', { class: `badge badge-outcome-${e.outcome}`, text: OUTCOMES[e.outcome] })),
        h('td', { class: 'mono small', text: [e.entityType, e.entityId].filter((x) => x !== null).join(' ') || '—' }),
        h('td', { class: 'mono small', text: e.ip ?? '—' }),
        h('td', { class: 'mono small details', text: detailsText(e.details) })));
    }
    if (!body.children.length) body.append(h('tr', {}, h('td', { colSpan: 8, text: 'Sin resultados.' })));
    before = data.nextBefore;
    more.hidden = !before;
  }
  more.addEventListener('click', () => load(false));

  const filters = h('form', { class: 'card filters', onSubmit: (e) => {
    e.preventDefault();
    load(true);
  } },
  h('div', { class: 'cols' },
    h('label', {}, 'Desde', from), h('label', {}, 'Hasta', to), h('label', {}, 'Acción', action),
    h('label', {}, 'Resultado', outcome), h('label', {}, 'Autor (id)', actor)),
  h('button', { type: 'submit', class: 'primary', text: 'Filtrar' }));

  const verifyMsg = h('div', { class: 'messages' });
  const verify = h('button', { type: 'button', text: 'Verificar la integridad', onClick: async () => {
    const r = await run(verify, verifyMsg, () => api('/api/audit/verify'), errorMessage);
    if (!r) return;
    if (r.ok) {
      verifyMsg.append(notice('ok', `Cadena íntegra: ${r.checked} entradas comprobadas${r.unchained ? `, ${r.unchained} sin encadenar todavía` : ''}. Coincide con las copias de seguridad.`));
    } else {
      const p = r.problems[0];
      const why = { hash_mismatch: 'la entrada o una anterior se modificó', gap: 'hay entradas sin huella antes de otras encadenadas', anchor_mismatch: `no coincide con la copia ${p.source}`, anchor_missing: `falta una entrada que registró la copia ${p.source}` }[p.reason] ?? p.reason;
      verifyMsg.append(notice('error', `La auditoría NO supera la verificación en la entrada ${p.id}: ${why}.`));
    }
  } });

  mount(root, ...page(layout, 'audit',
    h('p', { class: 'muted', text: 'Registro de solo lectura: no se puede modificar ni borrar desde el panel.' }),
    h('div', { class: 'actions' }, verify), verifyMsg,
    filters, msg,
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid audit' },
      h('thead', {}, h('tr', {}, ['Id', 'Fecha', 'Autor', 'Acción', 'Resultado', 'Entidad', 'IP', 'Detalles'].map((t) => h('th', { text: t })))),
      body)),
    h('div', { class: 'actions' }, more)));
  await load(true);
}

// --- Copias de seguridad ------------------------------------------------------

const KINDS = { manual: 'Manual', automatic: 'Automática', pre_restore: 'Antes de restaurar' };

export async function renderBackups(root, layout) {
  const { backups, schedule, running } = await api('/api/backups');
  const reload = () => renderBackups(root, layout);
  const msg = h('div', { class: 'messages' });
  const create = h('button', { type: 'button', class: 'primary', text: 'Crear copia ahora', disabled: running, onClick: async () => {
    const data = await run(create, msg, () => api('/api/backups', { method: 'POST' }), errorMessage);
    if (data) reload();
  } });

  const rows = backups.map((b) => {
    if (b.broken) {
      return h('tr', {}, h('td', { class: 'mono', text: b.id }), h('td', { colSpan: 5 }, notice('error', 'Manifiesto ilegible: la copia está dañada.')));
    }
    const rowMsg = h('div', { class: 'messages' });
    const verify = h('button', { type: 'button', text: 'Verificar', onClick: async () => {
      const r = await run(verify, rowMsg, () => api(`/api/backups/${b.id}/verify`, { method: 'POST' }), errorMessage);
      if (r) rowMsg.append(r.ok ? notice('ok', 'Correcta.') : notice('error', `No supera la verificación: ${r.issues.map((i) => i.code + (i.path ? ` (${i.path})` : '')).join(', ')}.`));
    } });
    const remove = h('button', { type: 'button', class: 'danger', text: 'Eliminar', onClick: async () => {
      if (!window.confirm(`¿Eliminar definitivamente la copia ${b.id}?`)) return;
      if (await run(remove, rowMsg, () => api(`/api/backups/${b.id}`, { method: 'DELETE' }), errorMessage) !== undefined) reload();
    } });
    return h('tr', {},
      h('td', { class: 'mono', text: b.id }),
      h('td', { text: formatDate(b.createdAt) }),
      h('td', { text: KINDS[b.kind] ?? b.kind }),
      h('td', { text: `${formatBytes(b.sizeBytes)} · ${b.mediaCount} archivos · esquema ${b.schemaVersion}` }),
      h('td', {}, b.warnings.length ? h('span', { class: 'badge badge-warning', text: `${b.warnings.length} avisos` }) : '—'),
      h('td', {}, h('div', { class: 'actions' }, verify, remove), rowMsg));
  });

  mount(root, ...page(layout, 'backups',
    h('section', { class: 'card' },
      h('p', {}, schedule.intervalHours
        ? `Copias automáticas cada ${schedule.intervalHours} h; se conservan las ${schedule.keep} más recientes. Las manuales no se borran solas.`
        : 'Las copias automáticas están desactivadas (BACKUP_INTERVAL_HOURS=0).'),
      h('p', { class: 'muted small', text: 'Cada copia incluye la base de datos (copia coherente), los archivos multimedia y privados, y un manifiesto con la huella de cada archivo. Se guardan en el servidor: cópialas también a otro lugar.' }),
      h('div', { class: 'actions' }, create), msg),
    backups.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Id', 'Fecha', 'Tipo', 'Contenido', 'Avisos', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows)))
      : notice('info', 'Todavía no hay copias.'),
    h('section', { class: 'card' },
      h('h2', { text: 'Restaurar' }),
      h('p', { text: 'Por seguridad, la restauración no se hace desde el panel. Con el servidor detenido, ejecuta en el servidor:' }),
      h('pre', { class: 'mono', text: 'npm run backup:restore -- <id> --confirm' }),
      h('p', { class: 'muted small', text: 'La orden verifica la copia, guarda antes una copia del estado actual, sustituye la base y los archivos, aplica las migraciones pendientes y cierra todas las sesiones.' }))));
}

// --- Purga de archivos --------------------------------------------------------

export async function renderPurge(root, layout) {
  const data = await api('/api/media/purge');
  const reload = () => renderPurge(root, layout);
  const msg = h('div', { class: 'messages' });
  const total = data.deleted.length + data.orphans.length + data.temporary.length;
  const bytes = [...data.deleted, ...data.orphans, ...data.temporary].reduce((n, x) => n + x.sizeBytes, 0);
  const purge = h('button', { type: 'button', class: 'danger', text: `Purgar ${total} archivos`, disabled: !total, onClick: async () => {
    if (!window.confirm(`Se borrarán definitivamente ${total} archivos (${formatBytes(bytes)}) del servidor. Las copias de seguridad ya hechas los conservan. ¿Continuar?`)) return;
    const r = await run(purge, msg, () => api('/api/media/purge', { method: 'POST', body: {
      mediaIds: data.deleted.map((m) => m.id), orphans: data.orphans.map((o) => o.name), temporary: data.temporary.map((t) => t.name),
    } }), errorMessage);
    if (r) {
      await reload();
      root.querySelector('.messages')?.append(notice(r.failed.length ? 'error' : 'ok',
        r.failed.length ? `No se pudieron borrar ${r.failed.length} archivos; aparecerán en la próxima purga.` : 'Purga completada.'));
    }
  } });
  const list = (title, items, describe) => h('section', { class: 'card' }, h('h2', { text: `${title} (${items.length})` }),
    items.length ? h('ul', { class: 'plain' }, items.map((x) => h('li', { text: describe(x) }))) : h('p', { class: 'muted', text: 'Ninguno.' }));

  mount(root, ...page(layout, 'purge',
    h('p', { class: 'muted', text: 'Solo se purgan archivos eliminados que no usa ninguna versión de ningún contenido (tampoco antiguas), archivos sin registro y temporales con más de una hora. Los que siguen en uso nunca aparecen aquí.' }),
    msg,
    list('Archivos eliminados sin uso', data.deleted, (m) => `${m.originalName} · ${formatBytes(m.sizeBytes)} · eliminado ${formatDate(m.deletedAt)}`),
    list('Archivos sin registro', data.orphans, (o) => `${o.name} · ${formatBytes(o.sizeBytes)} · ${formatDate(o.modifiedAt)}`),
    list('Temporales', data.temporary, (t) => `${t.name} · ${formatBytes(t.sizeBytes)} · ${formatDate(t.modifiedAt)}`),
    h('div', { class: 'actions' }, purge)));
}
