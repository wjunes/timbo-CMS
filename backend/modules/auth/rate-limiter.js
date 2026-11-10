/**
 * Limitador de intentos en memoria, con ventana fija por clave.
 *
 * Adecuado para el monolito de proceso único (D-019): los contadores se pierden al
 * reiniciar. El número de claves está acotado, con expulsión de la más antigua,
 * para que un atacante no pueda agotar memoria generando claves nuevas.
 */
export function createRateLimiter({ windowMs, max, maxKeys = 10_000, clock = Date.now }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const entries = new Map();

  function current(key) {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= clock()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** @returns {{ limited: boolean, retryAfterSeconds: number }} */
  function check(key) {
    const entry = current(key);
    if (!entry || entry.count < max) return { limited: false, retryAfterSeconds: 0 };
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - clock()) / 1000)) };
  }

  function hit(key) {
    const entry = current(key);
    if (entry) {
      entry.count++;
      return;
    }
    if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
    entries.set(key, { count: 1, resetAt: clock() + windowMs });
  }

  function reset(key) {
    entries.delete(key);
  }

  return Object.freeze({ check, hit, reset, size: () => entries.size });
}
