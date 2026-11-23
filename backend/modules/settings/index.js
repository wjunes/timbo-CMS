/**
 * Configuración general del sitio (Bloque 10, D-056, solo general_admin).
 *
 * Una lista cerrada de ajustes editoriales, guardados en `settings` como JSON.
 * Son texto plano: el sitio público los escapa siempre, así que no admiten
 * HTML ni código. Cada cambio se audita con el valor anterior y el nuevo.
 *
 * Bloque 12 (D-068): `sitePalette` elige la paleta de colores del sitio entre las
 * del catálogo; nunca CSS libre. La respuesta incluye el catálogo con sus colores
 * para que el panel muestre las muestras.
 */
import { withTransaction } from '../../database/transaction.js';
import { readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';

/** Campo de la API → clave en `settings`, regla y valor por defecto. */
function siteSettings(themes) {
  return Object.freeze({
    siteName: { key: 'site.name', rule: rules.string({ min: 1, max: 120, optional: true }), fallback: 'CMS-MULTISECCIÓN' },
    siteDescription: { key: 'site.description', rule: rules.string({ max: 300, optional: true }), fallback: '' },
    sitePalette: { key: 'site.palette', rule: rules.oneOf(themes.ids, { optional: true }), fallback: themes.defaultId, allowed: themes.ids },
  });
}

/** @param {{ db: import('node:sqlite').DatabaseSync, themes: ReturnType<typeof import('../themes/catalog.js').loadThemeCatalog> }} deps */
export function createSettingsModule({ db, themes }) {
  if (!themes) throw new TypeError('createSettingsModule requiere el catálogo de paletas');
  const SITE_SETTINGS = siteSettings(themes);
  const schema = Object.fromEntries(Object.entries(SITE_SETTINGS).map(([f, s]) => [f, s.rule]));
  const palettes = themes.list.map(({ id, name, custom, light, dark }) => ({ id, name, custom, light, dark }));
  const audit = createAuditLog(db);
  const read = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(`INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  function current() {
    const out = {};
    for (const [field, { key, fallback, allowed }] of Object.entries(SITE_SETTINGS)) {
      const row = read.get(key);
      let value = fallback;
      if (row) {
        const parsed = JSON.parse(row.value);
        // Una paleta guardada que ya no existe (p. ej. se retiró THEMES_FILE) se muestra como la predeterminada,
        // que es la que usa entonces el sitio público.
        if (typeof parsed === 'string' && (!allowed || allowed.includes(parsed))) value = parsed;
      }
      out[field] = value;
    }
    return out;
  }

  function get() {
    return { status: 200, body: { settings: current(), palettes } };
  }

  async function update(ctx) {
    const input = validate(await readJsonBody(ctx.req), schema, { requireAny: true });
    const actor = ctx.auth.session.user.id;
    const settings = withTransaction(db, () => {
      const before = current();
      const changed = Object.keys(input).filter((f) => input[f] !== before[f]);
      for (const f of changed) upsert.run(SITE_SETTINGS[f].key, JSON.stringify(input[f]), actor);
      if (changed.length) {
        audit.record({
          action: 'settings.update', outcome: 'success', actorUserId: actor, entityType: 'settings', ip: ctx.ip,
          details: {
            before: Object.fromEntries(changed.map((f) => [f, before[f]])),
            after: Object.fromEntries(changed.map((f) => [f, input[f]])),
          },
        });
      }
      return current();
    });
    return { status: 200, body: { settings, palettes } };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/settings', handler: get, ...ga },
      { method: 'PATCH', path: '/api/settings', handler: update, ...ga },
    ],
  });
}
