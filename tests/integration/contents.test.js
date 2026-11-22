/**
 * API de contenidos y versionado (Bloque 06).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { publishVersion, submitVersion } from '../helpers/db.js';
import { startApp } from '../helpers/http.js';

let app;
let api;
let admin;

beforeEach(async () => {
  app = await startApp();
  ({ admin, api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const NEWS = 2;
const BODY = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hola' }] }] };
const body = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const lastAudit = (action) =>
  app.db.prepare('SELECT actor_user_id, entity_id, section_id, details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
const auditCount = (action) => app.db.prepare('SELECT count(*) AS n FROM audit_logs WHERE action = ?').get(action).n;

async function createContent(input = { title: 'Primera noticia' }, { client = api, section = NEWS, expected = 201 } = {}) {
  const r = await client.json(`/api/sections/${section}/contents`, { method: 'POST', body: input });
  assert.equal(r.status, expected, JSON.stringify(r.body));
  return r.body;
}

async function save(contentId, versionId, input, { client = api, expected = 200 } = {}) {
  const r = await client.json(`/api/contents/${contentId}/versions/${versionId}`, { method: 'PATCH', body: input });
  assert.equal(r.status, expected, JSON.stringify(r.body));
  return r.body;
}

/** Sección personalizada (no del sistema, por tanto archivable y borrable). */
async function customSection() {
  const s = await api.json('/api/sections', { method: 'POST', body: { name: 'Antigua', type: 'news' } });
  return s.body.section.id;
}

