/**
 * API de copias de seguridad (Bloque 10, solo general_admin).
 *
 * Listar, crear, verificar y eliminar. La restauración no está en la API: se
 * hace con `npm run backup:restore` y el servidor detenido (D-060). Las copias
 * tampoco se descargan desde el panel: contienen los hashes de las contraseñas.
 */
import { HttpError } from '../../middleware/http.js';
import { BackupError } from './service.js';

const STATUS = { backup_not_found: 404, backup_in_progress: 409 };

function translate(err) {
  if (err instanceof BackupError && STATUS[err.code]) throw new HttpError(STATUS[err.code], err.code);
  throw err;
}

/**
 * @param {{ service: ReturnType<typeof import('./service.js').createBackupService>,
 *           schedule: { intervalHours: number, keep: number } }} deps
 */
export function createBackupsModule({ service, schedule }) {
  const actor = (ctx) => ({ actorUserId: ctx.auth.session.user.id, ip: ctx.ip });
  const id = (ctx) => String(ctx.params.id);

  async function list() {
    return { status: 200, body: { backups: await service.list(), schedule, running: service.isRunning() } };
  }

  async function create(ctx) {
    const backup = await service.create({ kind: 'manual', ...actor(ctx) }).catch(translate);
    return { status: 201, body: { backup } };
  }

  async function get(ctx) {
    return { status: 200, body: { backup: await service.get(id(ctx)).catch(translate) } };
  }

  async function verify(ctx) {
    return { status: 200, body: await service.verify(id(ctx), actor(ctx)).catch(translate) };
  }

  async function remove(ctx) {
    await service.remove(id(ctx), actor(ctx)).catch(translate);
    return { status: 204 };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/backups', handler: list, ...ga },
      { method: 'POST', path: '/api/backups', handler: create, ...ga },
      { method: 'GET', path: '/api/backups/:id', handler: get, ...ga },
      { method: 'POST', path: '/api/backups/:id/verify', handler: verify, ...ga },
      { method: 'DELETE', path: '/api/backups/:id', handler: remove, ...ga },
    ],
  });
}

/**
 * Copias automáticas: cada `checkMs` comprueba si la última automática tiene
 * más de `intervalHours`; si es así, crea una y aplica la retención. Al
 * arrancar no se crea otra si la última es reciente. intervalHours = 0 las desactiva.
 */
export function createBackupScheduler({ service, intervalHours, keep, logger, clock = Date.now, checkMs = 15 * 60_000, firstCheckMs = 60_000 }) {
  let timer = null;
  let first = null;

  async function tick() {
    if (intervalHours === 0) return null;
    try {
      const last = (await service.list()).find((b) => b.kind === 'automatic' && !b.broken);
      if (last && clock() - Date.parse(last.createdAt) < intervalHours * 3_600_000) return null;
      const created = await service.create({ kind: 'automatic' });
      await service.prune(keep);
      return created;
    } catch (err) {
      if (err instanceof BackupError && err.code === 'backup_in_progress') return null;
      logger.error('Fallo en la copia de seguridad automática', { err });
      return null;
    }
  }

  return Object.freeze({
    tick,
    start() {
      if (intervalHours === 0) return;
      first = setTimeout(tick, firstCheckMs);
      first.unref();
      timer = setInterval(tick, checkMs);
      timer.unref();
    },
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  });
}
