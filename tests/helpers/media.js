/**
 * Archivos de prueba construidos byte a byte (sin binarios en el repositorio).
 *
 * - PNG: imagen real y decodificable (IHDR, IDAT comprimido, IEND, CRC correctos).
 * - JPEG y WebP: estructura válida del formato (marcadores, segmentos, bloques
 *   RIFF) con datos de imagen sintéticos; suficiente para el verificador, que
 *   recorre la estructura pero no decodifica.
 * - PDF: documento mínimo con tabla de referencias.
 */
import zlib from 'node:zlib';

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/**
 * @param {{ width?: number, height?: number, text?: string, exif?: boolean, trailing?: Buffer|string, extraChunks?: [string, string][] }} [o]
 */
export function makePng({ width = 2, height = 2, text, exif = false, trailing, extraChunks = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 2; // RGB
  const rows = [];
  const rowCount = Math.min(height, 64); // las de prueba grandes no necesitan datos reales
  for (let y = 0; y < rowCount; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(Math.min(width, 64) * 3, 0x80)]));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (text) parts.push(pngChunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1')));
  if (exif) parts.push(pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude', 'latin1')));
  for (const [type, data] of extraChunks) parts.push(pngChunk(type, Buffer.from(data)));
  parts.push(pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)));
  if (trailing) parts.push(Buffer.from(trailing));
  return Buffer.concat(parts);
}

const seg = (marker, payload) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};

/** EXIF (big endian) con orientación y un IFD de GPS ficticio. */
export function exifPayload({ orientation = 1, gps = true } = {}) {
  const entries = [[0x0112, 3, 1, orientation]];
  if (gps) entries.push([0x8825, 4, 1, 0]); // puntero GPS IFD
  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    tiff.writeUInt16BE(tag, o);
    tiff.writeUInt16BE(type, o + 2);
    tiff.writeUInt32BE(count, o + 4);
    if (type === 3) tiff.writeUInt16BE(value, o + 8);
    else tiff.writeUInt32BE(value, o + 8);
  });
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS 40.4168N 3.7038W', 'latin1')]);
}

/**
 * @param {{ width?: number, height?: number, orientation?: number|null, comment?: string, xmp?: boolean, trailing?: Buffer|string }} [o]
 */
export function makeJpeg({ width = 4, height = 3, orientation = null, comment, xmp = false, trailing } = {}) {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  for (let c = 0; c < 3; c++) sof.set([c + 1, 0x11, 0], 6 + c * 3);
  const sos = Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const parts = [Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))];
  if (orientation !== null) parts.push(seg(0xe1, exifPayload({ orientation })));
  if (xmp) parts.push(seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>autor</x:xmpmeta>', 'latin1')));
  if (comment) parts.push(seg(0xfe, Buffer.from(comment, 'latin1')));
  parts.push(
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), // DQT
    seg(0xc0, sof),
    seg(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)])), // DHT vacía
    seg(0xda, sos),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]), // datos con relleno y RST0
    Buffer.from([0xff, 0xd9]),
  );
  if (trailing) parts.push(Buffer.from(trailing));
  return Buffer.concat(parts);
}

function riffChunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** WebP sin pérdida (VP8L) o extendido (VP8X) con EXIF/XMP. */
export function makeWebp({ width = 3, height = 2, exif = false, xmp = false, trailing } = {}) {
  const vp8l = Buffer.alloc(10);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);
  const chunks = [];
  if (exif || xmp) {
    const x = Buffer.alloc(10);
    x[0] = (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
    x.writeUIntLE(width - 1, 4, 3);
    x.writeUIntLE(height - 1, 7, 3);
    chunks.push(riffChunk('VP8X', x));
  }
  chunks.push(riffChunk('VP8L', vp8l));
  if (exif) chunks.push(riffChunk('EXIF', exifPayload().subarray(6)));
  if (xmp) chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta>autor</x:xmpmeta>', 'latin1')));
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body, trailing ? Buffer.from(trailing) : Buffer.alloc(0)]);
}

/**
 * @param {{ extra?: string, compressed?: string, eof?: boolean }} [o]
 *   extra: texto añadido al catálogo; compressed: contenido de un flujo FlateDecode.
 */
export function makePdf({ extra = '', compressed, eof = true } = {}) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${extra}>>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objects.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')));
  if (compressed !== undefined) {
    const data = zlib.deflateSync(Buffer.from(compressed, 'latin1'));
    parts.push(Buffer.from(`${objects.length + 1} 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n${eof ? '%%EOF\n' : ''}`, 'latin1'));
  return Buffer.concat(parts);
}

/** Subida en bruto con un cliente de startApp().as(): `{ status, body }`. */
export function upload(client, sectionId, buffer, { type = 'image/png', name = 'foto.png', headers = {} } = {}) {
  return client.json(`/api/sections/${sectionId}/media`, {
    method: 'POST', body: buffer, headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...headers },
  });
}
