/**
 * Panel de administración (Bloque 08): arranque, sesión, navegación y vistas
 * generales (acceso, cambio de contraseña, secciones y cola de revisión).
 * Bloque 10: usuarios, administración de secciones y sistema (D-045).
 *
 * Aplicación de una página sin frameworks. La navegación usa el fragmento
 * (#/…) para que el servidor solo sirva index.html.
 */
import { ApiError, api, errorMessage, onAuthProblem, setCsrfToken } from './api.js';
import { renderContent } from './content.js';
import { badge, formatDate, h, mount, notice, run } from './dom.js';
import { renderEditor } from './editor.js';
import { renderLibrary } from './media.js';
import { renderSection } from './section.js';
import { newSectionForm, renderSectionSettings } from './section-admin.js';
import { renderAudit, renderBackups, renderPurge, renderSettings } from './system.js';
import { renderUser, renderUsers } from './users.js';
import { isGeneralAdmin, navigate, state } from './state.js';

const root = document.getElementById('app');

/**
 * Modo de color del panel (Bloque 12, D-071): 'light' o 'dark' fijan el atributo
 * data-mode de <html>; 'auto' lo quita y se sigue el modo del sistema.
 */
function applyMode(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.mode = mode;
  else delete document.documentElement.dataset.mode;
}

function applySession(data) {
  state.user = data.user;
  state.access = data.access;
  setCsrfToken(data.csrfToken);
  applyMode(data.user.uiMode);
}

function clearSession() {
  state.user = null;
  state.access = null;
  setCsrfToken(null);
  applyMode('auto');
}

const UI_MODES = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']];

function modeSelect() {
  const select = h('select', { class: 'mode', 'aria-label': 'Modo de color del panel', onChange: async () => {
    const previous = state.user.uiMode;
    applyMode(select.value);
    try {
      const { user } = await api('/api/auth/preferences', { method: 'PUT', body: { uiMode: select.value } });
      state.user = { ...state.user, uiMode: user.uiMode };
    } catch {
      // No se pudo guardar: se vuelve al modo anterior para no mostrar algo que no se conservará.
      select.value = previous;
      applyMode(previous);
    }
  } }, UI_MODES.map(([value, label]) => h('option', { value, text: `Modo: ${label}` })));
  select.value = state.user.uiMode ?? 'auto';
  return select;
}

onAuthProblem((err) => {
  if (err.status === 401) {
    clearSession();
    navigate('#/login');
  } else if (err.code === 'password_change_required') {
    navigate('#/password');
  }
});

// --- Diseño -------------------------------------------------------------------

function layout(...content) {
  const nav = h('nav', { class: 'topnav', 'aria-label': 'Principal' },
    h('a', { href: '#/sections', text: 'Secciones' }),
    isGeneralAdmin() ? h('a', { href: '#/reviews', text: 'Revisión' }) : null,
    isGeneralAdmin() ? h('a', { href: '#/users', text: 'Usuarios' }) : null,
    isGeneralAdmin() ? h('a', { href: '#/system/settings', text: 'Sistema' }) : null,
    h('a', { href: '#/password', text: 'Contraseña' }),
    modeSelect(),
    h('button', { type: 'button', class: 'link', text: 'Salir', onClick: logout }));
  return [
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/sections', text: 'CMS-MULTISECCIÓN' }),
      h('span', { class: 'who', text: `${state.user.displayName} · ${isGeneralAdmin() ? 'Administración general' : 'Administración de sección'}` }),
      nav),
    h('main', { class: 'page' }, ...content),
  ];
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // La sesión puede haber caducado ya; se sale igualmente.
  }
  clearSession();
  navigate('#/login');
}

// --- Acceso -------------------------------------------------------------------

