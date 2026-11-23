/**
 * Paletas de color del sitio público (Bloque 12, D-068 y D-069).
 *
 * Una paleta son solo datos: nueve colores '#rrggbb' para el modo claro y otros
 * nueve para el oscuro. Nunca CSS libre: la hoja de estilo la genera el servidor
 * a partir de colores ya validados, así que una paleta no puede inyectar código.
 *
 * El catálogo es el de serie más, opcionalmente, las paletas exclusivas de una
 * instalación (THEMES_FILE, un archivo JSON fuera del repositorio). Toda paleta,
 * también las de serie, debe cumplir el contraste mínimo WCAG AA en los dos
 * modos; si una no lo cumple, el servidor no arranca.
 */
import fs from 'node:fs';
import { contrastRatio } from './contrast.js';

/** Colores de una paleta, en el orden en que se escriben en la hoja de estilo. */
export const COLOR_KEYS = Object.freeze(['bg', 'surface', 'text', 'muted', 'border', 'accent', 'accentStrong', 'headerBg', 'headerText']);

/** Variable CSS de cada color (las que usa frontend/public/assets/site.css). */
const CSS_VARS = Object.freeze({
  bg: '--bg', surface: '--surface', text: '--text', muted: '--muted', border: '--border',
  accent: '--accent', accentStrong: '--accent-strong', headerBg: '--header-bg', headerText: '--header-text',
});

/**
 * Pares que deben contrastar al menos 4.5:1 (WCAG AA, texto normal): el texto y
 * los enlaces sobre el fondo y sobre las tarjetas, y la cabecera. El borde es
 * decorativo; el foco usa el color de los enlaces, que ya supera 3:1.
 */
export const CONTRAST_PAIRS = Object.freeze([
  ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
  ['accent', 'bg'], ['accent', 'surface'], ['accentStrong', 'bg'], ['accentStrong', 'surface'],
  ['headerText', 'headerBg'],
]);
export const MIN_CONTRAST = 4.5;

export const MODES = Object.freeze(['light', 'dark']);
export const DEFAULT_PALETTE = 'azul';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{6}$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CUSTOM = 50;

const palette = (id, name, light, dark) => ({ id, name, light, dark });

/** Catálogo de serie: tonos genéricos, sin colores de ninguna institución. */
export const BUILT_IN_PALETTES = Object.freeze([
  palette('azul', 'Azul',
    { bg: '#fbfbfa', surface: '#ffffff', text: '#1c2128', muted: '#59606b', border: '#dfe2e6', accent: '#1d5fb4', accentStrong: '#134a8f', headerBg: '#14314f', headerText: '#f3f6fa' },
    { bg: '#15181c', surface: '#1d2126', text: '#e6e9ed', muted: '#a3aab4', border: '#343a42', accent: '#79aef2', accentStrong: '#a6c9f6', headerBg: '#0f1c2b', headerText: '#e6e9ed' }),
  palette('verde', 'Verde',
    { bg: '#fafbf9', surface: '#ffffff', text: '#1b231e', muted: '#56615a', border: '#dce3de', accent: '#1e6b3c', accentStrong: '#14522d', headerBg: '#173d27', headerText: '#f2f7f3' },
    { bg: '#141a16', surface: '#1b231e', text: '#e5ebe7', muted: '#a2aea6', border: '#323d36', accent: '#6fcf97', accentStrong: '#9fe0b9', headerBg: '#0e1f15', headerText: '#e5ebe7' }),
  palette('granate', 'Granate',
    { bg: '#fcfaf9', surface: '#ffffff', text: '#261c1d', muted: '#66585a', border: '#e6dcdd', accent: '#9b1c31', accentStrong: '#7a1426', headerBg: '#4a1520', headerText: '#faf3f4' },
    { bg: '#1a1415', surface: '#231b1c', text: '#eee5e6', muted: '#b3a5a7', border: '#3e3335', accent: '#f08a9b', accentStrong: '#f6b3be', headerBg: '#2a0e14', headerText: '#eee5e6' }),
  palette('grafito', 'Grafito',
    { bg: '#fafafa', surface: '#ffffff', text: '#1f1f1f', muted: '#5c5c5c', border: '#dedede', accent: '#3b5068', accentStrong: '#27384b', headerBg: '#262626', headerText: '#f5f5f5' },
    { bg: '#161616', surface: '#1f1f1f', text: '#e8e8e8', muted: '#a6a6a6', border: '#383838', accent: '#9fb6cf', accentStrong: '#c3d3e3', headerBg: '#0d0d0d', headerText: '#e8e8e8' }),
]);

