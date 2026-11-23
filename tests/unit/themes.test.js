/**
 * Paletas de color (Bloque 12): contraste WCAG, catálogo de serie, archivo de
 * paletas de cliente (THEMES_FILE), hoja de estilo generada y colores del panel.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import {
  BUILT_IN_PALETTES, COLOR_KEYS, CONTRAST_PAIRS, DEFAULT_PALETTE, MIN_CONTRAST, ThemeError,
  contrastIssues, loadThemeCatalog, paletteCss, readThemesFile, validatePalette,
} from '../../backend/modules/themes/catalog.js';
import { contrastRatio } from '../../backend/modules/themes/contrast.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-themes-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const EXAMPLE = path.join(PROJECT_ROOT, 'deploy', 'themes.example.json');
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')).palettes[0];

let n = 0;
function writeThemes(data) {
  const file = path.join(dir, `themes-${++n}.json`);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

/** Ejecuta readThemesFile y devuelve los problemas (falla si no lanza ThemeError). */
function themeIssues(data) {
  try {
    readThemesFile(writeThemes(data));
  } catch (err) {
    assert.ok(err instanceof ThemeError, err.message);
    return err.issues.join('\n');
  }
  assert.fail('se esperaba ThemeError');
}

describe('contraste WCAG', () => {
  it('reproduce los valores de referencia', () => {
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
    assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'));
    // #767676 es el gris más claro que cumple 4.5:1 sobre blanco; #777777 ya no.
    assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5);
    assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
  });
});

describe('catálogo de serie', () => {
  it('tiene cuatro paletas genéricas con id único y la predeterminada es la primera', () => {
    assert.deepEqual(BUILT_IN_PALETTES.map((p) => p.id), ['azul', 'verde', 'granate', 'grafito']);
    assert.equal(DEFAULT_PALETTE, 'azul');
  });

  for (const p of BUILT_IN_PALETTES) {
    it(`«${p.id}» cumple WCAG AA (${MIN_CONTRAST}:1) en modo claro y oscuro`, () => {
      assert.deepEqual(contrastIssues(p), []);
      for (const mode of ['light', 'dark']) {
        assert.deepEqual(Object.keys(p[mode]), COLOR_KEYS);
        for (const [fg, bg] of CONTRAST_PAIRS) assert.ok(contrastRatio(p[mode][fg], p[mode][bg]) >= MIN_CONTRAST, `${p.id} ${mode} ${fg}/${bg}`);
      }
    });
  }

  it('sin THEMES_FILE el catálogo es el de serie; una paleta desconocida se sustituye por la predeterminada', () => {
    const c = loadThemeCatalog();
    assert.deepEqual(c.ids, ['azul', 'verde', 'granate', 'grafito']);
    assert.ok(c.list.every((p) => p.custom === false));
    assert.equal(c.get('no-existe').id, 'azul');
    assert.equal(c.css('no-existe'), c.css('azul'));
    assert.equal(c.has('verde'), true);
    assert.equal(c.has('no-existe'), false);
  });
});

