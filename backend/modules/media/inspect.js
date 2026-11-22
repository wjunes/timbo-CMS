/**
 * Verificación del contenido real de los archivos subidos (Bloque 08).
 *
 * Funciones puras sobre un Buffer, sin dependencias. Para cada tipo admitido:
 * - comprueba la firma y recorre la estructura completa del formato (no basta
 *   con los primeros bytes): un archivo truncado, con bloques que no cuadran o
 *   con otro formato dentro se rechaza;
 * - lee las dimensiones de las imágenes y aplica el límite de píxeles;
 * - elimina, sin recodificar la imagen, los metadatos que pueden revelar datos
 *   personales (EXIF con GPS, XMP, IPTC, comentarios, textos) y todo byte
 *   posterior al final del formato (donde suelen esconderse archivos políglotas).
 *   De EXIF solo se conserva la orientación, para que la foto no se vea girada;
 * - en los PDF rechaza el contenido activo (JavaScript, acciones de lanzamiento,
 *   archivos incrustados, formularios XFA…), también dentro de flujos comprimidos.
 *
 * SVG y GIF no se admiten (D-048): SVG puede contener scripts.
 */
import zlib from 'node:zlib';

export const MEDIA_TYPES = Object.freeze({
  'image/png': Object.freeze({ kind: 'image', extensions: Object.freeze(['png']) }),
  'image/jpeg': Object.freeze({ kind: 'image', extensions: Object.freeze(['jpg', 'jpeg']) }),
  'image/webp': Object.freeze({ kind: 'image', extensions: Object.freeze(['webp']) }),
  'application/pdf': Object.freeze({ kind: 'document', extensions: Object.freeze(['pdf']) }),
});

export const IMAGE_LIMITS = Object.freeze({ maxPixels: 50_000_000, maxSide: 20_000 });
/** Límites del análisis de PDF: flujos revisados y bytes descomprimidos en total. */
export const PDF_LIMITS = Object.freeze({ maxStreams: 10_000, maxInflatedBytes: 128 * 1024 * 1024 });

export class MediaError extends Error {
  /** @param {'content_mismatch'|'file_corrupt'|'image_too_large'|'pdf_active_content'|'pdf_too_complex'} code */
  constructor(code) {
    super(code);
    this.name = 'MediaError';
    this.code = code;
  }
}

const corrupt = () => new MediaError('file_corrupt');

/** Tipo según la firma, entre los admitidos; null si no es ninguno. */
export function sniffType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 8 && /^%PDF-[12]\.\d/.test(buf.toString('latin1', 0, 8))) return 'application/pdf';
  return null;
}

function checkDimensions(width, height) {
  if (!(width > 0 && height > 0)) throw corrupt();
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide || width * height > IMAGE_LIMITS.maxPixels) {
    throw new MediaError('image_too_large');
  }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
/** Bloques auxiliares que afectan a cómo se ve la imagen (o a la animación APNG). El resto se descarta. */
const PNG_KEEP = new Set(['tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT']);

