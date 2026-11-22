/**
 * Archivos estáticos del panel (Bloque 08): `frontend/admin/` bajo `/admin/`.
 *
 * - Lista cerrada: al arrancar se recorren los archivos del directorio y solo
 *   esos se sirven. La ruta pedida nunca se convierte en una ruta del disco, así
 *   que no hay path traversal posible (`..`, codificaciones, enlaces).
 * - Solo extensiones conocidas, con su tipo fijado aquí (más `nosniff`).
 * - CSP del panel: scripts, estilos, imágenes y peticiones solo del propio
 *   sitio; nada en línea, sin marcos ni objetos.
 * - El panel es una aplicación de una página: `/admin` y `/admin/` sirven
 *   index.html y la navegación interna usa el fragmento (#/…).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

export const ADMIN_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "connect-src 'self'",
  "font-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
].join('; ');

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

/** @returns {Map<string, { file: string, type: string }>} ruta URL → archivo */
function scan(root, prefix) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue; // ni enlaces simbólicos ni directorios
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, file).split(path.sep);
    if (rel.some((part) => part.startsWith('.'))) continue; // ocultos
    const type = TYPES[path.extname(entry.name).toLowerCase()];
    if (!type) continue;
    files.set(`${prefix}/${rel.join('/')}`, { file, type });
  }
  const index = files.get(`${prefix}/index.html`);
  if (index) {
    files.set(prefix, index);
    files.set(`${prefix}/`, index);
  }
  return files;
}

/**
 * @param {{ root: string, prefix: string }} options
 */
export function createStaticSite({ root, prefix }) {
  const files = scan(root, prefix);

  return Object.freeze({
    /** ¿Pertenece la ruta a este sitio? (aunque el archivo no exista: entonces 404 aquí). */
    owns: (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`),

    async serve(req, pathname) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', { Allow: 'GET, HEAD' });
      }
      const entry = files.get(pathname);
      if (!entry) throw new HttpError(404, 'not_found');
      const handle = await fs.promises.open(entry.file, 'r');
      const { size } = await handle.stat();
      return {
        status: 200,
        stream: handle.createReadStream(),
        headers: {
          'Content-Type': entry.type,
          'Content-Length': String(size),
          'Content-Security-Policy': ADMIN_CSP,
          'Cache-Control': 'no-cache',
        },
      };
    },
  });
}
