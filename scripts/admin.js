/**
 * Gestión del administrador general desde la consola del servidor (D-018).
 *
 *   node scripts/admin.js create           Crea la única cuenta general_admin.
 *   node scripts/admin.js reset-password   Cambia su contraseña y revoca todas sus sesiones.
 *
 * Es el único modo de crear o recuperar el general_admin: requiere acceso al
 * servidor (no es accesible por HTTP) y cada operación queda en la auditoría.
 * La contraseña se pide de forma oculta; nunca se acepta como argumento (quedaría
 * en el historial del shell y en la lista de procesos). Sin TTY (p. ej. una
 * tubería en automatizaciones) las respuestas se leen línea a línea de stdin.
 */
import readline from 'node:readline';
import { ConfigError, MEMORY_DB, loadConfig } from '../backend/config/index.js';
import { closeDatabase, openDatabase } from '../backend/database/connection.js';
import { assertSchemaCurrent } from '../backend/database/migrator.js';
import { withTransaction } from '../backend/database/transaction.js';
import { createAuditLog } from '../backend/modules/audit/audit.js';
import { checkPasswordPolicy, createPasswordHasher } from '../backend/modules/auth/password.js';
import { createSessionStore } from '../backend/modules/auth/sessions.js';
import { createUserRepository } from '../backend/modules/users/repository.js';

const COMMANDS = ['create', 'reset-password'];

class UserFacingError extends Error {}

function createPrompter() {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  let muted = false;
  if (interactive) {
    // Oculta el eco de lo que se teclea mientras se pide una contraseña.
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => (muted ? undefined : write(text));
  }
  const lines = interactive ? null : rl[Symbol.asyncIterator]();

  async function ask(question, { hidden = false } = {}) {
    if (!interactive) {
      const { value, done } = await lines.next();
      if (done) throw new UserFacingError(`Entrada incompleta: falta "${question.trim()}"`);
      return value;
    }
    process.stdout.write(question);
    muted = hidden;
    const answer = await new Promise((resolve) => rl.question('', resolve));
    muted = false;
    if (hidden) process.stdout.write('\n');
    return answer;
  }

  return { ask, close: () => rl.close() };
}

async function askNewPassword(prompter, username) {
  const password = await prompter.ask('Contraseña: ', { hidden: true });
  const issues = checkPasswordPolicy(password, { username });
  if (issues.length) throw new UserFacingError(`Contraseña no válida:\n  - ${issues.join('\n  - ')}`);
  const confirmation = await prompter.ask('Repita la contraseña: ', { hidden: true });
  if (confirmation !== password) throw new UserFacingError('Las contraseñas no coinciden');
  return password;
}

async function create({ db, users, audit, hasher, prompter }) {
  if (users.findGeneralAdmin()) throw new UserFacingError('Ya existe un administrador general. Use "reset-password" para recuperar el acceso.');

  const username = (await prompter.ask('Usuario: ')).trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new UserFacingError('Usuario inválido (3-64 caracteres: letras, números, punto, guion, guion bajo)');
  const email = (await prompter.ask('Email: ')).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new UserFacingError('Email inválido');
  const displayName = (await prompter.ask('Nombre visible: ')).trim();
  if (displayName.length < 1 || displayName.length > 120) throw new UserFacingError('Nombre visible inválido (1-120 caracteres)');
  const password = await askNewPassword(prompter, username);

  const passwordHash = await hasher.hash(password);
  const id = withTransaction(db, () => {
    const userId = users.createGeneralAdmin({ username, email, displayName, passwordHash });
    audit.record({ action: 'user.create', outcome: 'success', entityType: 'user', entityId: userId, details: { role: 'general_admin', via: 'cli' } });
    return userId;
  });
  process.stdout.write(`Administrador general "${username}" creado (id ${id}).\n`);
}

async function resetPassword({ db, users, audit, hasher, prompter, sessions }) {
  const admin = users.findGeneralAdmin();
  if (!admin) throw new UserFacingError('No existe administrador general. Use "create".');
  process.stdout.write(`Nueva contraseña para el administrador general "${admin.username}".\n`);
  const password = await askNewPassword(prompter, admin.username);

  const passwordHash = await hasher.hash(password);
  const revoked = withTransaction(db, () => {
    users.setPassword(admin.id, passwordHash, { mustChange: false });
    const count = sessions.revokeAllForUser(admin.id, 'password_reset');
    audit.record({ action: 'auth.password_reset', outcome: 'success', entityType: 'user', entityId: admin.id, details: { via: 'cli', revokedCount: count } });
    return count;
  });
  process.stdout.write(`Contraseña actualizada. Sesiones revocadas: ${revoked}.\n`);
}

async function main() {
  const command = process.argv[2];
  if (!COMMANDS.includes(command)) throw new UserFacingError(`Uso: node scripts/admin.js <${COMMANDS.join('|')}>`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) throw new UserFacingError(err.message);
    throw err;
  }
  if (config.databasePath === MEMORY_DB) throw new UserFacingError('DATABASE_PATH=":memory:" no tiene sentido para esta herramienta');

  let db;
  try {
    db = openDatabase(config.databasePath, { create: false });
    assertSchemaCurrent(db);
  } catch (err) {
    if (db) closeDatabase(db);
    throw new UserFacingError(err.message);
  }

  const prompter = createPrompter();
  try {
    const deps = {
      db,
      prompter,
      users: createUserRepository(db),
      audit: createAuditLog(db),
      hasher: createPasswordHasher(),
      sessions: createSessionStore(db, config.session),
    };
    await (command === 'create' ? create(deps) : resetPassword(deps));
  } finally {
    prompter.close();
    closeDatabase(db);
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(err instanceof UserFacingError ? `${err.message}\n` : `Error: ${err.message}\n`);
  process.exitCode = 1;
}
