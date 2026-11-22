/**
 * Cadena de huellas de la auditoría (D-059).
 *
 * Cada entrada tiene en `audit_chain` la huella
 *   SHA-256(huella anterior + "\n" + forma canónica de la entrada)
 * y la primera parte de GENESIS. Cambiar, borrar o intercalar una entrada
 * rompe la cadena desde ese punto. No lleva clave: quien pueda escribir en el
 * archivo puede recalcular toda la cadena, y eso se detecta comparando con la
 * última huella guardada en cada copia de seguridad (anclas).
 */
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

const COLUMNS = 'id, occurred_at, actor_user_id, action, outcome, entity_type, entity_id, section_id, ip_address, details';

/** Forma canónica: un array JSON con las columnas en orden fijo. */
export function canonical(row) {
  return JSON.stringify([row.id, row.occurred_at, row.actor_user_id, row.action, row.outcome, row.entity_type,
    row.entity_id, row.section_id, row.ip_address, row.details]);
}

export const chainHash = (prev, row) => createHash('sha256').update(`${prev}\n${canonical(row)}`, 'utf8').digest('hex');

/** @param {import('node:sqlite').DatabaseSync} db */
export function createAuditChain(db) {
  const head = db.prepare('SELECT audit_id AS id, hash FROM audit_chain ORDER BY audit_id DESC LIMIT 1');
  const unsealed = db.prepare(`SELECT ${COLUMNS} FROM audit_logs WHERE id > ? ORDER BY id`);
  const insert = db.prepare('INSERT INTO audit_chain (audit_id, hash) VALUES (?, ?)');
  const walk = db.prepare(`SELECT ${COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}, c.hash AS chain_hash
    FROM audit_logs AS a LEFT JOIN audit_chain AS c ON c.audit_id = a.id ORDER BY a.id`);

  /**
   * Encadena las entradas que aún no tienen huella. Debe ejecutarse dentro de la
   * misma transacción que la inserción en audit_logs.
   */
  function seal() {
    const last = head.get();
    let prev = last?.hash ?? GENESIS;
    for (const row of unsealed.iterate(last?.id ?? 0)) {
      prev = chainHash(prev, row);
      insert.run(row.id, prev);
    }
  }

  /**
   * Recorre toda la cadena. `anchors`: huellas conocidas de fuera de la base
   * (las de las copias de seguridad); cada una debe seguir en la cadena.
   * @param {{ source: string, id: number, hash: string }[]} [anchors]
   */
  function verify(anchors = []) {
    const pendingAnchors = new Map();
    for (const a of anchors) if (a?.id) pendingAnchors.set(a.id, [...(pendingAnchors.get(a.id) ?? []), a]);
    let prev = GENESIS;
    let checked = 0;
    let unchained = 0;
    let lastId = 0;
    let headId = 0;
    const problems = [];
    for (const row of walk.iterate()) {
      lastId = row.id;
      if (row.chain_hash === null) {
        unchained += 1;
        continue;
      }
      if (unchained > 0) {
        problems.push({ id: row.id, reason: 'gap' });
        break;
      }
      const expected = chainHash(prev, row);
      if (expected !== row.chain_hash) {
        problems.push({ id: row.id, reason: 'hash_mismatch' });
        break;
      }
      for (const a of pendingAnchors.get(row.id) ?? []) {
        if (a.hash !== row.chain_hash) problems.push({ id: row.id, reason: 'anchor_mismatch', source: a.source });
      }
      pendingAnchors.delete(row.id);
      prev = row.chain_hash;
      headId = row.id;
      checked += 1;
    }
    // Un ancla de una entrada que ya no existe: se borraron entradas del final (o de en medio).
    if (problems.length === 0) {
      for (const list of pendingAnchors.values()) {
        for (const a of list) problems.push({ id: a.id, reason: 'anchor_missing', source: a.source });
      }
    }
    return { ok: problems.length === 0, checked, unchained, lastId, head: headId ? { id: headId, hash: prev } : null, problems };
  }

  return Object.freeze({ seal, verify, head: () => head.get() ?? null });
}
