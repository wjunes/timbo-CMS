import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, PROJECT_ROOT, loadConfig } from '../../backend/config/index.js';

function expectIssues(env, ...fragments) {
  assert.throws(
    () => loadConfig(env),
    (err) => {
      assert.ok(err instanceof ConfigError, 'debe lanzar ConfigError');
      for (const f of fragments) {
        assert.ok(err.issues.some((i) => i.includes(f)), `falta un problema que contenga "${f}": ${err.issues}`);
      }
      return true;
    },
  );
}

describe('loadConfig', () => {
  it('aplica valores por defecto seguros en desarrollo', () => {
    const c = loadConfig({});
    assert.equal(c.env, 'development');
    assert.equal(c.isProduction, false);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 3000);
    assert.equal(c.logLevel, 'info');
    assert.equal(c.baseUrl, 'http://127.0.0.1:3000');
  });

  it('devuelve un objeto inmutable', () => {
    const c = loadConfig({});
    assert.ok(Object.isFrozen(c));
    assert.throws(() => {
      'use strict';
      c.port = 1;
    }, TypeError);
  });

  it('trata cadenas vacías o con espacios como no definidas', () => {
    const c = loadConfig({ PORT: '  ', HOST: '', LOG_LEVEL: ' debug ' });
    assert.equal(c.port, 3000);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.logLevel, 'debug');
  });

  it('acepta una configuración válida de producción', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      APP_BASE_URL: 'https://cms.example.org/',
    });
    assert.equal(c.isProduction, true);
    assert.equal(c.port, 8080);
    assert.equal(c.baseUrl, 'https://cms.example.org');
  });

  it('exige APP_BASE_URL en producción', () => {
    expectIssues({ NODE_ENV: 'production' }, 'APP_BASE_URL es obligatoria');
  });

  it('rechaza http en producción', () => {
    expectIssues({ NODE_ENV: 'production', APP_BASE_URL: 'http://cms.example.org' }, 'https en producción');
  });

  for (const port of ['0', '65536', '-1', '80a', '3.5', '999999']) {
    it(`rechaza PORT inválido "${port}"`, () => expectIssues({ PORT: port }, 'PORT'));
  }

  it('rechaza NODE_ENV y LOG_LEVEL desconocidos', () => {
    expectIssues({ NODE_ENV: 'staging', LOG_LEVEL: 'verbose' }, 'NODE_ENV', 'LOG_LEVEL');
  });

  it('rechaza HOST con esquema o ruta', () => {
    expectIssues({ HOST: 'http://localhost' }, 'HOST');
    expectIssues({ HOST: 'localhost/x' }, 'HOST');
  });

  it('rechaza APP_BASE_URL mal formada, con credenciales, query o esquema no http', () => {
    expectIssues({ APP_BASE_URL: 'no es url' }, 'no es una URL válida');
    expectIssues({ APP_BASE_URL: 'https://user:pw@example.org' }, 'credenciales');
    expectIssues({ APP_BASE_URL: 'https://example.org/?a=1' }, 'query string');
    expectIssues({ APP_BASE_URL: 'ftp://example.org' }, 'http o https');
  });

  it('reporta todos los problemas a la vez', () => {
    expectIssues({ NODE_ENV: 'x', PORT: 'x', LOG_LEVEL: 'x' }, 'NODE_ENV', 'PORT', 'LOG_LEVEL');
  });

  it('resuelve DATABASE_PATH y STORAGE_DIR respecto de la raíz del proyecto, no del cwd', () => {
    const c = loadConfig({});
    assert.equal(c.databasePath, path.join(PROJECT_ROOT, 'database', 'cms.db'));
    assert.equal(c.storageDir, path.join(PROJECT_ROOT, 'storage'));
    const custom = loadConfig({ DATABASE_PATH: 'otro/dir/x.db', STORAGE_DIR: 'datos' });
    assert.equal(custom.databasePath, path.join(PROJECT_ROOT, 'otro', 'dir', 'x.db'));
    assert.equal(custom.storageDir, path.join(PROJECT_ROOT, 'datos'));
  });

  it('acepta rutas absolutas fuera del proyecto', () => {
    const abs = path.resolve(os.tmpdir(), 'cms', 'prod.db');
    assert.equal(loadConfig({ DATABASE_PATH: abs }).databasePath, abs);
  });

  it('impide ubicar datos dentro del directorio público', () => {
    expectIssues({ DATABASE_PATH: 'frontend/public/cms.db' }, 'DATABASE_PATH no puede estar dentro del directorio público');
    expectIssues({ STORAGE_DIR: 'frontend' }, 'STORAGE_DIR no puede estar dentro del directorio público');
    expectIssues({ STORAGE_DIR: 'storage/../frontend/assets' }, 'STORAGE_DIR');
  });

  it('admite ":memory:" solo fuera de producción', () => {
    assert.equal(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath, ':memory:');
    expectIssues({ NODE_ENV: 'production', APP_BASE_URL: 'https://cms.example.org', DATABASE_PATH: ':memory:' }, ':memory:');
  });

  it('rechaza rutas con caracteres nulos', () => {
    expectIssues({ DATABASE_PATH: 'a\u0000b.db' }, 'DATABASE_PATH contiene caracteres no válidos');
  });

  it('sesiones: 8 h y 30 min por defecto, configurables y validadas', () => {
    assert.deepEqual(loadConfig({}).session, { ttlMs: 8 * 3_600_000, idleMs: 30 * 60_000 });
    assert.deepEqual(loadConfig({ SESSION_TTL_HOURS: '2', SESSION_IDLE_MINUTES: '15' }).session, { ttlMs: 7_200_000, idleMs: 900_000 });
    expectIssues({ SESSION_TTL_HOURS: '0' }, 'SESSION_TTL_HOURS');
    expectIssues({ SESSION_TTL_HOURS: '100' }, 'SESSION_TTL_HOURS');
    expectIssues({ SESSION_IDLE_MINUTES: '1' }, 'SESSION_IDLE_MINUTES');
    expectIssues({ SESSION_TTL_HOURS: '1', SESSION_IDLE_MINUTES: '90' }, 'no puede superar');
  });

  it('TRUST_PROXY es false por defecto y solo admite valores booleanos', () => {
    assert.equal(loadConfig({}).trustProxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(loadConfig({ TRUST_PROXY: '0' }).trustProxy, false);
    expectIssues({ TRUST_PROXY: 'yes' }, 'TRUST_PROXY');
  });

  it('no incluye el valor de variables ajenas en el resultado', () => {
    const c = loadConfig({ SOME_SECRET: 'super-secret' });
    assert.ok(!JSON.stringify(c).includes('super-secret'));
  });
});
