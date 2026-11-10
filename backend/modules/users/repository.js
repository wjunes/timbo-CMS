/**
 * Acceso a la tabla `users`.
 */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const PUBLIC_COLUMNS =
  'id, username, email, display_name, role, status, must_change_password, password_changed_at, created_at, updated_at';

/** @param {import('node:sqlite').DatabaseSync} db */
export function createUserRepository(db) {
  const byUsername = db.prepare(
    'SELECT id, username, display_name, password_hash, role, status, must_change_password FROM users WHERE username = ?',
  );
  const byId = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`);
  const hashById = db.prepare('SELECT password_hash FROM users WHERE id = ?');
  const all = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role, username`);
  const generalAdmin = db.prepare("SELECT id, username, display_name, password_hash, role, status FROM users WHERE role = 'general_admin'");
  const insertGeneralAdmin = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, role, password_changed_at) VALUES (?, ?, ?, ?, 'general_admin', ${NOW})`,
  );
  const insertSectionAdmin = db.prepare(`
    INSERT INTO users (username, email, display_name, password_hash, role, must_change_password, created_by)
    VALUES (?, ?, ?, ?, 'section_admin', 1, ?)`);
  const rehash = db.prepare(`UPDATE users SET password_hash = ?, updated_at = ${NOW} WHERE id = ?`);
  const setPassword = db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`,
  );
  const setStatus = db.prepare(`UPDATE users SET status = ?, updated_at = ${NOW} WHERE id = ?`);
  const setDisplayName = db.prepare(`UPDATE users SET display_name = ?, updated_at = ${NOW} WHERE id = ?`);
  const setEmail = db.prepare(`UPDATE users SET email = ?, updated_at = ${NOW} WHERE id = ?`);

  return Object.freeze({
    /** Búsqueda sin distinguir mayúsculas (COLLATE NOCASE en el esquema). Incluye el hash: solo para autenticación. */
    findByUsername: (username) => byUsername.get(username),
    findById: (id) => byId.get(id),
    passwordHashOf: (id) => hashById.get(id)?.password_hash,
    list: () => all.all(),
    findGeneralAdmin: () => generalAdmin.get(),
    createGeneralAdmin: ({ username, email, displayName, passwordHash }) =>
      Number(insertGeneralAdmin.run(username, email, displayName, passwordHash).lastInsertRowid),
    /** Alta de un section_admin con contraseña temporal (cambio obligatorio). */
    createSectionAdmin: ({ username, email, displayName, passwordHash, createdBy }) =>
      Number(insertSectionAdmin.run(username, email, displayName, passwordHash, createdBy).lastInsertRowid),
    /** Recalcular el hash con parámetros nuevos (misma contraseña): no cuenta como cambio de contraseña. */
    updatePasswordHash: (userId, passwordHash) => rehash.run(passwordHash, userId).changes > 0,
    /** Nueva contraseña. mustChange=true para contraseñas temporales fijadas por el administrador. */
    setPassword: (userId, passwordHash, { mustChange }) => setPassword.run(passwordHash, mustChange ? 1 : 0, userId).changes > 0,
    setStatus: (userId, status) => setStatus.run(status, userId).changes > 0,
    updateProfile(userId, { displayName, email }) {
      if (displayName !== undefined) setDisplayName.run(displayName, userId);
      if (email !== undefined) setEmail.run(email, userId);
    },
  });
}

/** Representación pública (sin hash) de una fila de usuario. */
export function toPublicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
