/**
 * Los archivos de configuración de ejemplo (Bloque 11) son válidos y coherentes
 * con lo que exige el despliegue: se cargan con loadConfig y cumplen las reglas
 * de producción de `npm run check`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT, loadConfig } from '../../backend/config/index.js';

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

describe('configuraciones de ejemplo', () => {
  it('.env.example es una configuración válida de desarrollo', () => {
    const c = loadConfig(parseEnvFile('.env.example'));
    assert.equal(c.env, 'development');
  });

  it('deploy/cms.env.example es una configuración válida de producción y segura para desplegar', () => {
    const c = loadConfig(parseEnvFile('deploy/cms.env.example'));
    assert.equal(c.isProduction, true);
    assert.ok(c.baseUrl.startsWith('https://'));
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.trustProxy, true);
    assert.notEqual(c.logLevel, 'debug');
    assert.ok(c.backup.intervalHours > 0);
  });

  it('el proxy y el servicio apuntan al puerto y a las rutas de la configuración', () => {
    const env = parseEnvFile('deploy/cms.env.example');
    for (const f of ['deploy/Caddyfile', 'deploy/nginx.conf.example']) {
      assert.ok(fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf8').includes(`127.0.0.1:${env.PORT}`), f);
    }
    const unit = fs.readFileSync(path.join(PROJECT_ROOT, 'deploy/cms-multiseccion.service'), 'utf8');
    assert.ok(env.DATABASE_PATH.startsWith('/var/lib/cms-multiseccion/') && env.STORAGE_DIR.startsWith('/var/lib/cms-multiseccion/'));
    assert.ok(unit.includes('ReadWritePaths=/var/lib/cms-multiseccion'));
    assert.ok(unit.includes('EnvironmentFile=/etc/cms-multiseccion/cms.env'));
    // El límite de cuerpo del proxy admite las subidas por defecto.
    assert.ok(Number(env.MEDIA_MAX_BYTES) < 12 * 1024 * 1024);
  });
});
