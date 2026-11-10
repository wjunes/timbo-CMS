/**
 * Logger mínimo en formato JSON por línea (stdout/stderr).
 *
 * - Filtra por nivel.
 * - Redacta claves sensibles en los metadatos (contraseñas, tokens, cookies…)
 *   para impedir que lleguen a los registros por descuido.
 * - Serializa errores sin exponer más de lo necesario (stack solo fuera de producción).
 */

const LEVEL_ORDER = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authorization|api[-_]?key|session|csrf|hash/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

function serializeError(err, includeStack) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (includeStack && err.stack) out.stack = err.stack;
  return out;
}

/**
 * @param {{ level?: keyof typeof LEVEL_ORDER, includeStack?: boolean,
 *           write?: (stream: 'stdout'|'stderr', line: string) => void }} [options]
 */
export function createLogger({ level = 'info', includeStack = true, write } = {}) {
  if (!(level in LEVEL_ORDER)) throw new TypeError(`Nivel de log desconocido: ${level}`);
  const threshold = LEVEL_ORDER[level];
  const sink =
    write ??
    ((stream, line) => {
      (stream === 'stderr' ? process.stderr : process.stdout).write(line + '\n');
    });

  function log(lvl, msg, meta) {
    if (LEVEL_ORDER[lvl] > threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg };
    if (meta !== undefined) {
      if (meta instanceof Error) {
        entry.err = serializeError(meta, includeStack);
      } else {
        const { err, ...rest } = meta;
        Object.assign(entry, redact(rest));
        if (err instanceof Error) entry.err = serializeError(err, includeStack);
      }
    }
    sink(lvl === 'error' || lvl === 'warn' ? 'stderr' : 'stdout', JSON.stringify(entry));
  }

  return Object.freeze({
    error: (msg, meta) => log('error', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    debug: (msg, meta) => log('debug', msg, meta),
  });
}
