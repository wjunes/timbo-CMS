/**
 * Cliente de la API del panel.
 *
 * - La sesión es la cookie HttpOnly que gestiona el navegador: el código no la ve.
 * - El token CSRF se guarda solo en memoria (esta variable), nunca en
 *   localStorage ni sessionStorage. Al recargar se vuelve a pedir con
 *   GET /api/auth/session.
 * - Todo error de la API se convierte en ApiError con su código estable.
 */

let csrfToken = null;
const listeners = new Set();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `http_${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error ?? `http_${status}`;
    this.body = body ?? {};
  }
}

export function setCsrfToken(token) {
  csrfToken = token;
}

/** Aviso de sesión perdida (401) o de cambio de contraseña obligatorio. */
export function onAuthProblem(fn) {
  listeners.add(fn);
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, file?: File, headers?: Record<string, string> }} [options]
 */
export async function api(path, { method = 'GET', body, file, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) h['X-CSRF-Token'] = csrfToken;
  let payload;
  if (file) {
    payload = file;
    h['Content-Type'] = file.type || 'application/octet-stream';
    h['X-File-Name'] = encodeURIComponent(file.name);
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers: h, body: payload, credentials: 'same-origin', cache: 'no-store' });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 || err.code === 'password_change_required') listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

/** Mensajes para los códigos de error de la API. */
const MESSAGES = {
  invalid_credentials: 'Usuario o contraseña incorrectos.',
  too_many_attempts: 'Demasiados intentos. Espera unos minutos.',
  unauthenticated: 'La sesión ha terminado. Vuelve a iniciar sesión.',
  forbidden: 'No tienes permiso para esta acción.',
  not_found: 'No encontrado (o no tienes acceso).',
  validation_failed: 'Hay datos no válidos.',
  invalid_current_password: 'La contraseña actual no es correcta.',
  revision_conflict: 'Otra persona guardó cambios en este borrador. Recarga para ver la versión actual.',
  version_not_editable: 'Esta versión ya no es un borrador.',
  open_version_exists: 'Ya hay una versión en curso para este contenido.',
  slug_taken: 'Ese identificador (slug) ya está en uso en la sección.',
  section_archived: 'La sección está archivada: es de solo lectura.',
  content_not_editable: 'El contenido está archivado. Restáuralo para editarlo.',
  approval_required: 'En esta sección hay que enviar a revisión y esperar la aprobación.',
  review_not_required: 'Esta sección publica directamente, sin revisión.',
  invalid_transition: 'La acción no es posible en el estado actual.',
  state_changed: 'El estado cambió mientras tanto. Recarga e inténtalo de nuevo.',
  body_invalid: 'El cuerpo guardado contiene elementos no admitidos.',
  content_in_review: 'Hay una versión en revisión o aprobada: resuélvela antes.',
  content_published: 'Despublica el contenido antes de eliminarlo.',
  content_not_published: 'El contenido no está publicado.',
  only_version: 'Es la única versión: elimina el contenido en su lugar.',
  media_in_use: 'El archivo se usa en contenidos y no se puede eliminar.',
  media_not_available: 'Un archivo del cuerpo ya no está disponible en la biblioteca.',
  media_not_image: 'Ese archivo no es una imagen.',
  unsupported_media_type: 'Tipo de archivo no admitido. Se admiten PNG, JPEG, WebP y PDF.',
  payload_too_large: 'El archivo supera el tamaño máximo.',
  file_rejected: 'El archivo no es válido.',
  uploads_busy: 'Hay demasiadas subidas en curso. Inténtalo en unos segundos.',
  forbidden_origin: 'Petición rechazada por seguridad (origen).',
  invalid_csrf_token: 'La sesión no es válida. Recarga la página.',
  password_change_required: 'Debes cambiar tu contraseña antes de continuar.',
  // Bloque 10: usuarios, secciones y sistema
  username_or_email_taken: 'Ese usuario o correo ya existe.',
  target_protected: 'La cuenta de administración general no se gestiona desde el panel.',
  invalid_status_transition: 'El cambio de estado no es posible desde el estado actual.',
  user_disabled: 'La cuenta está desactivada.',
  section_not_assigned: 'La sección no está asignada a este usuario.',
  assignment_not_found: 'La sección ya no estaba asignada.',
  section_not_found: 'La sección no existe.',
  pending_reviews_exist: 'Hay versiones en revisión: resuélvelas antes de pasar a publicación directa.',
  system_section_protected: 'Es una sección del sistema: no se puede archivar ni eliminar.',
  section_in_use: 'La sección tiene subsecciones, contenidos o archivos: no se puede eliminar.',
  order_mismatch: 'El orden cambió mientras tanto. Recarga e inténtalo de nuevo.',
  section_cycle: 'Una sección no puede colgar de sí misma ni de una subsección suya.',
  section_depth_exceeded: 'Se superaría la profundidad máxima (3 niveles).',
  parent_archived: 'La sección padre está archivada.',
  section_has_active_children: 'Tiene subsecciones activas: desactívalas o archívalas antes.',
  service_busy: 'El servidor está ocupado. Inténtalo en unos segundos.',
  backup_in_progress: 'Hay una copia de seguridad en curso. Inténtalo cuando termine.',
  backup_not_found: 'La copia de seguridad no existe.',
  purge_candidates_changed: 'La lista de archivos cambió mientras tanto. Recarga e inténtalo de nuevo.',
  internal_error: 'Error interno del servidor. Consulta el registro.',
  too_many_requests: 'Demasiadas peticiones seguidas. Espera un minuto e inténtalo de nuevo.',
};

const REJECT_REASONS = {
  content_mismatch: 'su contenido no corresponde al tipo indicado',
  file_corrupt: 'está dañado o tiene una estructura no válida',
  image_too_large: 'la imagen tiene demasiados píxeles',
  pdf_active_content: 'el PDF contiene contenido activo (JavaScript, adjuntos o formularios)',
  pdf_too_complex: 'el PDF es demasiado complejo para analizarlo',
};

const FIELD_CODES = {
  required: 'obligatorio', too_long: 'demasiado largo', too_short: 'demasiado corto', invalid_format: 'formato no válido',
  extension_mismatch: 'la extensión no corresponde al tipo', extension_required: 'falta la extensión',
  invalid_characters: 'caracteres no válidos', empty: 'vacío', policy: 'no cumple la política',
  media_not_available: 'un archivo ya no está disponible', media_not_image: 'el archivo no es una imagen',
  link_href_not_allowed: 'destino de enlace no permitido', link_href_invalid: 'destino de enlace no válido',
  reserved: 'reservado', not_found: 'no existe', invalid_value: 'valor no válido', invalid_type: 'tipo no válido', unknown_field: 'campo desconocido', empty_update: 'sin cambios',
};

/** Texto legible para un error (nunca HTML). */
export function errorMessage(err) {
  if (!(err instanceof ApiError)) return 'No se pudo conectar con el servidor.';
  let msg = MESSAGES[err.code] ?? `Error (${err.code}).`;
  if (err.code === 'file_rejected' && REJECT_REASONS[err.body.reason]) msg = `El archivo no es válido: ${REJECT_REASONS[err.body.reason]}.`;
  const fields = err.body.fields;
  if (fields) {
    const detail = Object.entries(fields).map(([f, c]) => `${f}: ${FIELD_CODES[c] ?? c}`).join('; ');
    msg += ` (${detail})`;
  }
  if (Array.isArray(err.body.policy)) msg += ` ${err.body.policy.join('. ')}.`;
  if (err.body.bodyPath) msg += ` Ubicación en el cuerpo: ${err.body.bodyPath}.`;
  return msg;
}
