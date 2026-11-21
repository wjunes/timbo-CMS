/**
 * Acceso a permisos y asignaciones de secciones.
 */

/** @param {import('node:sqlite').DatabaseSync} db */
export function createPermissionRepository(db) {
  const catalog = db.prepare('SELECT id, code, description FROM permissions ORDER BY code');
  const assignments = db.prepare(`
    SELECT s.id, s.slug, s.name, s.status, us.assigned_at
    FROM user_sections AS us JOIN sections AS s ON s.id = us.section_id
    WHERE us.user_id = ? ORDER BY s.sort_order, s.id`);
  const grantsForUser = db.prepare(`
    SELECT usp.section_id, p.code
    FROM user_section_permissions AS usp JOIN permissions AS p ON p.id = usp.permission_id
    WHERE usp.user_id = ? ORDER BY p.code`);
  const grantsForAssignment = db.prepare(`
    SELECT p.code FROM user_section_permissions AS usp JOIN permissions AS p ON p.id = usp.permission_id
    WHERE usp.user_id = ? AND usp.section_id = ? ORDER BY p.code`);
  const assigned = db.prepare('SELECT 1 AS ok FROM user_sections WHERE user_id = ? AND section_id = ?');
  const insertAssignment = db.prepare('INSERT INTO user_sections (user_id, section_id, assigned_by) VALUES (?, ?, ?)');
  const deleteAssignment = db.prepare('DELETE FROM user_sections WHERE user_id = ? AND section_id = ?');
  const insertGrant = db.prepare(`
    INSERT INTO user_section_permissions (user_id, section_id, permission_id, granted_by)
    SELECT ?, ?, id, ? FROM permissions WHERE code = ?`);
  const deleteGrant = db.prepare(`
    DELETE FROM user_section_permissions
    WHERE user_id = ? AND section_id = ? AND permission_id = (SELECT id FROM permissions WHERE code = ?)`);
  const grantExists = db.prepare(`
    SELECT 1 AS ok
    FROM users AS u
    JOIN user_section_permissions AS usp ON usp.user_id = u.id
    JOIN permissions AS p ON p.id = usp.permission_id
    WHERE u.id = ? AND u.role = 'section_admin' AND u.status = 'active' AND usp.section_id = ? AND p.code = ?`);

  const codes = () => catalog.all().map((r) => r.code);

  /** Secciones asignadas a un usuario con sus permisos. */
  function accessForUser(userId) {
    const byId = new Map();
    for (const row of grantsForUser.all(userId)) {
      if (!byId.has(row.section_id)) byId.set(row.section_id, []);
      byId.get(row.section_id).push(row.code);
    }
    return assignments.all(userId).map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      status: s.status,
      assignedAt: s.assigned_at,
      permissions: byId.get(s.id) ?? [],
    }));
  }

  return Object.freeze({
    catalog: () => catalog.all().map(({ code, description }) => ({ code, description })),
    codes,
    accessForUser,
    isAssigned: (userId, sectionId) => assigned.get(userId, sectionId) !== undefined,
    permissionsOf: (userId, sectionId) => grantsForAssignment.all(userId, sectionId).map((r) => r.code),
    assign: (userId, sectionId, by) => insertAssignment.run(userId, sectionId, by),
    revoke: (userId, sectionId) => deleteAssignment.run(userId, sectionId).changes > 0,
    grant: (userId, sectionId, code, by) => insertGrant.run(userId, sectionId, by, code),
    ungrant: (userId, sectionId, code) => deleteGrant.run(userId, sectionId, code),
    hasGrant: (userId, sectionId, code) => grantExists.get(userId, sectionId, code) !== undefined,
  });
}
