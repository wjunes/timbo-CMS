import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { IMAGE_LIMITS, MediaError, exifOrientation, inspectFile, sniffType } from '../../backend/modules/media/inspect.js';
import { makeJpeg, makePdf, makePng, makeWebp } from '../helpers/media.js';

const rejects = (buf, type, code) =>
  assert.throws(() => inspectFile(buf, type), (err) => err instanceof MediaError && err.code === code, `se esperaba ${code}`);
const has = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

describe('verificación de archivos: tipo real', () => {
  it('reconoce cada formato por su firma', () => {
    assert.equal(sniffType(makePng()), 'image/png');
    assert.equal(sniffType(makeJpeg()), 'image/jpeg');
    assert.equal(sniffType(makeWebp()), 'image/webp');
    assert.equal(sniffType(makePdf()), 'application/pdf');
    assert.equal(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });

  it('rechaza un archivo cuyo contenido no es del tipo declarado', () => {
    rejects(Buffer.from('<?php system($_GET["c"]); ?>'), 'image/png', 'content_mismatch'); // PHP renombrado a .png
    rejects(Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', 'content_mismatch');
    rejects(makeJpeg(), 'image/png', 'content_mismatch');
    rejects(makePng(), 'application/pdf', 'content_mismatch');
    rejects(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/webp', 'content_mismatch');
  });

  it('rechaza HTML o código con la firma de una imagen delante', () => {
    const sig = makePng().subarray(0, 8);
    rejects(Buffer.concat([sig, Buffer.from('<script>alert(1)</script>')]), 'image/png', 'file_corrupt');
    rejects(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<?php echo 1; ?>')]), 'image/jpeg', 'file_corrupt');
    rejects(Buffer.from('RIFF\x10\x00\x00\x00WEBP<script>alert(1)</script>', 'latin1'), 'image/webp', 'file_corrupt');
  });

  it('rechaza archivos truncados o con la estructura dañada', () => {
    const png = makePng();
    rejects(png.subarray(0, png.length - 12), 'image/png', 'file_corrupt'); // sin IEND
    const badCrc = Buffer.from(png);
    badCrc[30] ^= 0xff;
    rejects(badCrc, 'image/png', 'file_corrupt');
    const jpeg = makeJpeg();
    rejects(jpeg.subarray(0, jpeg.length - 2), 'image/jpeg', 'file_corrupt'); // sin EOI
    rejects(makePdf({ eof: false }), 'application/pdf', 'file_corrupt');
    rejects(makePng({ extraChunks: [['ZZZZ', 'x']] }), 'image/png', 'file_corrupt'); // bloque crítico desconocido
  });

  it('aplica el límite de dimensiones', () => {
    rejects(makePng({ width: IMAGE_LIMITS.maxSide + 1, height: 1 }), 'image/png', 'image_too_large');
    rejects(makePng({ width: 10_000, height: 10_000 }), 'image/png', 'image_too_large');
    rejects(makeJpeg({ width: 20_001, height: 10 }), 'image/jpeg', 'image_too_large');
    rejects(makeWebp({ width: 16_000, height: 16_000 }), 'image/webp', 'image_too_large');
    rejects(makePng({ width: 0, height: 5 }), 'image/png', 'file_corrupt');
  });
});

describe('verificación de archivos: metadatos', () => {
  it('PNG: devuelve las dimensiones y conserva un archivo limpio tal cual', () => {
    const png = makePng({ width: 5, height: 7 });
    const out = inspectFile(png, 'image/png');
    assert.deepEqual([out.width, out.height, out.metadataRemoved], [5, 7, false]);
    assert.equal(out.buffer, png);
  });

  it('PNG: elimina textos, EXIF y lo que hay después de IEND', () => {
    const out = inspectFile(makePng({ text: 'Autora: Ana', exif: true, trailing: '<?php echo 1; ?>' }), 'image/png');
    assert.equal(out.metadataRemoved, true);
    for (const t of ['tEXt', 'Autora', 'eXIf', 'GPS', '<?php']) assert.equal(has(out.buffer, t), false, t);
    assert.deepEqual(inspectFile(out.buffer, 'image/png').metadataRemoved, false); // el resultado es un PNG válido
  });

  it('elimina los datos añadidos tras el final del formato aunque no haya metadatos (políglotas)', () => {
    const tail = 'PK\x03\x04<?php echo 1; ?>';
    for (const [buf, type] of [[makePng({ trailing: tail }), 'image/png'], [makeJpeg({ trailing: tail }), 'image/jpeg'], [makeWebp({ trailing: tail }), 'image/webp']]) {
      const out = inspectFile(buf, type);
      assert.equal(out.metadataRemoved, true, type);
      assert.equal(has(out.buffer, '<?php'), false, type);
      assert.equal(out.buffer.length, buf.length - tail.length, type);
    }
  });

  it('JPEG: elimina EXIF (GPS), XMP, comentarios y datos tras EOI, y conserva la orientación', () => {
    const out = inspectFile(makeJpeg({ width: 4, height: 3, orientation: 6, comment: 'camara', xmp: true, trailing: 'PK\x03\x04zip' }), 'image/jpeg');
    assert.equal(out.metadataRemoved, true);
    for (const t of ['GPS', 'camara', 'xmpmeta', 'PK']) assert.equal(has(out.buffer, t), false, t);
    // Orientación 6 (girada 90°): se conserva un EXIF mínimo y las dimensiones son las visibles.
    assert.deepEqual([out.width, out.height], [3, 4]);
    const app1 = out.buffer.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    assert.ok(app1 > 0);
    assert.equal(exifOrientation(out.buffer.subarray(app1)), 6);
    assert.equal(inspectFile(out.buffer, 'image/jpeg').width, 3); // sigue siendo un JPEG válido
  });

  it('JPEG: sin orientación no deja ningún EXIF', () => {
    const out = inspectFile(makeJpeg({ orientation: 1 }), 'image/jpeg');
    assert.equal(has(out.buffer, 'Exif'), false);
    assert.deepEqual([out.width, out.height], [4, 3]);
  });

  it('WebP: elimina EXIF y XMP, corrige las marcas de VP8X y el tamaño RIFF', () => {
    const out = inspectFile(makeWebp({ width: 3, height: 2, exif: true, xmp: true, trailing: 'basura' }), 'image/webp');
    assert.equal(out.metadataRemoved, true);
    for (const t of ['EXIF', 'XMP ', 'GPS', 'basura']) assert.equal(has(out.buffer, t), false, t);
    assert.equal(out.buffer.readUInt32LE(4), out.buffer.length - 8);
    assert.equal(out.buffer[20] & 0x0c, 0); // marcas EXIF/XMP apagadas
    assert.deepEqual([out.width, out.height], [3, 2]);
    assert.equal(inspectFile(out.buffer, 'image/webp').metadataRemoved, false);
  });
});

describe('verificación de archivos: PDF', () => {
  it('acepta un PDF sin contenido activo', () => {
    const out = inspectFile(makePdf(), 'application/pdf');
    assert.deepEqual([out.width, out.height], [null, null]);
  });

  for (const [label, extra] of [
    ['JavaScript', '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'],
    ['acción Launch', '/OpenAction << /S /Launch /F (cmd.exe) >>'],
    ['archivo incrustado', '/Names << /EmbeddedFiles 9 0 R >>'],
    ['formulario XFA', '/AcroForm << /XFA 9 0 R >>'],
    ['nombre con escapes #xx', '/OpenAction << /S /J#61vaScript /J#53 (x) >>'],
  ]) {
    it(`rechaza ${label}`, () => rejects(makePdf({ extra }), 'application/pdf', 'pdf_active_content'));
  }

  it('rechaza JavaScript escondido en un flujo comprimido', () => {
    rejects(makePdf({ compressed: '5 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj' }), 'application/pdf', 'pdf_active_content');
    inspectFile(makePdf({ compressed: '5 0 obj << /Type /Font /Subtype /Type1 >> endobj' }), 'application/pdf');
  });

  it('limita la descompresión (bombas de compresión)', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(130 * 1024 * 1024));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n', 'latin1'), bomb,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n', 'latin1'),
    ]);
    rejects(pdf, 'application/pdf', 'pdf_too_complex');
  });
});
