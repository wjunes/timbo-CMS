import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, redact } from '../../backend/utils/logger.js';

function capture(options) {
  const lines = [];
  const logger = createLogger({ ...options, write: (stream, line) => lines.push({ stream, entry: JSON.parse(line) }) });
  return { logger, lines };
}

describe('logger', () => {
  it('emite JSON con time, level y msg', () => {
    const { logger, lines } = capture({ level: 'info' });
    logger.info('hola', { a: 1 });
    assert.equal(lines.length, 1);
    const { entry, stream } = lines[0];
    assert.equal(stream, 'stdout');
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'hola');
    assert.equal(entry.a, 1);
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
  });

  it('filtra por nivel y envía warn/error a stderr', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    assert.deepEqual(
      lines.map((l) => [l.entry.level, l.stream]),
      [
        ['warn', 'stderr'],
        ['error', 'stderr'],
      ],
    );
  });

  it('rechaza niveles desconocidos', () => {
    assert.throws(() => createLogger({ level: 'trace' }), TypeError);
  });

  it('redacta claves sensibles, también anidadas y en arrays', () => {
    const { logger, lines } = capture({ level: 'info' });
    logger.info('login', {
      user: 'ana',
      password: 'p4ss',
      nested: { sessionToken: 'abc', ok: true },
      list: [{ apiKey: 'k' }],
      headers: { Authorization: 'Bearer x', cookie: 'sid=1' },
    });
    const text = JSON.stringify(lines[0].entry);
    for (const secret of ['p4ss', 'abc', '"k"', 'Bearer x', 'sid=1']) {
      assert.ok(!text.includes(secret), `se filtró ${secret}`);
    }
    assert.equal(lines[0].entry.user, 'ana');
    assert.equal(lines[0].entry.nested.ok, true);
  });

  it('serializa errores y omite stack si includeStack=false', () => {
    const { logger, lines } = capture({ level: 'info', includeStack: false });
    const err = Object.assign(new Error('fallo'), { code: 'E_X' });
    logger.error('x', { err });
    assert.deepEqual(lines[0].entry.err, { name: 'Error', message: 'fallo', code: 'E_X' });
  });

  it('redact limita la profundidad', () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < 10; i++) deep = deep.child = {};
    assert.match(JSON.stringify(redact(root)), /\[Truncated\]/);
  });
});
