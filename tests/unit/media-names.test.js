import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../backend/middleware/http.js';
import { contentDisposition, parseFileName } from '../../backend/modules/media/index.js';

const fails = (header, code) =>
  assert.throws(() => parseFileName(header), (err) => err instanceof HttpError && err.body === undefined && err.details.fields.fileName === code, `${header} → ${code}`);

describe('nombre original de un archivo subido', () => {
  it('decodifica, normaliza y obtiene la extensión en minúsculas', () => {
    assert.deepEqual(parseFileName(encodeURIComponent('Fachada del Ayuntamiento.JPG')), { name: 'Fachada del Ayuntamiento.JPG', extension: 'jpg' });
    assert.deepEqual(parseFileName(encodeURIComponent('Cafe\u0301 año.png')).name, 'Café año.png');
    assert.equal(parseFileName(encodeURIComponent('informe.final.v2.pdf')).extension, 'pdf');
  });

  it('rechaza rutas, caracteres de control y nombres sin extensión', () => {
    fails(undefined, 'required');
    fails('', 'required');
    for (const n of ['../../etc/passwd.png', '..\\..\\win.ini.png', 'a/b.png', 'C:\\x\\y.png']) fails(encodeURIComponent(n), 'invalid_characters');
    fails(encodeURIComponent('a\r\nSet-Cookie: x.png'), 'invalid_characters');
    fails(encodeURIComponent('nul\u0000.png'), 'invalid_characters');
    fails(encodeURIComponent('sin-extension'), 'extension_required');
    fails(encodeURIComponent('.png'), 'extension_required');
    fails(encodeURIComponent('a.p_g'), 'extension_required');
    fails('%E0%A4%A', 'invalid_format');
    fails(encodeURIComponent(`${'a'.repeat(252)}.png`), 'too_long');
  });

  it('Content-Disposition seguro, con alternativa ASCII', () => {
    assert.equal(contentDisposition('attachment', 'Informe "final"; año.pdf'),
      `attachment; filename="Informe _final__ a_o.pdf"; filename*=UTF-8''Informe%20%22final%22%3B%20a%C3%B1o.pdf`);
  });
});
