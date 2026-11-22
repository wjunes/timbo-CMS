/**
 * Usuarios y permisos (Bloque 10, D-045; solo administración general).
 *
 * Alta de administradores de sección, edición, suspensión, reactivación, baja,
 * contraseña temporal, revocación de sesiones y asignación de secciones con
 * sus permisos. Todo lo comprueba el backend: aquí solo se muestran acciones.
 */
import { api, errorMessage } from './api.js';
import { formatDate, h, mount, notice, run } from './dom.js';
import { navigate } from './state.js';

export const USER_STATUS = { active: 'Activo', suspended: 'Suspendido', disabled: 'Desactivado' };
const userBadge = (status) => h('span', { class: `badge badge-user-${status}`, text: USER_STATUS[status] ?? status });

function passwordHint() {
  return h('p', { class: 'muted small', text: 'Contraseña temporal: mínimo 12 caracteres. El usuario deberá cambiarla al entrar. Comunícala por un canal seguro; no se vuelve a mostrar.' });
}

export async function renderUsers(root, layout) {
  const { users } = await api('/api/users');
  const msg = h('div', { class: 'messages' });
  const username = h('input', { required: true, minLength: 3, maxLength: 64, pattern: '[A-Za-z0-9._\\-]+', autocomplete: 'off' });
  const email = h('input', { type: 'email', required: true, maxLength: 254, autocomplete: 'off' });
  const displayName = h('input', { required: true, maxLength: 120, autocomplete: 'off' });
  const temporaryPassword = h('input', { type: 'password', required: true, minLength: 12, autocomplete: 'new-password' });
  const submit = h('button', { type: 'submit', class: 'primary', text: 'Crear administrador de sección' });
  const form = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    const data = await run(submit, msg, () => api('/api/users', { method: 'POST', body: {
      username: username.value, email: email.value, displayName: displayName.value, temporaryPassword: temporaryPassword.value,
    } }), errorMessage);
    temporaryPassword.value = '';
    if (data) navigate(`#/users/${data.user.id}`);
  } },
  h('h2', { text: 'Nuevo administrador de sección' }), msg,
  h('div', { class: 'cols' },
    h('label', {}, 'Usuario', username),
    h('label', {}, 'Nombre visible', displayName),
    h('label', {}, 'Correo electrónico', email),
    h('label', {}, 'Contraseña temporal', temporaryPassword)),
  passwordHint(), submit);

  const table = h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, ['Usuario', 'Nombre', 'Rol', 'Estado', 'Secciones', 'Alta'].map((t) => h('th', { text: t })))),
    h('tbody', {}, users.map((u) => h('tr', {},
      h('td', {}, h('a', { href: `#/users/${u.id}`, text: u.username })),
      h('td', { text: u.displayName }),
      h('td', { text: u.role === 'general_admin' ? 'Administración general' : 'Administración de sección' }),
      h('td', {}, userBadge(u.status), u.mustChangePassword ? h('span', { class: 'muted small', text: ' · contraseña temporal' }) : null),
      h('td', { text: u.role === 'general_admin' ? 'Todas' : String(u.sections.length) }),
      h('td', { text: formatDate(u.createdAt) })))));

  mount(root, ...layout(h('h1', { text: 'Usuarios' }), table, form));
}