export class ThemeError extends Error {
  /** @param {string[]} issues */
  constructor(issues) {
    super(`Paletas inválidas:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ThemeError';
    this.issues = issues;
  }
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Pares de una paleta que no alcanzan el contraste mínimo: [{ mode, pair, ratio }]. */
export function contrastIssues(p) {
  const out = [];
  for (const mode of MODES) {
    for (const [fg, bg] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(p[mode][fg], p[mode][bg]);
      if (ratio < MIN_CONTRAST) out.push({ mode, pair: `${fg}/${bg}`, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return out;
}

/**
 * Valida una paleta (forma exacta, colores y contraste). Devuelve la paleta
 * normalizada (colores en minúscula) y añade los problemas a `issues`.
 */
export function validatePalette(raw, where, issues) {
  if (!isPlainObject(raw)) {
    issues.push(`${where}: debe ser un objeto`);
    return null;
  }
  const before = issues.length;
  for (const key of Object.keys(raw)) if (!['id', 'name', 'light', 'dark'].includes(key)) issues.push(`${where}: campo desconocido "${key}"`);
  if (typeof raw.id !== 'string' || raw.id.length > 40 || !ID.test(raw.id)) issues.push(`${where}: "id" debe tener de 1 a 40 caracteres a-z, 0-9 y guiones`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || [...raw.name.trim()].length > 60 || /[\u0000-\u001f\u007f<>]/.test(raw.name)) {
    issues.push(`${where}: "name" debe ser un texto de 1 a 60 caracteres, sin < ni >`);
  }
  const out = { id: raw.id, name: typeof raw.name === 'string' ? raw.name.trim() : raw.name };
  for (const mode of MODES) {
    const colors = raw[mode];
    if (!isPlainObject(colors)) {
      issues.push(`${where}: "${mode}" debe ser un objeto con los colores ${COLOR_KEYS.join(', ')}`);
      continue;
    }
    for (const key of Object.keys(colors)) if (!COLOR_KEYS.includes(key)) issues.push(`${where}.${mode}: color desconocido "${key}"`);
    out[mode] = {};
    for (const key of COLOR_KEYS) {
      const value = typeof colors[key] === 'string' ? colors[key].toLowerCase() : colors[key];
      if (typeof value !== 'string' || !HEX.test(value)) issues.push(`${where}.${mode}.${key}: debe ser un color "#rrggbb"`);
      else out[mode][key] = value;
    }
  }
  if (issues.length > before) return null;
  for (const c of contrastIssues(out)) {
    issues.push(`${where}: contraste insuficiente en modo ${c.mode === 'light' ? 'claro' : 'oscuro'} (${c.pair}: ${c.ratio}:1, mínimo ${MIN_CONTRAST}:1)`);
  }
  return issues.length > before ? null : Object.freeze({ ...out, light: Object.freeze(out.light), dark: Object.freeze(out.dark) });
}

/** Lee y valida un archivo de paletas de cliente: { "palettes": [ … ] }. */
export function readThemesFile(file) {
  let text;
  try {
    const { size } = fs.statSync(file);
    if (size > MAX_FILE_BYTES) throw new ThemeError([`THEMES_FILE (${file}) supera ${MAX_FILE_BYTES / 1024} KiB`]);
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof ThemeError) throw err;
    throw new ThemeError([`No se pudo leer THEMES_FILE (${file}): ${err.code ?? err.message}`]);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ThemeError([`THEMES_FILE (${file}) no es JSON válido: ${err.message}`]);
  }
  const issues = [];
  if (!isPlainObject(data) || !Array.isArray(data.palettes) || Object.keys(data).some((k) => k !== 'palettes')) {
    throw new ThemeError([`THEMES_FILE (${file}) debe tener la forma { "palettes": [ … ] }`]);
  }
  if (data.palettes.length === 0 || data.palettes.length > MAX_CUSTOM) issues.push(`THEMES_FILE debe definir de 1 a ${MAX_CUSTOM} paletas`);
  const palettes = data.palettes.map((p, i) => validatePalette(p, `palettes[${i}]${typeof p?.id === 'string' ? ` (${p.id})` : ''}`, issues));
  const seen = new Set(BUILT_IN_PALETTES.map((p) => p.id));
  for (const p of palettes) {
    if (!p) continue;
    if (seen.has(p.id)) issues.push(`palettes: el id "${p.id}" está repetido o coincide con una paleta de serie`);
    seen.add(p.id);
  }
  if (issues.length) throw new ThemeError(issues);
  return palettes;
}

/** Bloque de variables CSS de un modo. Los valores ya son '#rrggbb' validados. */
const declarations = (colors, scheme) => `${COLOR_KEYS.map((k) => `${CSS_VARS[k]}:${colors[k]};`).join('')}color-scheme:${scheme};`;

/**
 * Hoja de estilo de una paleta. Sin preferencia del visitante (`data-mode` en
 * <html>) sigue el modo del sistema; con ella, el modo elegido.
 */
export function paletteCss(p) {
  const dark = declarations(p.dark, 'dark');
  return `/* Paleta «${p.id}» (generada por el servidor; ver docs/THEMES.md) */
:root{${declarations(p.light, 'light')}}
@media (prefers-color-scheme: dark){:root:not([data-mode="light"]){${dark}}}
:root[data-mode="dark"]{${dark}}
`;
}

/**
 * Catálogo de la instalación: el de serie más el de THEMES_FILE, si se indica.
 * Lanza ThemeError si alguna paleta no es válida.
 * @param {string|null} [themesFile]
 */
export function loadThemeCatalog(themesFile = null) {
  const issues = [];
  const builtIn = BUILT_IN_PALETTES.map((p, i) => validatePalette(p, `paleta de serie ${p.id ?? i}`, issues));
  if (issues.length) throw new ThemeError(issues);
  const custom = themesFile ? readThemesFile(themesFile) : [];
  const list = Object.freeze([...builtIn.map((p) => ({ ...p, custom: false })), ...custom.map((p) => ({ ...p, custom: true }))].map(Object.freeze));
  const byId = new Map(list.map((p) => [p.id, p]));
  const css = new Map(list.map((p) => [p.id, paletteCss(p)]));
  return Object.freeze({
    list,
    ids: Object.freeze(list.map((p) => p.id)),
    defaultId: DEFAULT_PALETTE,
    has: (id) => byId.has(id),
    /** La paleta indicada, o la predeterminada si no existe (p. ej. se retiró su archivo). */
    get: (id) => byId.get(id) ?? byId.get(DEFAULT_PALETTE),
    css: (id) => css.get(byId.has(id) ? id : DEFAULT_PALETTE),
  });
}
