/**
 * El editor del panel y la lista blanca del backend deben describir el mismo
 * documento: lo que el editor produce se acepta, y el bundle servido es el
 * generado a partir de las dependencias fijadas.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getSchema } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { PROJECT_ROOT } from '../../backend/config/index.js';
import { validateBody } from '../../backend/modules/contents/body.js';
import { editorExtensions } from '../../frontend/components/editor/entry.js';

const schema = getSchema(editorExtensions());
const n = (type, attrs = null, content = []) => schema.node(type, attrs, content);
const txt = (text, marks = []) => schema.text(text, marks.map(([m, a]) => schema.mark(m, a)));

describe('editor del panel frente a la lista blanca', () => {
  it('un documento con todos los nodos y marcas del editor (atributos por defecto) se acepta', () => {
    const doc = n('doc', null, [
      n('heading', { level: 2 }, [txt('Título', [['bold'], ['italic'], ['underline'], ['link', { href: 'https://example.org' }]])]),
      n('paragraph', { textAlign: 'center' }, [txt('a'), n('hardBreak'), txt('b', [['link', { href: '/media/3', target: '_blank' }]])]),
      n('bulletList', null, [n('listItem', null, [n('paragraph', null, [txt('x')]), n('orderedList', null, [n('listItem', null, [n('paragraph')])])])]),
      n('blockquote', null, [n('paragraph', null, [txt('cita')]), n('image', { mediaId: 3, alt: 'a' })]),
      n('table', null, [
        n('tableRow', null, [n('tableHeader', null, [n('paragraph')])]),
        n('tableRow', null, [n('tableCell', null, [n('paragraph', null, [txt('c')]), n('image', { mediaId: 4 })])]),
      ]),
      n('image', { mediaId: 5 }),
    ]);
    doc.check();
    const used = new Set();
    doc.descendants((node) => used.add(node.type.name));
    used.add('doc');
    assert.deepEqual([...used].sort(), Object.keys(schema.nodes).sort(), 'el documento usa todos los nodos del editor');
    const result = validateBody(doc.toJSON());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.media.map((m) => m.mediaId), [3, 3, 4, 5]);
  });

  it('el editor no admite anidamientos que la lista blanca rechazaría', () => {
    const frag = (...nodes) => Fragment.fromArray(nodes);
    const table = n('table', null, [n('tableRow', null, [n('tableCell', null, [n('paragraph')])])]);
    const quote = n('blockquote', null, [n('paragraph')]);
    const image = n('image', { mediaId: 1 });
    const { blockquote, tableCell, listItem } = schema.nodes;
    assert.equal(blockquote.validContent(frag(n('paragraph'), image)), true);
    assert.equal(blockquote.validContent(frag(n('paragraph'), table)), false);
    assert.equal(blockquote.validContent(frag(n('paragraph'), quote)), false);
    assert.equal(tableCell.validContent(frag(n('paragraph'), table)), false);
    assert.equal(listItem.validContent(frag(n('paragraph'), image)), false);
    assert.deepEqual(Object.keys(schema.marks).sort(), ['bold', 'italic', 'link', 'underline']);
  });
});

describe('bundle del editor', () => {
  const bundle = path.join(PROJECT_ROOT, 'frontend', 'admin', 'assets', 'editor.bundle.js');

  it('declara exactamente las versiones instaladas y las directas están fijadas en package.json', () => {
    const banner = fs.readFileSync(bundle, 'utf8').split('\n', 3)[1];
    const declared = banner.replace(/^ \* Contiene: /, '').replace(/\.$/, '').split(', ');
    assert.ok(declared.length > 10);
    for (const entry of declared) {
      const at = entry.lastIndexOf('@');
      const name = entry.slice(0, at);
      const installed = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      assert.equal(installed.version, entry.slice(at + 1), name);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined, 'el servidor no tiene dependencias de ejecución');
    for (const [name, range] of Object.entries(pkg.devDependencies)) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} debe estar fijado`);
  });

  it('el bundle versionado coincide con el que se genera ahora (npm run build:editor)', () => {
    const r = spawnSync(process.execPath, ['scripts/build-editor.js', '--check'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
});
