import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { HttpError, clientIp, isSameOriginRequest, parseCookies, readJsonBody, serializeCookie } from '../../backend/middleware/http.js';
import { createRateLimiter } from '../../backend/modules/auth/rate-limiter.js';

function fakeReq(body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.headers = headers;
  req.socket = { remoteAddress: '10.0.0.1' };
  return req;
}

async function expectHttpError(promise, status, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe('cookies', () => {
  it('parsea cookies, conserva la primera aparición e ignora entradas mal formadas', () => {
    const c = parseCookies('a=1; b=dos; a=3; =x; mala; c="comillas"; d=ok');
    assert.equal(c.get('a'), '1');
    assert.equal(c.get('b'), 'dos');
    assert.equal(c.get('d'), 'ok');
    assert.equal(c.has('c'), false);
    assert.equal(parseCookies(undefined).size, 0);
    assert.equal(parseCookies('x'.repeat(9000)).size, 0);
  });

  it('serializa con atributos seguros por defecto', () => {
    assert.equal(serializeCookie('s', 'v', { maxAge: 60 }), 's=v; Path=/; SameSite=Strict; Max-Age=60; HttpOnly; Secure');
    assert.equal(serializeCookie('s', 'v', { secure: false }), 's=v; Path=/; SameSite=Strict; HttpOnly');
    assert.throws(() => serializeCookie('s', 'v; Domain=evil'), TypeError);
  });
});

describe('readJsonBody', () => {
  it('lee un objeto JSON', async () => {
    assert.deepEqual(await readJsonBody(fakeReq('{"a":1}', { 'content-type': 'application/json; charset=utf-8' })), { a: 1 });
  });

  it('exige Content-Type application/json', async () => {
    await expectHttpError(readJsonBody(fakeReq('{}', { 'content-type': 'text/plain' })), 415, 'unsupported_media_type');
    await expectHttpError(readJsonBody(fakeReq('{}', {})), 415, 'unsupported_media_type');
  });

  it('limita el tamaño (declarado y real)', async () => {
    const h = { 'content-type': 'application/json' };
    await expectHttpError(readJsonBody(fakeReq('{}', { ...h, 'content-length': '999999' }), { limit: 100 }), 413, 'payload_too_large');
    await expectHttpError(readJsonBody(fakeReq(JSON.stringify({ a: 'x'.repeat(200) }), h), { limit: 100 }), 413, 'payload_too_large');
  });

  it('rechaza JSON inválido y valores que no son objetos', async () => {
    const h = { 'content-type': 'application/json' };
    await expectHttpError(readJsonBody(fakeReq('{mal', h)), 400, 'invalid_json');
    for (const body of ['[1]', '"x"', 'null', '1']) await expectHttpError(readJsonBody(fakeReq(body, h)), 400, 'invalid_body');
  });
});

describe('clientIp', () => {
  it('ignora X-Forwarded-For si no se confía en el proxy', () => {
    assert.equal(clientIp(fakeReq(undefined, { 'x-forwarded-for': '1.2.3.4' }), false), '10.0.0.1');
  });

  it('con proxy de confianza toma la entrada más a la derecha', () => {
    assert.equal(clientIp(fakeReq(undefined, { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }), true), '1.2.3.4');
    assert.equal(clientIp(fakeReq(undefined, { 'x-forwarded-for': 'basura<script>' }), true), '10.0.0.1');
  });
});

describe('isSameOriginRequest', () => {
  const origin = 'https://cms.example.org';
  it('acepta Origin igual o Sec-Fetch-Site same-origin', () => {
    assert.equal(isSameOriginRequest(fakeReq(undefined, { origin }), origin), true);
    assert.equal(isSameOriginRequest(fakeReq(undefined, { 'sec-fetch-site': 'same-origin' }), origin), true);
  });
  it('rechaza otros orígenes, "null", same-site y peticiones sin indicadores', () => {
    assert.equal(isSameOriginRequest(fakeReq(undefined, { origin: 'https://evil.example' }), origin), false);
    assert.equal(isSameOriginRequest(fakeReq(undefined, { origin: 'null' }), origin), false);
    assert.equal(isSameOriginRequest(fakeReq(undefined, { origin: 'https://cms.example.org.evil.example' }), origin), false);
    assert.equal(isSameOriginRequest(fakeReq(undefined, { 'sec-fetch-site': 'same-site' }), origin), false);
    assert.equal(isSameOriginRequest(fakeReq(undefined, {}), origin), false);
  });
});

describe('createRateLimiter', () => {
  it('limita tras el máximo y se restablece al terminar la ventana', () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, clock: () => now });
    assert.equal(rl.check('k').limited, false);
    rl.hit('k');
    rl.hit('k');
    const r = rl.check('k');
    assert.equal(r.limited, true);
    assert.equal(r.retryAfterSeconds, 1);
    assert.equal(rl.check('otra').limited, false);
    now = 1000;
    assert.equal(rl.check('k').limited, false);
  });

  it('reset borra el contador', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    rl.hit('k');
    rl.reset('k');
    assert.equal(rl.check('k').limited, false);
  });

  it('acota el número de claves (sin agotamiento de memoria)', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) rl.hit(`k${i}`);
    assert.equal(rl.size(), 100);
  });
});
