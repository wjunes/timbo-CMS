/**
 * Estado de la sesión en el panel (en memoria) y ayudas de permisos.
 *
 * Los permisos solo sirven para mostrar u ocultar acciones: el backend
 * vuelve a comprobarlos en cada petición.
 */
export const state = { user: null, access: null };

export const isGeneralAdmin = () => state.user?.role === 'general_admin';

/** ¿Tiene el permiso `code` en la sección? (informativo) */
export function can(code, sectionId) {
  if (isGeneralAdmin()) return true;
  const section = state.access?.sections?.find((s) => s.id === sectionId);
  return Boolean(section?.permissions.includes(code));
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
