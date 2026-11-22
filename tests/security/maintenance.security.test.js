/**
 * Seguridad del Bloque 10: auditoría, copias, purga y configuración.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

let app;
let api;
let session;
beforeEach(async () => {
  app = await startApp({ env: { BACKUP_INTERVAL_HOURS: '0' } });
  ({ api, session } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const MUTATING = [
  ['POST', '/api/backups'], ['POST', '/api/backups/20260101000000/verify'], ['DELETE', '/api/backups/20260101000000'],
  ['POST', '/api/media/purge'], ['PATCH', '/api/settings'],
];

describe('seguridad del Bloque 10', () => {
  it('las rutas que modifican estado exigen token CSRF y mismo origen', async () => {
    for (const [method, p] of MUTATING) {
      const noToken = await app.request(p, { method, cookie: session.cookie, body: {} });
      assert.equal(noToken.status, 403, `${method} ${p} sin token`);
      assert.equal((await noToken.json()).error, 'invalid_csrf_token');
      const foreign = await app.request(p, { method, cookie: session.cookie, headers: { 'x-csrf-token': session.csrfToken }, origin: 'https://evil.example', body: {} });
      assert.equal(foreign.status, 403, `${method} ${p} otro origen`);
    }
    assert.equal(fs.existsSync(path.join(app.config.storageDir, 'backups')), false);
  });

  it('el acceso denegado de un administrador de sección queda auditado', async () => {
    await app.createUser({ username: 'seccion' });
    const other = app.as(await app.login('seccion'));
    await other.json('/api/backups', { method: 'POST' });
    const denied = app.db.prepare("SELECT details FROM audit_logs WHERE action = 'access.denied'").all().map((r) => JSON.parse(r.details));
    assert.ok(denied.some((d) => d.path === '/api/backups' && d.requiredRole === 'general_admin'));
  });

  it('la API de copias no revela rutas del servidor ni el contenido de los archivos', async () => {
    const created = await api.json('/api/backups', { method: 'POST' });
    const text = JSON.stringify([created.body, (await api.json('/api/backups')).body]);
    assert.ok(!text.includes(app.config.storageDir));
    assert.ok(!text.includes('database.sqlite'));
    assert.ok(!/\$argon2id\$/.test(text));
    assert.equal(created.body.backup.files, undefined);
  });

  it('el directorio de copias y el bloqueo no se sirven por HTTP', async () => {
    const { body } = await api.json('/api/backups', { method: 'POST' });
    for (const p of [`/backups/${body.backup.id}/manifest.json`, `/storage/backups/${body.backup.id}/database.sqlite`, '/cms.lock',
      `/admin/../storage/backups/${body.backup.id}/database.sqlite`, '/assets/..%2F..%2Fstorage%2Fcms.lock']) {
      const r = await app.request(p);
      assert.ok([400, 404].includes(r.status), `${p}: ${r.status}`);
    }
  });

  it('un enlace simbólico en private/ no se sigue al copiar', async (t) => {
    const priv = path.join(app.config.storageDir, 'private');
    fs.mkdirSync(priv, { recursive: true });
    try {
      fs.symlinkSync(path.resolve('package.json'), path.join(priv, 'enlace'));
    } catch {
      t.skip('el sistema no permite crear enlaces simbólicos sin privilegios');
      return;
    }
    const { body } = await api.json('/api/backups', { method: 'POST' });
    assert.deepEqual(body.backup.warnings, [{ code: 'private_file_skipped', path: 'private/enlace' }]);
    assert.equal(fs.existsSync(path.join(app.config.storageDir, 'backups', body.backup.id, 'private', 'enlace')), false);
  });

  it('los detalles de auditoría de las operaciones nuevas no contienen secretos', async () => {
    await api.json('/api/backups', { method: 'POST' });
    await api.json('/api/settings', { method: 'PATCH', body: { siteName: 'Nuevo' } });
    const rows = app.db.prepare("SELECT details FROM audit_logs WHERE action LIKE 'backup.%' OR action LIKE 'settings.%'").all();
    for (const { details } of rows) assert.ok(!/argon2|csrf|cookie|token/i.test(details), details);
  });
});
