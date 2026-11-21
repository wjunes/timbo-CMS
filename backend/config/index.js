/**
 * Carga y validación de configuración.
 *
 * `loadConfig(env)` es una función pura: recibe un objeto de variables de entorno
 * (por defecto `process.env`) y devuelve una configuración inmutable o lanza
 * `ConfigError` con la lista completa de problemas detectados.
 *
 * La lectura del archivo `.env` NO ocurre aquí: se delega en el flag nativo
 * `--env-file-if-exists` de Node.js (ver scripts de package.json). Las variables
 * reales del entorno tienen precedencia sobre las del archivo.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del proyecto: las rutas relativas de la configuración se resuelven aquí, no contra el cwd. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directorio servido públicamente (Bloques 08/09). Los datos nunca pueden quedar dentro. */
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'frontend');

export const MEMORY_DB = ':memory:';

export const NODE_ENVS = Object.freeze(['development', 'test', 'production']);
export const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);

export class ConfigError extends Error {
  /** @param {string[]} issues */
  constructor(issues) {
    super(`Configuración inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_PATH: 'database/cms.db',
  STORAGE_DIR: 'storage',
  SESSION_TTL_HOURS: '8',
  SESSION_IDLE_MINUTES: '30',
  TRUST_PROXY: 'false',
});

/** Devuelve el valor recortado o undefined si está vacío. */
function read(env, key) {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value === '' ? undefined : value;
}

function parsePort(value, issues) {
  if (!/^\d{1,5}$/.test(value)) {
    issues.push(`PORT debe ser un entero entre 1 y 65535 (recibido: "${value}")`);
    return undefined;
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    issues.push(`PORT debe estar entre 1 y 65535 (recibido: ${port})`);
    return undefined;
  }
  return port;
}

function parseHost(value, issues) {
  // Nombre de host o IPv4/IPv6 literal; sin esquema, puerto ni ruta.
  if (!/^[A-Za-z0-9.\-:]+$/.test(value) || value.length > 253) {
    issues.push(`HOST no es un nombre de host o IP válido (recibido: "${value}")`);
    return undefined;
  }
  return value;
}

function parseBaseUrl(value, nodeEnv, issues) {
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push(`APP_BASE_URL no es una URL válida (recibido: "${value}")`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push('APP_BASE_URL debe usar http o https');
    return undefined;
  }
  if (url.username || url.password) {
    issues.push('APP_BASE_URL no debe contener credenciales');
    return undefined;
  }
  if (url.search || url.hash) {
    issues.push('APP_BASE_URL no debe contener query string ni fragmento');
    return undefined;
  }
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    issues.push('APP_BASE_URL debe usar https en producción');
    return undefined;
  }
  // Normaliza sin barra final para componer rutas de forma predecible.
  return url.href.replace(/\/+$/, '');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Valida una ruta de datos y la resuelve a absoluta respecto de la raíz del proyecto. */
function parseDataPath(key, value, issues) {
  if (value.includes('\u0000')) {
    issues.push(`${key} contiene caracteres no válidos`);
    return undefined;
  }
  const resolved = path.resolve(PROJECT_ROOT, value);
  if (isInside(resolved, PUBLIC_ROOT)) {
    issues.push(`${key} no puede estar dentro del directorio público (frontend/)`);
    return undefined;
  }
  return resolved;
}

function parseDatabasePath(value, isProduction, issues) {
  if (value === MEMORY_DB) {
    if (isProduction) {
      issues.push('DATABASE_PATH no puede ser ":memory:" en producción');
      return undefined;
    }
    return MEMORY_DB;
  }
  return parseDataPath('DATABASE_PATH', value, issues);
}

function parseIntInRange(key, value, min, max, issues) {
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
    issues.push(`${key} debe ser un entero entre ${min} y ${max} (recibido: "${value}")`);
    return undefined;
  }
  return Number(value);
}

function parseBoolean(key, value, issues) {
  const v = value.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  issues.push(`${key} debe ser true/false (recibido: "${value}")`);
  return undefined;
}

function parseEnum(key, value, allowed, issues) {
  if (!allowed.includes(value)) {
    issues.push(`${key} debe ser uno de: ${allowed.join(', ')} (recibido: "${value}")`);
    return undefined;
  }
  return value;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<{
 *   env: 'development'|'test'|'production',
 *   isProduction: boolean,
 *   host: string,
 *   port: number,
 *   baseUrl: string,
 *   logLevel: 'error'|'warn'|'info'|'debug',
 *   databasePath: string,
 *   storageDir: string,
 *   session: { ttlMs: number, idleMs: number },
 *   trustProxy: boolean,
 * }>}
 */
export function loadConfig(env = process.env) {
  const issues = [];

  const nodeEnv = parseEnum('NODE_ENV', read(env, 'NODE_ENV') ?? DEFAULTS.NODE_ENV, NODE_ENVS, issues);
  const isProduction = nodeEnv === 'production';

  const host = parseHost(read(env, 'HOST') ?? DEFAULTS.HOST, issues);
  const port = parsePort(read(env, 'PORT') ?? DEFAULTS.PORT, issues);
  const logLevel = parseEnum('LOG_LEVEL', read(env, 'LOG_LEVEL') ?? DEFAULTS.LOG_LEVEL, LOG_LEVELS, issues);

  // En producción la URL pública es obligatoria: se usará para cookies, CSRF
  // (validación de Origin) y enlaces absolutos. En desarrollo se deriva.
  let rawBaseUrl = read(env, 'APP_BASE_URL');
  if (rawBaseUrl === undefined) {
    if (isProduction) {
      issues.push('APP_BASE_URL es obligatoria en producción');
    } else if (host !== undefined && port !== undefined) {
      const displayHost = host.includes(':') ? `[${host}]` : host;
      rawBaseUrl = `http://${displayHost}:${port}`;
    }
  }
  const baseUrl = rawBaseUrl === undefined ? undefined : parseBaseUrl(rawBaseUrl, nodeEnv, issues);

  const databasePath = parseDatabasePath(read(env, 'DATABASE_PATH') ?? DEFAULTS.DATABASE_PATH, isProduction, issues);
  const storageDir = parseDataPath('STORAGE_DIR', read(env, 'STORAGE_DIR') ?? DEFAULTS.STORAGE_DIR, issues);

  const ttlHours = parseIntInRange('SESSION_TTL_HOURS', read(env, 'SESSION_TTL_HOURS') ?? DEFAULTS.SESSION_TTL_HOURS, 1, 72, issues);
  const idleMinutes = parseIntInRange('SESSION_IDLE_MINUTES', read(env, 'SESSION_IDLE_MINUTES') ?? DEFAULTS.SESSION_IDLE_MINUTES, 5, 1440, issues);
  if (ttlHours !== undefined && idleMinutes !== undefined && idleMinutes > ttlHours * 60) {
    issues.push('SESSION_IDLE_MINUTES no puede superar la duración máxima de la sesión (SESSION_TTL_HOURS)');
  }
  // Solo debe activarse detrás de un proxy inverso propio que sobrescriba X-Forwarded-For.
  const trustProxy = parseBoolean('TRUST_PROXY', read(env, 'TRUST_PROXY') ?? DEFAULTS.TRUST_PROXY, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  const session = Object.freeze({ ttlMs: ttlHours * 3_600_000, idleMs: idleMinutes * 60_000 });
  return Object.freeze({ env: nodeEnv, isProduction, host, port, baseUrl, logLevel, databasePath, storageDir, session, trustProxy });
}
