/**
 * Utilidades HTTP sin dependencias: errores, cookies, cuerpo JSON, IP del cliente
 * y validación de origen (primera capa de la protección CSRF).
 */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code Código estable y genérico que se envía al cliente.
   * @param {Record<string, string>} [headers]
   * @param {Record<string, unknown>} [details] Información adicional segura para el cliente (p. ej. campos inválidos).
   */
  constructor(status, code, headers = {}, details = undefined) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.details = details;
  }
}

export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

const COOKIE_NAME = /^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/;
const COOKIE_VALUE = /^[A-Za-z0-9_!#$%&'()*+./:<=>?@[\]^`{|}~-]*$/;
const MAX_COOKIES = 50;

/** @returns {Map<string, string>} Primera aparición de cada nombre; ignora entradas mal formadas. */
export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || header.length > 8192) return cookies;
  for (const part of header.split(';').slice(0, MAX_COOKIES)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (COOKIE_NAME.test(name) && COOKIE_VALUE.test(value) && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, httpOnly?: boolean, secure?: boolean, sameSite?: 'Strict'|'Lax', path?: string }} opts
 */
export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = true, sameSite = 'Strict', path = '/' } = {}) {
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) throw new TypeError('Cookie inválida');
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Cuerpo JSON
// ---------------------------------------------------------------------------

export const DEFAULT_BODY_LIMIT = 16 * 1024;

/**
 * Lee un cuerpo `application/json` con límite de tamaño. Debe ser un objeto JSON.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');

  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) throw new HttpError(413, 'payload_too_large');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body');
  return body;
}

// ---------------------------------------------------------------------------
// IP del cliente
// ---------------------------------------------------------------------------

/**
 * Con `trustProxy`, toma la entrada más a la derecha de X-Forwarded-For (la que
 * añadió nuestro proxy). Sin él, la cabecera se ignora: el cliente podría falsificarla.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length <= 1024) {
      const last = xff.split(',').pop().trim();
      if (/^[0-9A-Fa-f.:]{2,45}$/.test(last)) return last;
    }
  }
  return req.socket.remoteAddress ?? null;
}

// ---------------------------------------------------------------------------
// Origen (CSRF, capa 1)
// ---------------------------------------------------------------------------

/**
 * Para métodos que modifican estado exige que la petición provenga del propio sitio:
 * `Origin` igual al origen de APP_BASE_URL o, si el navegador no envía Origin,
 * `Sec-Fetch-Site: same-origin`. Sin ninguna de las dos, se rechaza.
 */
export function isSameOriginRequest(req, expectedOrigin) {
  const origin = req.headers.origin;
  if (origin !== undefined) return origin === expectedOrigin;
  return req.headers['sec-fetch-site'] === 'same-origin';
}