function inspectPng(buf) {
  const kept = [PNG_SIGNATURE];
  let off = 8;
  let width = 0;
  let height = 0;
  let seenIdat = false;
  let stripped = false;
  for (let index = 0; ; index++) {
    if (off + 12 > buf.length) throw corrupt(); // falta IEND
    const length = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + length;
    if (length > 0x7fffffff || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) throw corrupt();
    if (zlib.crc32(buf.subarray(off + 4, off + 8 + length)) !== buf.readUInt32BE(off + 8 + length)) throw corrupt();
    if (index === 0) {
      if (type !== 'IHDR' || length !== 13) throw corrupt();
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      checkDimensions(width, height);
    } else if (type === 'IHDR') {
      throw corrupt();
    }
    const critical = type.charCodeAt(0) < 0x61; // mayúscula inicial
    if (critical && !PNG_CRITICAL.has(type)) throw corrupt(); // bloque crítico desconocido: no se puede mostrar
    if (type === 'IDAT') seenIdat = true;
    if (critical || PNG_KEEP.has(type)) kept.push(buf.subarray(off, end));
    else stripped = true;
    off = end;
    if (type === 'IEND') break;
  }
  if (!seenIdat) throw corrupt();
  if (off < buf.length) stripped = true; // datos después de IEND
  return { buffer: stripped ? Buffer.concat(kept) : buf, width, height, metadataRemoved: stripped };
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Orientación (1–8) de un bloque EXIF, o null. */
export function exifOrientation(seg) {
  // seg: contenido del APP1 tras la longitud, empezando por "Exif\0\0".
  const tiff = 6;
  if (seg.length < tiff + 8) return null;
  const order = seg.toString('latin1', tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (le ? seg.readUInt16LE(o) : seg.readUInt16BE(o));
  const u32 = (o) => (le ? seg.readUInt32LE(o) : seg.readUInt32BE(o));
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > seg.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > seg.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** APP1 mínimo con solo la orientación (big endian, un único campo). */
function orientationSegment(orientation) {
  const data = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  data.write('Exif\0\0', 0, 'latin1');
  data.write('MM', 6, 'latin1');
  data.writeUInt16BE(42, 8);
  data.writeUInt32BE(8, 10); // IFD0 justo tras la cabecera TIFF
  data.writeUInt16BE(1, 14); // un campo
  data.writeUInt16BE(0x0112, 16); // Orientation
  data.writeUInt16BE(3, 18); // SHORT
  data.writeUInt32BE(1, 20);
  data.writeUInt16BE(orientation, 24);
  data.writeUInt32BE(0, 28); // sin IFD siguiente
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}

const startsWith = (seg, text) => seg.length >= text.length && seg.toString('latin1', 0, text.length) === text;

function inspectJpeg(buf) {
  const parts = [buf.subarray(0, 2)];
  let off = 2;
  let width = 0;
  let height = 0;
  let orientation = null;
  let seenSof = false;
  let seenSos = false;
  let stripped = false;
  let leadingApp0End = null;

  for (;;) {
    if (off + 2 > buf.length) throw corrupt(); // falta EOI
    if (buf[off] !== 0xff) throw corrupt();
    let m = off + 1;
    while (m < buf.length && buf[m] === 0xff) m++; // bytes de relleno
    if (m >= buf.length) throw corrupt();
    const marker = buf[m];
    if (marker === 0xd9) { // EOI
      if (!seenSos) throw corrupt();
      parts.push(Buffer.from([0xff, 0xd9]));
      off = m + 1;
      break;
    }
    if (marker === 0x00 || marker === 0xd8) throw corrupt();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // sin longitud
      parts.push(Buffer.from([0xff, marker]));
      off = m + 1;
      continue;
    }
    if (m + 3 > buf.length) throw corrupt();
    const length = buf.readUInt16BE(m + 1);
    const segEnd = m + 1 + length;
    if (length < 2 || segEnd > buf.length) throw corrupt();
    const payload = buf.subarray(m + 3, segEnd);
    const segment = Buffer.concat([Buffer.from([0xff, marker]), buf.subarray(m + 1, segEnd)]);

    if (marker === 0xe1) { // APP1: EXIF o XMP
      if (startsWith(payload, 'Exif\0\0')) orientation = exifOrientation(payload) ?? orientation;
      stripped = true;
    } else if (marker >= 0xe2 && marker <= 0xef) { // APP2–APP15
      if ((marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) || (marker === 0xee && startsWith(payload, 'Adobe'))) {
        parts.push(segment); // perfil de color y transformación de color de Adobe: afectan a la imagen
      } else {
        stripped = true; // IPTC/Photoshop (APP13), FlashPix, etc.
      }
    } else if (marker === 0xfe) { // COM
      stripped = true;
    } else {
      if (SOF_MARKERS.has(marker)) {
        if (payload.length < 6) throw corrupt();
        height = payload.readUInt16BE(1);
        width = payload.readUInt16BE(3);
        checkDimensions(width, height);
        seenSof = true;
      }
      if (marker === 0xda && !seenSof) throw corrupt();
      parts.push(segment);
      if (marker === 0xe0 && parts.length === 2) leadingApp0End = 2;
    }
    off = segEnd;

    if (marker === 0xda) { // SOS: datos comprimidos hasta el siguiente marcador
      seenSos = true;
      let i = off;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const next = buf[i + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
        if (next === 0xff) { i++; continue; }
        break;
      }
      if (i >= buf.length) throw corrupt();
      parts.push(buf.subarray(off, i));
      off = i;
    }
  }
  if (!seenSof) throw corrupt();
  if (off < buf.length) stripped = true; // datos después de EOI

  if (orientation !== null && orientation !== 1) {
    parts.splice(leadingApp0End ?? 1, 0, orientationSegment(orientation));
    if (orientation >= 5) [width, height] = [height, width]; // se muestra girada 90°
  }
  return { buffer: stripped ? Buffer.concat(parts) : buf, width, height, metadataRemoved: stripped };
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function inspectWebp(buf) {
  if (buf.length < 20) throw corrupt();
  const riffSize = buf.readUInt32LE(4);
  const riffEnd = 8 + riffSize;
  if (riffSize < 4 || riffEnd > buf.length) throw corrupt();
  const chunks = [];
  let off = 12;
  let width = 0;
  let height = 0;
  let hasImage = false;
  let stripped = riffEnd < buf.length; // datos después del RIFF
  while (off < riffEnd) {
    if (off + 8 > riffEnd) throw corrupt();
    const fourcc = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataEnd = off + 8 + size;
    const padded = dataEnd + (size % 2);
    if (dataEnd > riffEnd || padded > riffEnd) throw corrupt();
    const data = buf.subarray(off + 8, dataEnd);
    if (chunks.length === 0 && !['VP8 ', 'VP8L', 'VP8X'].includes(fourcc)) throw corrupt();

    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'VP8X') {
      if (fourcc === 'VP8 ') {
        if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw corrupt();
        if (!width) {
          width = data.readUInt16LE(6) & 0x3fff;
          height = data.readUInt16LE(8) & 0x3fff;
        }
        hasImage = true;
      } else if (fourcc === 'VP8L') {
        if (data.length < 5 || data[0] !== 0x2f) throw corrupt();
        if (!width) {
          const bits = data.readUInt32LE(1);
          width = (bits & 0x3fff) + 1;
          height = ((bits >>> 14) & 0x3fff) + 1;
        }
        hasImage = true;
      } else {
        if (chunks.length !== 0 || data.length < 10) throw corrupt();
        width = data.readUIntLE(4, 3) + 1;
        height = data.readUIntLE(7, 3) + 1;
      }
    }
    if (fourcc === 'ANMF') hasImage = true;

    if (WEBP_KEEP.has(fourcc)) chunks.push({ fourcc, data: buf.subarray(off, padded) });
    else stripped = true; // EXIF, XMP y bloques desconocidos
    off = padded;
  }
  if (!hasImage) throw corrupt();
  checkDimensions(width, height);
  if (!stripped) return { buffer: buf, width, height, metadataRemoved: false };

  const body = chunks.map(({ fourcc, data }) => {
    if (fourcc !== 'VP8X') return data;
    const copy = Buffer.from(data);
    copy[8] &= ~(VP8X_EXIF | VP8X_XMP); // ya no hay EXIF ni XMP
    return copy;
  });
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.reduce((n, b) => n + b.length, 0), 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, ...body]), width, height, metadataRemoved: true };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Nombres PDF que introducen contenido activo o externo. */
const PDF_ACTIVE_NAMES = new Set([
  'JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'SubmitForm', 'ImportData', 'Sound', 'Movie',
]);
// Un nombre: "/" seguido de caracteres normales (ni blancos ni delimitadores).
const PDF_NAME = /\/([^\s/[\]<>(){}%\u0000]+)/g;

