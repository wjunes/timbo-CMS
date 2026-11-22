/**
 * Enrutador mínimo: rutas exactas y segmentos con parámetro `:nombre`.
 *
 * Los parámetros solo admiten identificadores enteros positivos (1..10^16-1):
 * cualquier otro valor no coincide con la ruta (404). Así los manejadores
 * reciben siempre números válidos y no hay que validarlos uno a uno.
 */
const PARAM_VALUE = /^[1-9][0-9]{0,15}$/;

export function createRouter() {
  /** @type {Map<string, Map<string, object>>} */
  const exact = new Map();
  /** @type {{ segments: string[], methods: Map<string, object> }[]} */
  const patterns = [];

  function add({ method, path, ...def }) {
    if (!path.startsWith('/')) throw new TypeError(`Ruta inválida: ${path}`);
    let methods;
    if (path.includes(':')) {
      const segments = path.split('/');
      let entry = patterns.find((p) => p.segments.join('/') === path);
      if (!entry) patterns.push((entry = { segments, methods: new Map() }));
      methods = entry.methods;
    } else {
      if (!exact.has(path)) exact.set(path, new Map());
      methods = exact.get(path);
    }
    if (methods.has(method)) throw new Error(`Ruta duplicada: ${method} ${path}`);
    methods.set(method, def);
  }

  /** @returns {{ methods: Map<string, object>, params: Record<string, number> } | null} */
  function match(pathname) {
    const methods = exact.get(pathname);
    if (methods) return { methods, params: {} };
    const parts = pathname.split('/');
    for (const { segments, methods: m } of patterns) {
      if (segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segments.length && ok; i++) {
        if (segments[i].startsWith(':')) {
          if (PARAM_VALUE.test(parts[i])) params[segments[i].slice(1)] = Number(parts[i]);
          else ok = false;
        } else if (segments[i] !== parts[i]) ok = false;
      }
      if (ok) return { methods: m, params };
    }
    return null;
  }

  /** Inventario de rutas registradas (Bloque 11: lo revisa una prueba de seguridad). */
  function list() {
    const out = [];
    for (const [path, methods] of exact) for (const [method, def] of methods) out.push({ method, path, ...def });
    for (const { segments, methods } of patterns) for (const [method, def] of methods) out.push({ method, path: segments.join('/'), ...def });
    return out;
  }

  return Object.freeze({ add, match, list });
}
