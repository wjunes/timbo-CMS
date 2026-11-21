/**
 * Hash y verificación de contraseñas con Argon2id nativo (`crypto.argon2`, Node >= 24.7).
 *
 * - Formato PHC: $argon2id$v=19$m=<KiB>,t=<pasadas>,p=<paralelismo>$<sal b64>$<hash b64>
 *   (base64 estándar sin relleno, como el resto de implementaciones).
 * - Parámetros por defecto: perfil de RFC 9106 §4 para entornos con memoria limitada
 *   (64 MiB, t=3, p=4), etiqueta de 32 bytes y sal aleatoria de 16 bytes.
 * - Los parámetros leídos de un hash almacenado se acotan: un hash manipulado no
 *   puede forzar un consumo desmedido de memoria o CPU.
 * - Un semáforo limita los cálculos simultáneos (cada uno reserva ~64 MiB) y la cola
 *   tiene un tope: bajo abuso, falla con PasswordHasherBusyError en vez de agotar memoria.
 * - La contraseña se normaliza a Unicode NFC antes de derivar.
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

export const DEFAULT_PARAMS = Object.freeze({ memory: 65_536, passes: 3, parallelism: 4 });
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;
const VERSION = 19;

// Límites de aceptación de hashes almacenados (defensa frente a valores manipulados).
const BOUNDS = Object.freeze({ memory: [8, 262_144], passes: [1, 10], parallelism: [1, 16] });

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** Tope absoluto de entrada aceptado para verificar (evita trabajo con cargas enormes). */
export const PASSWORD_INPUT_MAX_BYTES = 1024;

export class PasswordHasherBusyError extends Error {
  constructor() {
    super('Demasiadas operaciones de contraseña en curso');
    this.name = 'PasswordHasherBusyError';
  }
}

const PHC_PATTERN = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(buf) {
  return buf.toString('base64').replace(/=+$/, '');
}

/** @returns {{ memory: number, passes: number, parallelism: number, salt: Buffer, hash: Buffer } | null} */
export function parsePhc(phc) {
  if (typeof phc !== 'string' || phc.length > 512) return null;
  const m = PHC_PATTERN.exec(phc);
  if (!m) return null;
  const [, version, memory, passes, parallelism, salt, hash] = m;
  const params = { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) };
  if (Number(version) !== VERSION) return null;
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (!Number.isSafeInteger(params[key]) || params[key] < min || params[key] > max) return null;
  }
  if (params.memory < 8 * params.parallelism) return null;
  const saltBuf = Buffer.from(salt, 'base64');
  const hashBuf = Buffer.from(hash, 'base64');
  if (saltBuf.length < 8 || saltBuf.length > 64 || hashBuf.length < 16 || hashBuf.length > 64) return null;
  return { ...params, salt: saltBuf, hash: hashBuf };
}

function createSemaphore(max, maxQueue) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active >= max) {
      if (queue.length >= maxQueue) throw new PasswordHasherBusyError();
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * @param {{ params?: { memory: number, passes: number, parallelism: number },
 *           maxConcurrent?: number, maxQueue?: number }} [options]
 */
export function createPasswordHasher({ params = DEFAULT_PARAMS, maxConcurrent = 4, maxQueue = 64 } = {}) {
  const limit = createSemaphore(maxConcurrent, maxQueue);
  let dummyHash;

  const derive = (password, salt, p, tagLength) =>
    limit(() =>
      argon2Async('argon2id', {
        message: Buffer.from(password.normalize('NFC'), 'utf8'),
        nonce: salt,
        memory: p.memory,
        passes: p.passes,
        parallelism: p.parallelism,
        tagLength,
      }),
    );

  async function hash(password) {
    if (typeof password !== 'string' || password.length === 0) throw new TypeError('Contraseña inválida');
    const salt = randomBytes(SALT_LENGTH);
    const tag = await derive(password, salt, params, TAG_LENGTH);
    return `$argon2id$v=${VERSION}$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  /** Devuelve false ante cualquier entrada inválida (nunca lanza por datos del usuario). */
  async function verify(password, phc) {
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES) return false;
    const parsed = parsePhc(phc);
    if (!parsed) return false;
    const tag = await derive(password, parsed.salt, parsed, parsed.hash.length);
    return timingSafeEqual(tag, parsed.hash);
  }

  /**
   * Ejecuta una verificación sobre un hash ficticio con los parámetros actuales.
   * Se usa cuando el usuario no existe o no está activo, para que el tiempo de
   * respuesta no revele qué cuentas existen.
   */
  async function verifyDummy(password) {
    dummyHash ??= await hash(randomBytes(16).toString('hex'));
    await verify(typeof password === 'string' ? password.slice(0, PASSWORD_INPUT_MAX_BYTES) : '', dummyHash);
    return false;
  }

  /** true si el hash se generó con parámetros distintos de los actuales. */
  function needsRehash(phc) {
    const parsed = parsePhc(phc);
    return (
      !parsed ||
      parsed.memory !== params.memory ||
      parsed.passes !== params.passes ||
      parsed.parallelism !== params.parallelism ||
      parsed.hash.length !== TAG_LENGTH
    );
  }

  return Object.freeze({ hash, verify, verifyDummy, needsRehash });
}

/**
 * Política de contraseñas (criterio NIST SP 800-63B: longitud, sin reglas de composición).
 * @returns {string[]} lista de problemas; vacía si es válida.
 */
export function checkPasswordPolicy(password, { username } = {}) {
  if (typeof password !== 'string') return ['La contraseña es obligatoria'];
  const issues = [];
  const length = [...password.normalize('NFC')].length;
  if (length < PASSWORD_MIN_LENGTH) issues.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (length > PASSWORD_MAX_LENGTH) issues.push(`No puede superar ${PASSWORD_MAX_LENGTH} caracteres`);
  if (/[\u0000-\u001f\u007f]/.test(password)) issues.push('No puede contener caracteres de control');
  if (password.trim() === '') issues.push('No puede estar formada solo por espacios');
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) {
    issues.push('No puede contener el nombre de usuario');
  }
  if (/^(.)\1+$/u.test(password)) issues.push('No puede ser un único carácter repetido');
  return issues;
}