function hasActiveName(text) {
  for (const [, raw] of text.matchAll(PDF_NAME)) {
    // Los nombres admiten escapes #xx ("/J#61vaScript" = "/JavaScript").
    const name = raw.includes('#') ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw;
    if (PDF_ACTIVE_NAMES.has(name)) return true;
  }
  return false;
}

function inspectPdf(buf) {
  if (!/^%PDF-[12]\.\d/.test(buf.toString('latin1', 0, 8))) throw corrupt();
  const tail = buf.toString('latin1', Math.max(0, buf.length - 2048));
  if (!tail.includes('%%EOF')) throw corrupt();

  const text = buf.toString('latin1');
  if (hasActiveName(text)) throw new MediaError('pdf_active_content');

  // Flujos comprimidos (objetos, flujos de objetos): se descomprimen con límite y se revisan igual.
  let streams = 0;
  let budget = PDF_LIMITS.maxInflatedBytes;
  const STREAM = /stream\r?\n/g;
  let match;
  while ((match = STREAM.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) break;
    STREAM.lastIndex = end + 9;
    if (++streams > PDF_LIMITS.maxStreams) throw new MediaError('pdf_too_complex');
    const data = buf.subarray(start, end);
    if (data.length < 2 || (data[0] & 0x0f) !== 8) continue; // no es zlib (FlateDecode)
    let inflated;
    try {
      inflated = zlib.inflateSync(data, { maxOutputLength: budget, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new MediaError('pdf_too_complex');
      continue; // flujo no descomprimible: es contenido opaco (imagen, fuente…)
    }
    budget -= inflated.length;
    if (hasActiveName(inflated.toString('latin1'))) throw new MediaError('pdf_active_content');
  }
  return { buffer: buf, width: null, height: null, metadataRemoved: false };
}

// ---------------------------------------------------------------------------

const INSPECTORS = Object.freeze({
  'image/png': inspectPng,
  'image/jpeg': inspectJpeg,
  'image/webp': inspectWebp,
  'application/pdf': inspectPdf,
});

/**
 * Comprueba que `buf` es realmente del tipo declarado y lo devuelve listo para
 * guardar (sin metadatos). Lanza MediaError si no lo es.
 * @param {Buffer} buf
 * @param {keyof typeof MEDIA_TYPES} declaredType
 * @returns {{ buffer: Buffer, width: number|null, height: number|null, metadataRemoved: boolean }}
 */
export function inspectFile(buf, declaredType) {
  const inspect = INSPECTORS[declaredType];
  if (!inspect) throw new TypeError(`Tipo no admitido: ${declaredType}`);
  if (sniffType(buf) !== declaredType) throw new MediaError('content_mismatch');
  try {
    return inspect(buf);
  } catch (err) {
    if (err instanceof MediaError) throw err;
    if (err instanceof RangeError) throw corrupt(); // lectura fuera del búfer: estructura inválida
    throw err;
  }
}