describe('contenidos: alta y lectura', () => {
  it('crea el contenido con su versión 1 en borrador, genera el slug y lo audita', async () => {
    const { content, version } = await createContent({ title: 'Año Nuevo en la Facultad', summary: 'Resumen', body: BODY });
    assert.equal(content.slug, 'ano-nuevo-en-la-facultad');
    assert.equal(content.status, 'draft');
    assert.equal(content.sectionId, NEWS);
    assert.equal(content.title, 'Año Nuevo en la Facultad');
    assert.equal(content.versionCount, 1);
    assert.deepEqual(content.openVersion, { id: version.id, versionNumber: 1, status: 'draft', revision: 1 });
    assert.equal(content.publishedVersion, null);
    assert.equal(version.versionNumber, 1);
    assert.equal(version.basedOnVersionId, null);
    assert.equal(version.summary, 'Resumen');
    assert.deepEqual(version.body, BODY);
    assert.equal(version.bodyFormat, 'tiptap_json');
    assert.deepEqual(version.createdBy, { id: admin.id, displayName: 'Usuario admin' });

    const entry = lastAudit('content.create');
    assert.equal(entry.actor_user_id, admin.id);
    assert.equal(entry.entity_id, content.id);
    assert.equal(entry.section_id, NEWS);
    assert.deepEqual(JSON.parse(entry.details), { slug: content.slug, versionId: version.id, versionNumber: 1 });
  });

  it('sin cuerpo usa un documento vacío; sin título no se crea', async () => {
    const { version } = await createContent({ title: 'Vacío' });
    assert.deepEqual(version.body, { type: 'doc', content: [] });
    const r = await createContent({ summary: 'x' }, { expected: 400 });
    assert.equal(r.fields.title, 'required');
  });

  it('el slug generado se desambigua; uno explícito repetido es 409', async () => {
    await createContent({ title: 'Repetido' });
    const second = await createContent({ title: 'Repetido' });
    assert.equal(second.content.slug, 'repetido-2');
    const r = await createContent({ title: 'Otro', slug: 'repetido' }, { expected: 409 });
    assert.equal(r.error, 'slug_taken');
    // El mismo slug en otra sección es válido.
    await createContent({ title: 'Repetido' }, { section: 3 });
  });

  it('valida slug, campos desconocidos y cuerpo', async () => {
    assert.equal((await createContent({ title: 'X', slug: '../etc' }, { expected: 400 })).fields.slug, 'invalid_format');
    assert.equal((await createContent({ title: 'X', status: 'published' }, { expected: 400 })).fields.status, 'unknown_field');
    assert.equal((await createContent({ title: '!!!' }, { expected: 400 })).fields.slug, 'required');
    const bad = await createContent({ title: 'X', body: { type: 'doc', content: [{ type: 'script' }] } }, { expected: 400 });
    assert.equal(bad.fields.body, 'unknown_node');
    assert.equal(bad.bodyPath, '/content/0/type');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM contents').get().n, 0);
  });

  it('lista los contenidos de la sección en orden y obtiene uno', async () => {
    const a = (await createContent({ title: 'A' })).content;
    const b = (await createContent({ title: 'B' })).content;
    await createContent({ title: 'Otra sección' }, { section: 3 });
    const list = await api.json(`/api/sections/${NEWS}/contents`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.contents.map((c) => c.id), [a.id, b.id]);
    assert.deepEqual(list.body.contents.map((c) => c.sortOrder), [10, 20]);
    const one = await api.json(`/api/contents/${a.id}`);
    assert.equal(one.body.content.title, 'A');
    assert.equal((await api.json('/api/contents/999')).status, 404);
    assert.equal((await api.json('/api/sections/999/contents')).status, 404);
  });

  it('una sección archivada es de solo lectura; una inactiva sigue siendo editable', async () => {
    const id = await customSection();
    const { content, version } = await createContent({ title: 'Antes de archivar' }, { section: id });
    assert.equal((await api.json(`/api/sections/${id}/archive`, { method: 'POST' })).status, 200);
    assert.equal((await createContent({ title: 'Nueva' }, { section: id, expected: 409 })).error, 'section_archived');
    assert.equal((await save(content.id, version.id, { revision: 1, title: 'Cambio' }, { expected: 409 })).error, 'section_archived');
    assert.equal((await api.json(`/api/contents/${content.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await api.json(`/api/sections/${id}/contents`)).status, 200); // lectura permitida

    assert.equal((await api.json(`/api/sections/${NEWS}/deactivate`, { method: 'POST' })).status, 200);
    await createContent({ title: 'En sección inactiva' });
  });
});

describe('contenidos: edición de borradores', () => {
  it('guarda título, resumen y cuerpo con control de revisión, y lo audita sin el cuerpo', async () => {
    const { content, version } = await createContent({ title: 'Borrador' });
    const saved = await save(content.id, version.id, { revision: 1, title: 'Borrador editado', body: body('Nuevo texto') });
    assert.equal(saved.version.revision, 2);
    assert.equal(saved.version.title, 'Borrador editado');
    assert.deepEqual(saved.version.body, body('Nuevo texto'));
    assert.deepEqual(saved.version.updatedBy, { id: admin.id, displayName: 'Usuario admin' });

    const details = JSON.parse(lastAudit('version.update').details);
    assert.deepEqual(details, { versionId: version.id, versionNumber: 1, revision: 2, fields: ['title', 'body'] });
    assert.ok(!JSON.stringify(details).includes('Nuevo texto'));
  });

  it('una revisión desactualizada responde 409 revision_conflict sin perder lo guardado', async () => {
    const { content, version } = await createContent({ title: 'Concurrente' });
    await save(content.id, version.id, { revision: 1, title: 'Primera edición' });
    const r = await save(content.id, version.id, { revision: 1, title: 'Edición atrasada' }, { expected: 409 });
    assert.equal(r.error, 'revision_conflict');
    assert.equal(r.currentRevision, 2);
    const current = await api.json(`/api/contents/${content.id}/versions/${version.id}`);
    assert.equal(current.body.version.title, 'Primera edición');
  });

  it('guardados simultáneos con la misma revisión: solo uno gana', async () => {
    const { content, version } = await createContent({ title: 'Carrera' });
    const results = await Promise.all(
      ['A', 'B', 'C'].map((x) => api.json(`/api/contents/${content.id}/versions/${version.id}`, { method: 'PATCH', body: { revision: 1, title: x } })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  });

  it('sin cambios no incrementa la revisión; un PATCH vacío se rechaza', async () => {
    const { content, version } = await createContent({ title: 'Igual' });
    const same = await save(content.id, version.id, { revision: 1, title: 'Igual' });
    assert.equal(same.version.revision, 1);
    assert.equal(auditCount('version.update'), 0);
    assert.equal((await save(content.id, version.id, { revision: 1 }, { expected: 400 })).fields._, 'empty_update');
    assert.equal((await save(content.id, version.id, { title: 'x' }, { expected: 400 })).fields.revision, 'required');
  });

  it('una versión que no es borrador no se edita ni se descarta', async () => {
    const { content, version } = await createContent({ title: 'Enviada' });
    submitVersion(app.db, { versionId: version.id, userId: admin.id });
    assert.equal((await save(content.id, version.id, { revision: 1, title: 'X' }, { expected: 409 })).error, 'version_not_editable');
    const del = await api.json(`/api/contents/${content.id}/versions/${version.id}`, { method: 'DELETE' });
    assert.equal(del.status, 409);
    assert.equal(del.body.error, 'version_not_editable');
  });

  it('una versión de otro contenido responde 404', async () => {
    const a = await createContent({ title: 'A' });
    const b = await createContent({ title: 'B' });
    assert.equal((await api.json(`/api/contents/${a.content.id}/versions/${b.version.id}`)).status, 404);
    assert.equal((await save(a.content.id, b.version.id, { revision: 1, title: 'X' }, { expected: 404 })).error, 'not_found');
  });
});

describe('contenidos: versionado', () => {
  async function published() {
    const { content, version } = await createContent({ title: 'Publicada', body: body('v1') });
    publishVersion(app.db, { contentId: content.id, versionId: version.id, userId: admin.id }); // Bloque 07
    return { content, v1: version };
  }

  it('una nueva versión parte de la publicada y no la modifica', async () => {
    const { content, v1 } = await published();
    const r = await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: {} });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const v2 = r.body.version;
    assert.equal(v2.versionNumber, 2);
    assert.equal(v2.basedOnVersionId, v1.id);
    assert.equal(v2.status, 'draft');
    assert.deepEqual(v2.body, body('v1'));
    assert.equal(r.body.content.status, 'published');
    assert.deepEqual(r.body.content.publishedVersion, { id: v1.id, versionNumber: 1 });

    await save(content.id, v2.id, { revision: 1, title: 'Cambio en curso', body: body('v2') });
    const pub = (await api.json(`/api/contents/${content.id}/versions/${v1.id}`)).body.version;
    assert.equal(pub.title, 'Publicada');
    assert.deepEqual(pub.body, body('v1'));
    assert.equal(pub.status, 'published');
    assert.equal((await api.json(`/api/contents/${content.id}`)).body.content.title, 'Cambio en curso');
    assert.deepEqual(JSON.parse(lastAudit('version.create').details), { versionId: v2.id, versionNumber: 2, basedOnVersionId: v1.id });
  });

  it('la versión publicada no puede editarse directamente', async () => {
    const { content, v1 } = await published();
    assert.equal((await save(content.id, v1.id, { revision: 1, title: 'X' }, { expected: 409 })).error, 'version_not_editable');
  });

  it('solo hay una versión en curso a la vez', async () => {
    const { content, version } = await createContent({ title: 'Una' });
    const r = await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'open_version_exists');
    assert.equal(r.body.openVersionId, version.id);
  });

  it('se puede partir de una versión rechazada o anterior, nunca de otro contenido', async () => {
    const { content, v1 } = await published();
    const v2 = (await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: {} })).body.version;
    await save(content.id, v2.id, { revision: 1, title: 'Rechazada' });
    // Simulación del Bloque 07: revisión con cambios solicitados.
    submitVersion(app.db, { versionId: v2.id, userId: admin.id });
    app.db.prepare("UPDATE content_versions SET status = 'changes_requested' WHERE id = ?").run(v2.id);

    const v3 = (await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: { basedOnVersionId: v2.id } })).body.version;
    assert.equal(v3.versionNumber, 3);
    assert.equal(v3.basedOnVersionId, v2.id);
    assert.equal(v3.title, 'Rechazada');
    await api.json(`/api/contents/${content.id}/versions/${v3.id}`, { method: 'DELETE' });

    const other = await createContent({ title: 'Ajeno' });
    const r = await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: { basedOnVersionId: other.version.id } });
    assert.equal(r.status, 400);
    assert.equal(r.body.fields.basedOnVersionId, 'not_found');
    const fromV1 = await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: { basedOnVersionId: v1.id } });
    assert.equal(fromV1.body.version.basedOnVersionId, v1.id);
  });

  it('el historial lista todas las versiones con sus autores, sin cuerpo', async () => {
    const { content, v1 } = await published();
    const v2 = (await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: {} })).body.version;
    const h = await api.json(`/api/contents/${content.id}/versions`);
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.versions.map((v) => [v.versionNumber, v.status]), [[2, 'draft'], [1, 'published']]);
    assert.equal(h.body.versions[1].publishedBy.id, admin.id);
    assert.ok(h.body.versions.every((v) => !('body' in v)));
    assert.equal(h.body.versions[0].id, v2.id);
    assert.equal(h.body.versions[1].id, v1.id);
  });

  it('descarta un borrador (no la única versión) y lo audita', async () => {
    const { content } = await published();
    const v2 = (await api.json(`/api/contents/${content.id}/versions`, { method: 'POST', body: {} })).body.version;
    const r = await api.json(`/api/contents/${content.id}/versions/${v2.id}`, { method: 'DELETE' });
    assert.equal(r.status, 204);
    assert.equal((await api.json(`/api/contents/${content.id}/versions`)).body.versions.length, 1);
    assert.deepEqual(JSON.parse(lastAudit('version.discard').details), { versionId: v2.id, versionNumber: 2 });

    const solo = await createContent({ title: 'Solo' });
    const only = await api.json(`/api/contents/${solo.content.id}/versions/${solo.version.id}`, { method: 'DELETE' });
    assert.equal(only.status, 409);
    assert.equal(only.body.error, 'only_version');
  });
});

describe('contenidos: metadatos y eliminación', () => {
  it('cambia slug y orden, y lo audita', async () => {
    const { content } = await createContent({ title: 'Original' });
    await createContent({ title: 'Ocupado' });
    const r = await api.json(`/api/contents/${content.id}`, { method: 'PATCH', body: { slug: 'renombrado', sortOrder: 5 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.content.slug, 'renombrado');
    assert.equal(r.body.content.sortOrder, 5);
    assert.deepEqual(JSON.parse(lastAudit('content.update').details).changes.slug, { from: 'original', to: 'renombrado' });
    const taken = await api.json(`/api/contents/${content.id}`, { method: 'PATCH', body: { slug: 'ocupado' } });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'slug_taken');
    const move = await api.json(`/api/contents/${content.id}`, { method: 'PATCH', body: { sectionId: 3 } });
    assert.equal(move.status, 400);
    assert.equal(move.body.fields.sectionId, 'unknown_field');
  });

  it('el borrado es lógico: conserva las versiones, libera el slug y responde 404 después', async () => {
    const { content, version } = await createContent({ title: 'Para borrar' });
    const r = await api.json(`/api/contents/${content.id}`, { method: 'DELETE' });
    assert.equal(r.status, 204);
    const row = app.db.prepare('SELECT status, deleted_by FROM contents WHERE id = ?').get(content.id);
    assert.deepEqual({ ...row }, { status: 'deleted', deleted_by: admin.id });
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM content_versions WHERE id = ?').get(version.id).n, 1);
    assert.equal((await api.json(`/api/contents/${content.id}`)).status, 404);
    assert.equal((await save(content.id, version.id, { revision: 1, title: 'X' }, { expected: 404 })).error, 'not_found');
    assert.equal((await api.json(`/api/sections/${NEWS}/contents`)).body.contents.length, 0);
    assert.equal((await createContent({ title: 'Para borrar' })).content.slug, 'para-borrar');
    assert.deepEqual(JSON.parse(lastAudit('content.delete').details), { slug: 'para-borrar', from: 'draft', versionCount: 1 });
  });

  it('un contenido publicado o en revisión no se elimina', async () => {
    const pub = await createContent({ title: 'Publicado' });
    publishVersion(app.db, { contentId: pub.content.id, versionId: pub.version.id, userId: admin.id });
    const r = await api.json(`/api/contents/${pub.content.id}`, { method: 'DELETE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'content_published');

    const rev = await createContent({ title: 'En revisión' });
    submitVersion(app.db, { versionId: rev.version.id, userId: admin.id });
    const r2 = await api.json(`/api/contents/${rev.content.id}`, { method: 'DELETE' });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, 'content_in_review');
  });

  it('una sección con contenidos (aunque estén eliminados) no se borra', async () => {
    const id = await customSection();
    const { content } = await createContent({ title: 'Histórico' }, { section: id });
    await api.json(`/api/contents/${content.id}`, { method: 'DELETE' });
    const r = await api.json(`/api/sections/${id}`, { method: 'DELETE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'section_in_use');
  });
});

describe('contenidos: tamaño del cuerpo', () => {
  it('admite cuerpos de más de 16 KiB y rechaza los que superan el límite de la petición', async () => {
    const big = { type: 'doc', content: Array.from({ length: 50 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2000) }] })) };
    const { version } = await createContent({ title: 'Grande', body: big });
    assert.equal(version.body.content.length, 50);
    // El servidor responde 413 sin leer el cuerpo y cierra la conexión; según el momento,
    // el cliente recibe el 413 o ve la conexión cortada. En ningún caso se guarda nada.
    const before = app.db.prepare('SELECT count(*) AS n FROM contents').get().n;
    try {
      const huge = await api(`/api/sections/${NEWS}/contents`, {
        method: 'POST', body: JSON.stringify({ title: 'Enorme', body: { type: 'doc', content: [], pad: 'x'.repeat(3 * 1024 * 1024) } }),
      });
      assert.equal(huge.status, 413);
    } catch (err) {
      assert.match(String(err.cause?.code ?? err.cause?.message), /ECONNRESET|EPIPE|other side closed/);
    }
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM contents').get().n, before);
  });
});
