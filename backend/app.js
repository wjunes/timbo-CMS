/**
 * Construcción del servidor HTTP (sin arrancarlo).
 *
 * Separado de `server.js` para poder probarlo en integración escuchando en un
 * puerto efímero, sin efectos secundarios (señales, process.exit).
 *
 * Canal de cada petición:
 *   1. Cabeceras de seguridad (toda respuesta).
 *   2. Panel (`/admin/…`) y recursos públicos (`/assets/…`): archivos estáticos de
 *      una lista cerrada, con su CSP. Resto: enrutado exacto por ruta y método
 *      (404 / 405); lo que no es de la API y no tiene ruta lo atiende el sitio
 *      público (Bloque 09: solo GET/HEAD, HTML generado en el servidor).
 *   3. Métodos que modifican estado: el origen debe ser el propio sitio (CSRF, capa 1).
 *   4. Rutas autenticadas: sesión válida (401) y, si modifican estado,
 *      cabecera X-CSRF-Token ligada a la sesión (CSRF, capa 2).
 *   5. Contraseña temporal pendiente: solo rutas permitidas (403 password_change_required).
 *   6. Rol exigido por la ruta (403 forbidden, auditado).
 *   7. Manejador. Los errores se traducen a respuestas genéricas.
 */
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PROJECT_ROOT } from './config/index.js';
import { HttpError, UNSAFE_METHODS, clientIp, isSameOriginRequest } from './middleware/http.js';
import { createRouter } from './middleware/router.js';
import { createAuditLog } from './modules/audit/audit.js';
import { createAuditModule } from './modules/audit/index.js';
import { createBackupsModule } from './modules/backups/index.js';
import { createBackupService } from './modules/backups/service.js';
import { createAuth } from './modules/auth/index.js';
import { createContentsModule } from './modules/contents/index.js';
import { createEditorialModule } from './modules/editorial/index.js';
import { createMediaModule } from './modules/media/index.js';
import { createMediaPurge } from './modules/media/purge.js';
import { PUBLIC_CSP, createPublicSite } from './modules/public/index.js';
import { createStaticSite } from './middleware/static.js';
import { verifyCsrfToken } from './modules/auth/sessions.js';
import { createPermissionsModule } from './modules/permissions/index.js';
import { createSectionsModule } from './modules/sections/index.js';
import { createSettingsModule } from './modules/settings/index.js';
import { createUsersModule } from './modules/users/index.js';

/**
 * Cabeceras de seguridad base, aplicadas a TODA respuesta.
 * La CSP es la más restrictiva posible: la API no sirve HTML. El panel tiene la
 * suya (middleware/static.js) y los archivos multimedia también (sandbox).
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

function send(req, res, { status, body, headers = {}, cookies = [], stream, text }, logger) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  if (text !== undefined) { // HTML, XML o texto ya generados (sitio público)
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
    return res.end(req.method === 'HEAD' ? undefined : text);
  }
  if (stream) {
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      stream.destroy();
      return res.end();
    }
    // Si el envío se interrumpe, se cierra la conexión (la longitud ya estaba anunciada).
    pipeline(stream, res).catch((err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.error('Error al enviar un archivo', { err });
      res.destroy();
    });
    return;
  }
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
/** Directorio del panel (servido bajo /admin). */
export const ADMIN_ROOT = path.join(PROJECT_ROOT, 'frontend', 'admin');
/** Recursos del sitio público (servidos bajo /assets). */
export const PUBLIC_ASSETS_ROOT = path.join(PROJECT_ROOT, 'frontend', 'public', 'assets');

export function createServer({ config, logger, db, clock = Date.now, passwordHasher, adminRoot = ADMIN_ROOT }) {
  if (!db) throw new TypeError('createServer requiere una conexión a la base de datos');
  const securityHeaders = baseSecurityHeaders(config);
  const expectedOrigin = new URL(config.baseUrl).origin;
  const auth = createAuth({ db, config, logger, clock, passwordHasher });
  const users = createUsersModule({ db, sessions: auth.sessions, passwordHasher: auth.passwordHasher });
  const permissionsModule = createPermissionsModule({ db, loadManagedUser: users.loadManagedUser });
  const sectionsModule = createSectionsModule({ db });
  const contentsModule = createContentsModule({ db });
  const editorialModule = createEditorialModule({ db });
  const mediaModule = createMediaModule({ db, config, logger });
  const adminSite = createStaticSite({ root: adminRoot, prefix: '/admin' });
  const publicAssets = createStaticSite({ root: PUBLIC_ASSETS_ROOT, prefix: '/assets', csp: PUBLIC_CSP });
  const publicSite = createPublicSite({ db, config, logger });
  const audit = createAuditLog(db);
  const backupService = createBackupService({ db, storageDir: config.storageDir, logger, clock });
  const backupsModule = createBackupsModule({ service: backupService, schedule: config.backup });
  const auditModule = createAuditModule({ db, anchors: backupService.anchors });
  const settingsModule = createSettingsModule({ db });
  const mediaPurge = createMediaPurge({ db, config, logger, clock });

  // Definición de ruta: { method, path, handler, auth?, role?, allowDuringPasswordChange? }
  const router = createRouter();
  const health = () => ({ status: 200, body: { status: 'ok' } });
  router.add({ method: 'GET', path: '/health', handler: health });
  router.add({ method: 'HEAD', path: '/health', handler: health });
  for (const route of [...auth.routes, ...users.routes, ...permissionsModule.routes, ...sectionsModule.routes, ...contentsModule.routes, ...editorialModule.routes,
    ...mediaModule.routes, ...mediaPurge.routes, ...auditModule.routes, ...backupsModule.routes, ...settingsModule.routes, ...publicSite.routes]) {
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

    if (adminSite.owns(pathname)) return adminSite.serve(req, pathname);
    if (publicAssets.owns(pathname)) return publicAssets.serve(req, pathname);

    const matched = router.match(pathname);
    if (!matched) {
      if (!publicSite.owns(pathname)) return errorResponse(404, 'not_found');
      if (req.method !== 'GET' && req.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', { Allow: 'GET, HEAD' });
      return publicSite.page(req, new URL(req.url, 'http://localhost'));
    }
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
        send(req, res, result, logger);
      })
      .catch((err) => {
        logger.error('Error al enviar la respuesta', { err });
        res.destroy();
      });
  });

  // Límites defensivos frente a clientes lentos (slowloris) y conexiones colgadas.
  server.headersTimeout = 15_000;
  // 120 s: deja subir un archivo de MEDIA_MAX_BYTES con una conexión lenta (D-053).
  // Las cabeceras siguen limitadas a 15 s y cada ruta limita el tamaño del cuerpo.
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
    logger.debug('Error de cliente HTTP', { code: err.code });
  });

  server.auth = auth;
  server.backups = backupService;
  return server;
}