function renderLogin() {
  const msg = h('div', { class: 'messages' });
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, maxLength: 64 });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxLength: 1024 });
  const submit = h('button', { type: 'submit', class: 'primary', text: 'Entrar' });
  const form = h('form', { class: 'card narrow', onSubmit: async (e) => {
    e.preventDefault();
    const data = await run(submit, msg, () => api('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } }), errorMessage);
    password.value = '';
    if (data) {
      applySession(data);
      navigate(data.user.mustChangePassword ? '#/password' : '#/sections');
    }
  } },
  h('h1', { text: 'Acceso al panel' }), msg,
  h('label', {}, 'Usuario', username),
  h('label', {}, 'Contraseña', password),
  submit);
  mount(root, h('main', { class: 'page center' }, form));
  username.focus();
}

function renderPassword() {
  const forced = state.user.mustChangePassword;
  const msg = h('div', { class: 'messages' });
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12 });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const submit = h('button', { type: 'submit', class: 'primary', text: 'Cambiar contraseña' });
  const form = h('form', { class: 'card narrow', onSubmit: async (e) => {
    e.preventDefault();
    msg.replaceChildren();
    if (next.value !== repeat.value) {
      msg.append(notice('error', 'Las contraseñas nuevas no coinciden.'));
      return;
    }
    const done = await run(submit, msg, () => api('/api/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } }), errorMessage);
    current.value = next.value = repeat.value = '';
    if (done) {
      state.user = { ...state.user, mustChangePassword: false };
      if (forced) navigate('#/sections');
      else msg.append(notice('ok', 'Contraseña cambiada. Se cerraron tus otras sesiones.'));
    }
  } },
  h('h1', { text: 'Cambiar contraseña' }),
  forced ? notice('info', 'Tu contraseña es temporal: cámbiala para continuar.') : null,
  msg,
  h('label', {}, 'Contraseña actual', current),
  h('label', {}, 'Contraseña nueva', next),
  h('label', {}, 'Repite la contraseña nueva', repeat),
  submit);
  if (forced) {
    mount(root, h('main', { class: 'page center' }, form, h('button', { type: 'button', class: 'link', text: 'Salir', onClick: logout })));
  } else {
    mount(root, ...layout(form));
  }
}

// --- Secciones y revisión -----------------------------------------------------

async function renderSections() {
  const { sections } = await api('/api/sections');
  const rows = sections.map((s) => h('tr', {},
    h('td', { class: `depth-${s.depth}` }, h('a', { href: `#/sections/${s.id}`, text: s.name }),
      isGeneralAdmin() ? [' ', h('a', { class: 'small', href: `#/sections/${s.id}/settings`, text: 'Configurar' })] : null),
    h('td', { class: 'mono', text: s.path }),
    h('td', { text: s.workflow === 'approval' ? 'Con aprobación' : 'Directa' }),
    h('td', {}, badge(s.status))));
  mount(root, ...layout(
    h('h1', { text: 'Secciones' }),
    sections.length
      ? h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { text: 'Nombre' }), h('th', { text: 'Ruta' }), h('th', { text: 'Publicación' }), h('th', { text: 'Estado' }))), h('tbody', {}, rows))
      : notice('info', 'No tienes secciones asignadas.'),
    isGeneralAdmin() ? await newSectionForm(sections) : null));
}

async function renderReviews() {
  const { pending } = await api('/api/reviews/pending');
  mount(root, ...layout(
    h('h1', { text: 'Pendientes de revisión' }),
    pending.length
      ? h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Sección' }), h('th', { text: 'Título' }), h('th', { text: 'Versión' }), h('th', { text: 'Enviada por' }), h('th', { text: 'Fecha' }))),
        h('tbody', {}, pending.map((p) => h('tr', {},
          h('td', { text: p.section.name }),
          h('td', {}, h('a', { href: `#/contents/${p.content.id}`, text: p.version.title })),
          h('td', { text: `v${p.version.versionNumber}` }),
          h('td', { text: p.version.submittedBy.displayName }),
          h('td', { text: formatDate(p.version.submittedAt) })))))
      : notice('info', 'No hay versiones pendientes.')));
}

// --- Navegación ---------------------------------------------------------------

const ROUTES = [
  [/^#\/sections$/, () => renderSections()],
  [/^#\/sections\/(\d+)$/, (m) => renderSection(root, layout, Number(m[1]))],
  [/^#\/sections\/(\d+)\/media$/, (m) => renderLibrary(root, layout, Number(m[1]))],
  [/^#\/sections\/(\d+)\/settings$/, (m) => renderSectionSettings(root, layout, Number(m[1]))],
  [/^#\/users$/, () => renderUsers(root, layout)],
  [/^#\/users\/(\d+)$/, (m) => renderUser(root, layout, Number(m[1]))],
  [/^#\/system\/settings$/, () => renderSettings(root, layout)],
  [/^#\/system\/audit$/, () => renderAudit(root, layout)],
  [/^#\/system\/backups$/, () => renderBackups(root, layout)],
  [/^#\/system\/purge$/, () => renderPurge(root, layout)],
  [/^#\/contents\/(\d+)$/, (m) => renderContent(root, layout, Number(m[1]))],
  [/^#\/contents\/(\d+)\/versions\/(\d+)\/edit$/, (m) => renderEditor(root, layout, Number(m[1]), Number(m[2]))],
  [/^#\/reviews$/, () => renderReviews()],
  [/^#\/password$/, () => renderPassword()],
];

async function route() {
  const hash = location.hash || '#/sections';
  if (!state.user) {
    renderLogin();
    return;
  }
  if (hash === '#/login') return navigate('#/sections');
  if (state.user.mustChangePassword && hash !== '#/password') return navigate('#/password');
  const found = ROUTES.find(([re]) => re.test(hash));
  if (!found) return navigate('#/sections');
  try {
    await found[1](hash.match(found[0]));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.code === 'password_change_required')) return;
    mount(root, ...layout(notice('error', errorMessage(err))));
  }
}

async function start() {
  try {
    applySession(await api('/api/auth/session'));
  } catch {
    clearSession();
  }
  window.addEventListener('hashchange', route);
  await route();
}

start();
