import assert from 'node:assert/strict';
import { argon2Sync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  DEFAULT_PARAMS,
  PasswordHasherBusyError,
  checkPasswordPolicy,
  createPasswordHasher,
  parsePhc,
} from '../../backend/modules/auth/password.js';

// Parámetros reducidos para pruebas rápidas (el formato y la lógica son los mismos).
const FAST = { memory: 1024, passes: 1, parallelism: 1 };
const fast = createPasswordHasher({ params: FAST });

describe('Argon2id nativo', () => {
  it('reproduce el vector de prueba de RFC 9106 §5.3 (argon2id)', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    assert.equal(tag.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });
});

describe('createPasswordHasher', () => {
  it('con los parámetros por defecto genera un hash PHC Argon2id de 64 MiB, t=3, p=4', async () => {
    const hasher = createPasswordHasher();
    const phc = await hasher.hash('una contraseña bastante larga');
    assert.match(phc, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    assert.equal(await hasher.verify('una contraseña bastante larga', phc), true);
    assert.equal(hasher.needsRehash(phc), false);
    assert.deepEqual(DEFAULT_PARAMS, { memory: 65_536, passes: 3, parallelism: 4 });
  });

  it('usa una sal distinta en cada hash', async () => {
    const a = await fast.hash('misma-contraseña-123');
    const b = await fast.hash('misma-contraseña-123');
    assert.notEqual(a, b);
  });

  it('rechaza contraseñas incorrectas', async () => {
    const phc = await fast.hash('correcta-correcta');
    assert.equal(await fast.verify('incorrecta-incorrecta', phc), false);
    assert.equal(await fast.verify('Correcta-correcta', phc), false);
    assert.equal(await fast.verify('', phc), false);
  });

  it('normaliza Unicode (NFC): formas compuesta y descompuesta coinciden', async () => {
    const composed = 'contraseña-larga'; // ñ = U+00F1
    const decomposed = 'contraseña-larga'; // n + tilde combinante
    assert.notEqual(composed, decomposed);
    assert.equal(await fast.verify(decomposed, await fast.hash(composed)), true);
  });

  it('devuelve false (sin lanzar) ante hashes mal formados o entradas inválidas', async () => {
    for (const bad of ['', 'texto', '$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', null, 42]) {
      assert.equal(await fast.verify('x', bad), false);
    }
    const phc = await fast.hash('correcta-correcta');
    assert.equal(await fast.verify(null, phc), false);
    assert.equal(await fast.verify('a'.repeat(2000), phc), false);
  });

  it('no acepta parámetros desmedidos en un hash almacenado (DoS)', () => {
    const base = 'c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
    assert.equal(parsePhc(`$argon2id$v=19$m=4194304,t=3,p=4$${base}`), null);
    assert.equal(parsePhc(`$argon2id$v=19$m=65536,t=1000,p=4$${base}`), null);
    assert.equal(parsePhc(`$argon2id$v=19$m=65536,t=3,p=255$${base}`), null);
    assert.equal(parsePhc(`$argon2id$v=16$m=65536,t=3,p=4$${base}`), null);
    assert.ok(parsePhc(`$argon2id$v=19$m=65536,t=3,p=4$${base}`));
  });

  it('needsRehash detecta parámetros distintos de los vigentes', async () => {
    const phc = await fast.hash('correcta-correcta');
    assert.equal(fast.needsRehash(phc), false);
    assert.equal(createPasswordHasher().needsRehash(phc), true);
    assert.equal(fast.needsRehash('basura'), true);
  });

  it('verifyDummy siempre devuelve false y realiza el cálculo', async () => {
    assert.equal(await fast.verifyDummy('cualquiera'), false);
    assert.equal(await fast.verifyDummy(undefined), false);
  });

  it('limita la concurrencia y rechaza cuando la cola se llena', async () => {
    const limited = createPasswordHasher({ params: FAST, maxConcurrent: 1, maxQueue: 1 });
    const results = await Promise.allSettled([limited.hash('aaaaaaaaaaaa1'), limited.hash('aaaaaaaaaaaa2'), limited.hash('aaaaaaaaaaaa3')]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'rejected');
    assert.ok(results[2].reason instanceof PasswordHasherBusyError);
  });
});

describe('checkPasswordPolicy', () => {
  it('acepta frases largas sin reglas de composición', () => {
    assert.deepEqual(checkPasswordPolicy('caballo correcto batería grapa'), []);
    assert.deepEqual(checkPasswordPolicy('ñandú-pingüino-42'), []);
  });

  it('exige entre 12 y 128 caracteres (contados como caracteres, no bytes)', () => {
    assert.match(checkPasswordPolicy('corta-11ch')[0], /al menos 12/);
    assert.deepEqual(checkPasswordPolicy('ñ'.repeat(12).replace(/^ñ/, 'a')), []);
    assert.match(checkPasswordPolicy('a1'.repeat(65)).join(), /128/);
  });

  it('rechaza contraseñas que contienen el usuario, repetitivas, en blanco o con caracteres de control', () => {
    assert.match(checkPasswordPolicy('admin-admin-admin', { username: 'Admin' }).join(), /nombre de usuario/);
    assert.match(checkPasswordPolicy('aaaaaaaaaaaaaaaa').join(), /repetido/);
    assert.match(checkPasswordPolicy(' '.repeat(14)).join(), /espacios/);
    assert.match(checkPasswordPolicy('contraseña\u0000larga').join(), /control/);
    assert.deepEqual(checkPasswordPolicy(undefined), ['La contraseña es obligatoria']);
  });
});
