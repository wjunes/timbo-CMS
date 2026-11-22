/**
 * Empaqueta el editor (frontend/components/editor/entry.js) con esbuild en un
 * único módulo ES servido por el propio sitio, sin CDN (D-046):
 *
 *   frontend/admin/assets/editor.bundle.js            (se versiona)
 *   frontend/admin/assets/editor.bundle.licenses.txt  (licencias de lo incluido)
 *
 * La cabecera del bundle lista los paquetes y versiones exactos que contiene;
 * una prueba comprueba que coinciden con package.json. Volver a ejecutarlo
 * con las mismas dependencias produce el mismo archivo.
 *
 * Con `--check` no escribe nada: falla si los archivos versionados no
 * coinciden con lo que se generaría (bundle desactualizado o editado a mano).
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { PROJECT_ROOT } from '../backend/config/index.js';

const ENTRY = path.join(PROJECT_ROOT, 'frontend', 'components', 'editor', 'entry.js');
const OUT_DIR = path.join(PROJECT_ROOT, 'frontend', 'admin', 'assets');
export const BUNDLE = path.join(OUT_DIR, 'editor.bundle.js');
const LICENSES = path.join(OUT_DIR, 'editor.bundle.licenses.txt');

/** Paquete de node_modules al que pertenece un archivo de entrada de esbuild. */
function packageDirOf(input) {
  const parts = input.split('/');
  const i = parts.lastIndexOf('node_modules');
  if (i === -1) return null;
  const name = parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  return path.join(PROJECT_ROOT, ...parts.slice(0, i + 1), ...name.split('/'));
}

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none', // las licencias van completas en el archivo aparte
  metafile: true,
  write: false,
  absWorkingDir: PROJECT_ROOT,
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const dir = packageDirOf(input);
  if (!dir || packages.has(dir)) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(license|licence)(\.(md|txt))?$/i.test(f));
  packages.set(dir, {
    name: pkg.name, version: pkg.version, license: pkg.license,
    // LF siempre: el repositorio normaliza a LF (.gitattributes) y --check compara byte a byte.
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').replace(/\r\n?/g, '\n').trim() : null,
  });
}
const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const missing = list.filter((p) => !p.text);

const banner = [
  '/*! Editor del panel de CMS-MULTISECCION. Generado por `npm run build:editor`: no editar a mano.',
  ` * Contiene: ${list.map((p) => `${p.name}@${p.version}`).join(', ')}.`,
  ' * Licencias: editor.bundle.licenses.txt */',
].join('\n');

const outputs = [
  [BUNDLE, `${banner}\n${result.outputFiles[0].text}`],
  [LICENSES, list.map((p) => `${p.name}@${p.version} (${p.license})\n\n${p.text ?? `Licencia ${p.license}: el paquete no incluye el texto.`}\n`)
    .join(`\n${'-'.repeat(72)}\n\n`)],
];

if (process.argv.includes('--check')) {
  const stale = outputs.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text);
  if (stale.length) {
    console.error(`Desactualizado: ${stale.map(([file]) => path.relative(PROJECT_ROOT, file)).join(', ')}. Ejecuta npm run build:editor.`);
    process.exit(1);
  }
  console.log('El bundle del editor está al día.');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, text] of outputs) fs.writeFileSync(file, text);

const kib = (fs.statSync(BUNDLE).size / 1024).toFixed(1);
console.log(`editor.bundle.js: ${kib} KiB, ${list.length} paquetes`);
if (missing.length) console.log(`Sin archivo de licencia: ${missing.map((p) => p.name).join(', ')}`);