export async function renderUser(root, layout, userId) {
  const [{ user }, { permissions: catalog }, { sections }] = await Promise.all([
    api(`/api/users/${userId}`), api('/api/permissions'), api('/api/sections'),
  ]);
  const reload = () => renderUser(root, layout, userId);
  const heading = h('div', { class: 'heading' },
    h('p', { class: 'crumbs' }, h('a', { href: '#/users', text: 'Usuarios' }), ' / ', user.username),
    h('h1', {}, user.displayName, ' ', userBadge(user.status)),
    h('p', { class: 'muted', text: `${user.email} · alta ${formatDate(user.createdAt)}${user.mustChangePassword ? ' · contraseña temporal pendiente de cambio' : ''}` }));

  if (user.role === 'general_admin') {
    mount(root, ...layout(heading, notice('info', 'La cuenta de administración general no se gestiona desde aquí: se administra con las herramientas de línea de órdenes (npm run admin:reset-password).')));
    return;
  }
  const disabled = user.status === 'disabled';

  // Perfil
  const profileMsg = h('div', { class: 'messages' });
  const displayName = h('input', { value: user.displayName, required: true, maxLength: 120, disabled });
  const email = h('input', { type: 'email', value: user.email, required: true, maxLength: 254, disabled });
  const saveProfile = h('button', { type: 'submit', class: 'primary', text: 'Guardar', disabled });
  const profile = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    if (await run(saveProfile, profileMsg, () => api(`/api/users/${user.id}`, { method: 'PATCH', body: { displayName: displayName.value, email: email.value } }), errorMessage)) reload();
  } }, h('h2', { text: 'Datos' }), profileMsg, h('div', { class: 'cols' }, h('label', {}, 'Nombre visible', displayName), h('label', {}, 'Correo electrónico', email)), saveProfile);

  // Estado, sesiones y contraseña
  const accountMsg = h('div', { class: 'messages' });
  const action = (label, path, { danger = false, confirm } = {}) => {
    const b = h('button', { type: 'button', class: danger ? 'danger' : '', text: label, onClick: async () => {
      if (confirm && !window.confirm(confirm)) return;
      const data = await run(b, accountMsg, () => api(`/api/users/${user.id}/${path}`, { method: 'POST' }), errorMessage);
      if (!data) return;
      // Cerrar sesiones no cambia la cuenta: basta con informar.
      if (path === 'sessions/revoke') accountMsg.append(notice('ok', `Sesiones revocadas: ${data.revokedCount}.`));
      else reload();
    } });
    return b;
  };
  const temporaryPassword = h('input', { type: 'password', required: true, minLength: 12, autocomplete: 'new-password', disabled,
    'aria-label': 'Contraseña temporal nueva', placeholder: 'Contraseña temporal nueva' });
  const resetButton = h('button', { type: 'submit', text: 'Asignar contraseña temporal', disabled });
  const account = h('section', { class: 'card' }, h('h2', { text: 'Cuenta' }), accountMsg,
    h('div', { class: 'actions' },
      user.status === 'active' ? action('Suspender', 'suspend', { confirm: '¿Suspender la cuenta? Se cerrarán sus sesiones.' }) : null,
      user.status === 'suspended' ? action('Reactivar', 'reactivate') : null,
      !disabled ? action('Cerrar todas sus sesiones', 'sessions/revoke') : null,
      !disabled ? action('Desactivar definitivamente', 'disable', { danger: true, confirm: 'La desactivación es definitiva: la cuenta no podrá volver a usarse. ¿Continuar?' }) : null),
    disabled ? notice('info', 'Cuenta desactivada: es definitiva y no admite cambios.') : h('form', { class: 'inline-form', onSubmit: async (e) => {
      e.preventDefault();
      const data = await run(resetButton, accountMsg, () => api(`/api/users/${user.id}/password`, { method: 'POST', body: { temporaryPassword: temporaryPassword.value } }), errorMessage);
      temporaryPassword.value = '';
      if (data) accountMsg.append(notice('ok', `Contraseña temporal asignada. Sesiones revocadas: ${data.revokedCount}.`));
    } }, temporaryPassword, resetButton),
    disabled ? null : passwordHint());

  // Secciones y permisos
  const accessMsg = h('div', { class: 'messages' });
  const assignedIds = new Set(user.sections.map((s) => s.id));
  const rows = user.sections.map((s) => {
    const boxes = catalog.map((p) => h('input', { type: 'checkbox', value: p.code, checked: s.permissions.includes(p.code), disabled }));
    const save = h('button', { type: 'button', class: 'primary', text: 'Guardar permisos', disabled, onClick: async () => {
      const wanted = boxes.filter((b) => b.checked).map((b) => b.value);
      if (await run(save, accessMsg, () => api(`/api/users/${user.id}/sections/${s.id}/permissions`, { method: 'PUT', body: { permissions: wanted } }), errorMessage)) {
        accessMsg.append(notice('ok', `Permisos de «${s.name}» guardados.`));
      }
    } });
    const remove = h('button', { type: 'button', class: 'danger', text: 'Retirar sección', onClick: async () => {
      if (!window.confirm(`¿Retirar «${s.name}» y todos sus permisos?`)) return;
      if (await run(remove, accessMsg, () => api(`/api/users/${user.id}/sections/${s.id}`, { method: 'DELETE' }), errorMessage) !== undefined) reload();
    } });
    return h('fieldset', { class: 'perm-set' },
      h('legend', {}, s.name, ' ', h('span', { class: 'muted small', text: s.status === 'active' ? '' : `(${s.status})` })),
      h('div', { class: 'perm-grid' }, catalog.map((p, i) => h('label', { class: 'check', title: p.code }, boxes[i], p.description))),
      h('div', { class: 'actions' }, save, remove));
  });
  const available = sections.filter((s) => !assignedIds.has(s.id) && s.status !== 'archived');
  const pick = h('select', { 'aria-label': 'Sección para asignar', disabled }, available.map((s) => h('option', { value: s.id, text: `${'— '.repeat(s.depth - 1)}${s.name}` })));
  const assign = h('button', { type: 'button', text: 'Asignar sección', disabled: disabled || !available.length, onClick: async () => {
    if (await run(assign, accessMsg, () => api(`/api/users/${user.id}/sections/${pick.value}`, { method: 'PUT' }), errorMessage)) reload();
  } });
  const access = h('section', { class: 'card' }, h('h2', { text: 'Secciones y permisos' }), accessMsg,
    rows.length ? rows : notice('info', 'No tiene secciones asignadas.'),
    disabled ? null : h('div', { class: 'actions' }, pick, assign),
    h('p', { class: 'muted small', text: 'Una sección asignada sin permisos solo permite consultarla.' }));

  mount(root, ...layout(heading, profile, account, access));
}