describe('hoja de estilo generada', () => {
  it('declara las variables de los dos modos, la preferencia del sistema y la del visitante', () => {
    const css = paletteCss(BUILT_IN_PALETTES[0]);
    assert.match(css, /^:root\{--bg:#fbfbfa;.*color-scheme:light;\}$/m);
    assert.match(css, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-mode="light"\]\)\{--bg:#15181c;/);
    assert.match(css, /^:root\[data-mode="dark"\]\{--bg:#15181c;.*color-scheme:dark;\}$/m);
    for (const v of ['--bg', '--surface', '--text', '--muted', '--border', '--accent', '--accent-strong', '--header-bg', '--header-text']) {
      assert.equal(css.split(`${v}:`).length - 1, 3, v);
    }
  });

  it('solo contiene colores #rrggbb: nada de url(), @import, expresiones ni cierres de bloque ajenos', () => {
    for (const p of loadThemeCatalog(EXAMPLE).list) {
      const body = paletteCss(p).replace(/^\/\*.*\*\/\n/, '');
      const values = [...body.matchAll(/--[a-z-]+:([^;]+);/g)].map((m) => m[1]);
      assert.equal(values.length, COLOR_KEYS.length * 3);
      assert.ok(values.every((v) => /^#[0-9a-f]{6}$/.test(v)), p.id);
      assert.doesNotMatch(body, /url\(|@import|expression|<|\\/i);
    }
  });
});

describe('archivo de paletas de cliente (THEMES_FILE)', () => {
  it('el ejemplo versionado es válido, cumple el contraste y se añade al catálogo como exclusivo', () => {
    const c = loadThemeCatalog(EXAMPLE);
    assert.deepEqual(c.ids, ['azul', 'verde', 'granate', 'grafito', 'ejemplo-turquesa']);
    assert.equal(c.get('ejemplo-turquesa').custom, true);
    assert.match(c.css('ejemplo-turquesa'), /--accent:#0b6b74;/);
  });

  it('normaliza los colores a minúsculas', () => {
    const p = example();
    p.light.bg = '#F8FBFB';
    assert.equal(readThemesFile(writeThemes({ palettes: [p] }))[0].light.bg, '#f8fbfb');
  });

  it('rechaza archivos ilegibles, JSON inválido, otra forma o demasiado grandes', () => {
    assert.throws(() => readThemesFile(path.join(dir, 'no-existe.json')), (e) => e instanceof ThemeError && /No se pudo leer/.test(e.message));
    assert.match(themeIssues('{ no es json'), /no es JSON válido/);
    assert.match(themeIssues([example()]), /debe tener la forma/);
    assert.match(themeIssues({ palettes: [example()], otra: 1 }), /debe tener la forma/);
    assert.match(themeIssues({ palettes: [] }), /de 1 a 50 paletas/);
    assert.match(themeIssues(`{"palettes":[],"x":"${'a'.repeat(300 * 1024)}"}`), /supera 256 KiB/);
  });

  it('rechaza ids inválidos, repetidos o de una paleta de serie, y nombres con marcado', () => {
    const p = example();
    assert.match(themeIssues({ palettes: [{ ...p, id: 'Con Espacios' }] }), /"id"/);
    assert.match(themeIssues({ palettes: [{ ...p, id: 'a'.repeat(41) }] }), /"id"/);
    assert.match(themeIssues({ palettes: [{ ...p, id: 'azul' }] }), /coincide con una paleta de serie/);
    assert.match(themeIssues({ palettes: [p, { ...p }] }), /está repetido/);
    assert.match(themeIssues({ palettes: [{ ...p, name: '<b>X</b>' }] }), /"name"/);
    assert.match(themeIssues({ palettes: [{ ...p, name: '' }] }), /"name"/);
    assert.match(themeIssues({ palettes: [{ ...p, css: 'body{}' }] }), /campo desconocido "css"/);
  });

  it('rechaza colores que no son #rrggbb (también intentos de inyectar CSS) y colores de más o de menos', () => {
    for (const bad of ['red', '#fff', '#12345g', 'url(https://x)', '#000000;}body{display:none', 'expression(alert(1))', 0]) {
      const p = example();
      p.light.text = bad;
      assert.match(themeIssues({ palettes: [p] }), /light\.text: debe ser un color "#rrggbb"/, String(bad));
    }
    const extra = example();
    extra.dark.shadow = '#000000';
    assert.match(themeIssues({ palettes: [extra] }), /color desconocido "shadow"/);
    const missing = example();
    delete missing.dark.accent;
    assert.match(themeIssues({ palettes: [missing] }), /dark\.accent/);
  });

  it('rechaza una paleta sin contraste suficiente e indica el modo, el par y la razón', () => {
    const p = example();
    p.dark.muted = '#4a5558'; // gris oscuro sobre fondo oscuro
    const issues = themeIssues({ palettes: [p] });
    assert.match(issues, /contraste insuficiente en modo oscuro \(muted\/bg: [0-9.]+:1, mínimo 4\.5:1\)/);
    assert.match(issues, /muted\/surface/);
  });

  it('validatePalette también valida las de serie (una de serie mal definida impediría arrancar)', () => {
    const issues = [];
    assert.equal(validatePalette({ ...BUILT_IN_PALETTES[0], light: { ...BUILT_IN_PALETTES[0].light, text: '#eeeeee' } }, 'x', issues), null);
    assert.match(issues.join(), /contraste insuficiente en modo claro \(text\/bg/);
  });
});

describe('colores del panel (admin.css)', () => {
  const css = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'admin', 'assets', 'admin.css'), 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    const text = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,6})\b/g)].map((m) => [m[1], m[2].length === 4 ? `#${[...m[2].slice(1)].map((c) => c + c).join('')}` : m[2]]));
  };
  const light = block(':root');
  const dark = { ...light, ...block(':root[data-mode="dark"]') };
  const PAIRS = [
    ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent', 'surface'], ['accent', 'bg'],
    ['accent-text', 'accent'], ['topbar-text', 'topbar-bg'], ['danger', 'surface'], ['danger', 'error-bg'], ['ok', 'ok-bg'], ['info', 'info-bg'],
    ['badge-text', 'badge-bg'], ['badge-ok-text', 'badge-ok-bg'], ['badge-warn-text', 'badge-warn-bg'], ['badge-bad-text', 'badge-bad-bg'],
    ['badge-off-text', 'badge-off-bg'], ['text', 'input-bg'], ['muted', 'subtle'], ['quote', 'surface'], ['text', 'pressed'],
  ];

  for (const [mode, colors] of [['claro', light], ['oscuro', dark]]) {
    it(`modo ${mode}: texto, enlaces, avisos y etiquetas cumplen WCAG AA`, () => {
      for (const [fg, bg] of PAIRS) {
        assert.ok(colors[fg] && colors[bg], `faltan --${fg} o --${bg}`);
        const ratio = contrastRatio(colors[fg], colors[bg]);
        assert.ok(ratio >= MIN_CONTRAST, `--${fg} sobre --${bg}: ${ratio.toFixed(2)}:1`);
      }
    });
  }

  it('el modo oscuro es igual con la preferencia del sistema y con la elegida en el perfil', () => {
    const media = css.slice(css.indexOf(':root:not([data-mode="light"]) {'));
    const fromMedia = Object.fromEntries([...media.slice(0, media.indexOf('}')).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
    const forced = css.slice(css.indexOf(':root[data-mode="dark"] {'));
    const fromForced = Object.fromEntries([...forced.slice(0, forced.indexOf('}')).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
    assert.ok(Object.keys(fromMedia).length > 20);
    assert.deepEqual(fromMedia, fromForced);
  });

  it('fuera de las variables no quedan colores fijos', () => {
    const rules = css.split('\n').filter((l) => !/^\s*--|^\s*:root|prefers-color-scheme|^\s*(\/\*|\*)/.test(l));
    assert.deepEqual(rules.filter((l) => /#[0-9a-f]{3,6}\b|rgba?\(|:\s*(black|white)\b|\s(black|white)\s*[;}]/i.test(l)), []);
  });
});

describe('colores del sitio público (site.css)', () => {
  it('site.css no define colores: los pone la hoja de la paleta (salvo la impresión, en blanco y negro)', () => {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'public', 'assets', 'site.css'), 'utf8');
    const screen = css.slice(0, css.indexOf('@media print'));
    assert.doesNotMatch(screen, /#[0-9a-f]{3,6}\b|rgba?\(/i);
  });
});
