/**
 * Construcción del servidor HTTP (sin arrancarlo).
 *
 * Separado de `server.js` para poder probarlo en integración escuchando en un
 * puerto efímero, sin efectos secundarios (señales, process.exit).
 *
 * Canal de cada petición:
 *   1. Cabeceras de seguridad (toda respuesta).
 *   2. Enrutado exacto por ruta y método (404 / 405).
 *   3. Métodos que modifican estado: el origen debe ser el propio sitio (CSRF, capa 1).
 *   4. Rutas autenticadas: sesión válida (401) y, si modifican estado,
 *      cabecera X-CSRF-Token ligada a la sesión (CSRF, capa 2).
 *   5. Contraseña temporal pendiente: solo rutas permitidas (403 password_change_required).
 *   6. Rol exigido por la ruta (403 forbidden, auditado).
 *   7. Manejador. Los errores se traducen a respuestas genéricas.
 */
import http from 'node:http';
import { HttpError, UNSAFE_METHODS, clientIp, isSameOriginRequest } from './middleware/http.js';
import { createRouter } from './middleware/router.js';
import { createAuditLog } from './modules/audit/audit.js';
import { createAuth } from './modules/auth/index.js';
import { verifyCsrfToken } from './modules/auth/sessions.js';
import { createPermissionsModule } from './modules/permissions/index.js';
import { createUsersModule } from './modules/users/index.js';

/**
 * Cabeceras de seguridad base, aplicadas a TODA respuesta.
 * La CSP es la más restrictiva posible porque aún no se sirve HTML; se ampliará
 * de forma explícita cuando existan el sitio público y el panel (Bloques 08/09).
 */
export function baseSecurityHeaders({ isProduction }) {
  const headers = {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-store',
  };
  // HSTS solo tiene sentido (y solo es seguro activarlo) cuando se sirve por HTTPS.
  if (isProduction) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function send(req, res, { status, body, headers = {}, cookies = [] }) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  if (body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

const errorResponse = (status, code, headers = {}, cookies = [], details = undefined) => ({
  status,
  body: { error: code, ...details },
  headers,
  cookies,
});

/**
 * @param {{ config: ReturnType<typeof import('./config/index.js').loadConfig>,
 *           logger: ReturnType<typeof import('./utils/logger.js').createLogger>,
 *           db: import('node:sqlite').DatabaseSync,
 *           clock?: () => number,
 *           passwordHasher?: ReturnType<typeof import('./modules/auth/password.js').createPasswordHasher> }} deps
 */
export function createServer({ config, logger, db, clock = Date.now, passwordHasher }) {
  if (!db) throw new TypeError('createServer requiere una conexión a la base de datos');
  const securityHeaders = baseSecurityHeaders(config);
  const expectedOrigin = new URL(config.baseUrl).origin;
  const auth = createAuth({ db, config, logger, clock, passwordHasher });
  const users = createUsersModule({ db, sessions: auth.sessions, passwordHasher: auth.passwordHasher });
  const permissionsModule = createPermissionsModule({ db, loadManagedUser: users.loadManagedUser });
  const audit = createAuditLog(db);

  // Definición de ruta: { method, path, handler, auth?, role?, allowDuringPasswordChange? }
  const router = createRouter();
  const health = () => ({ status: 200, body: { status: 'ok' } });
  router.add({ method: 'GET', path: '/health', handler: health });
  router.add({ method: 'HEAD', path: '/health', handler: health });
  for (const route of [...auth.routes, ...users.routes, ...permissionsModule.routes]) {
    if (route.role && !route.auth) throw new Error(`La ruta ${route.path} exige rol pero no sesión`);
    router.add(route);
  }

  async function handle(req) {
    // Solo interesa la ruta; la base es fija para no depender de la cabecera Host.
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return errorResponse(400, 'bad_request');
    }

    const matched = router.match(pathname);
    if (!matched) return errorResponse(404, 'not_found');
    const { methods, params } = matched;
    const def = methods.get(req.method);
    if (!def) return errorResponse(405, 'method_not_allowed', { Allow: [...methods.keys()].join(', ') });

    const ip = clientIp(req, config.trustProxy);
    const unsafe = UNSAFE_METHODS.has(req.method);

    if (unsafe && !isSameOriginRequest(req, expectedOrigin)) {
      logger.warn('Petición rechazada por origen no permitido', { path: pathname, ip, origin: req.headers.origin ?? null });
      return errorResponse(403, 'forbidden_origin');
    }

    const ctx = { req, ip, params, auth: null };
    if (def.auth) {
      ctx.auth = auth.sessionFromRequest(req);
      if (!ctx.auth) {
        return errorResponse(401, 'unauthenticated', {}, auth.hasSessionCookie(req) ? [auth.clearCookie()] : []);
      }
      if (unsafe && !verifyCsrfToken(ctx.auth.token, req.headers['x-csrf-token'])) {
        logger.warn('Petición rechazada por token CSRF inválido', { path: pathname, ip, userId: ctx.auth.session.user.id });
        return errorResponse(403, 'invalid_csrf_token');
      }
      const { user } = ctx.auth.session;
      if (user.mustChangePassword && !def.allowDuringPasswordChange) {
        return errorResponse(403, 'password_change_required');
      }
      if (def.role && user.role !== def.role) {
        audit.record({
          action: 'access.denied', outcome: 'denied', actorUserId: user.id, ip,
          details: { method: req.method, path: pathname, requiredRole: def.role },
        });
        return errorResponse(403, 'forbidden');
      }
    }

    return def.handler(ctx);
  }

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);

    handle(req)
      .catch((err) => {
        if (err instanceof HttpError) return errorResponse(err.status, err.code, err.headers, [], err.details);
        logger.error('Error no controlado en la petición', { err, method: req.method });
        return errorResponse(500, 'internal_error');
      })
      .then((result) => {
        if (res.headersSent) return;
        // Si quedó cuerpo sin leer (p. ej. rechazo antes de leerlo), se cierra la conexión.
        if (!req.complete) res.setHeader('Connection', 'close');
        send(req, res, result);
      })
      .catch((err) => {
        logger.error('Error al enviar la respuesta', { err });
        res.destroy();
      });
  });

  // Límites defensivos frente a clientes lentos (slowloris) y conexiones colgadas.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
    logger.debug('Error de cliente HTTP', { code: err.code });
  });

  server.auth = auth;
  return server;
}
