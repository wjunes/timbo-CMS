/**
 * Configuración general del sitio (Bloque 10, D-056, solo general_admin).
 *
 * Una lista cerrada de ajustes editoriales, guardados en `settings` como JSON.
 * Son texto plano: el sitio público los escapa siempre, así que no admiten
 * HTML ni código. Cada cambio se audita con el valor anterior y el nuevo.
 */
import { withTransaction } from '../../database/transaction.js';
import { readJsonBody } from '../../middleware/http.js';
import { rules, validate } from '../../utils/validation.js';
import { createAuditLog } from '../audit/audit.js';

/** Campo de la API → clave en `settings`, regla y valor por defecto. */
export const SITE_SETTINGS = Object.freeze({
  siteName: { key: 'site.name', rule: rules.string({ min: 1, max: 120, optional: true }), fallback: 'CMS-MULTISECCIÓN' },
  siteDescription: { key: 'site.description', rule: rules.string({ max: 300, optional: true }), fallback: '' },
});

/** @param {{ db: import('node:sqlite').DatabaseSync }} deps */
export function createSettingsModule({ db }) {
  const audit = createAuditLog(db);
  const read = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(`INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  function current() {
    const out = {};
    for (const [field, { key, fallback }] of Object.entries(SITE_SETTINGS)) {
      const row = read.get(key);
      let value = fallback;
      if (row) {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string') value = parsed;
      }
      out[field] = value;
    }
    return out;
  }

  function get() {
    return { status: 200, body: { settings: current() } };
  }

  async function update(ctx) {
    const schema = Object.fromEntries(Object.entries(SITE_SETTINGS).map(([f, s]) => [f, s.rule]));
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
    return { status: 200, body: { settings } };
  }

  const ga = { auth: true, role: 'general_admin' };
  return Object.freeze({
    routes: [
      { method: 'GET', path: '/api/settings', handler: get, ...ga },
      { method: 'PATCH', path: '/api/settings', handler: update, ...ga },
    ],
  });
}
