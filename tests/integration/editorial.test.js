/**
 * Flujos editoriales y aprobaciones (Bloque 07).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startApp } from '../helpers/http.js';

let app;
let api; // general_admin
let admin;

beforeEach(async () => {
  app = await startApp();
  ({ admin, api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const NEWS = 2; // flujo 'approval' (valor por defecto)
const body = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const audits = (action) =>
  app.db.prepare('SELECT actor_user_id, entity_id, section_id, details FROM audit_logs WHERE action = ? ORDER BY id').all(action)
    .map((r) => ({ ...r, details: JSON.parse(r.details) }));
const versionRow = (id) => app.db.prepare('SELECT * FROM content_versions WHERE id = ?').get(id);
const contentRow = (id) => app.db.prepare('SELECT * FROM contents WHERE id = ?').get(id);

async function call(path, { method = 'POST', body: b, client = api, expected = 200 } = {}) {
  const r = await client.json(path, { method, body: b });
  assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function directSection(name = 'Avisos') {
  return (await call('/api/sections', { body: { name, type: 'news', workflow: 'direct' }, expected: 201 })).section.id;
}

async function createContent(section = NEWS, title = 'Convocatoria', text = 'v1') {
  return call(`/api/sections/${section}/contents`, { body: { title, body: body(text) }, expected: 201 });
}

const v = (contentId, versionId, action = '') => `/api/contents/${contentId}/versions/${versionId}${action ? `/${action}` : ''}`;

/** Lleva una versión en borrador de una sección 'approval' hasta publicada. */
async function approveAndPublish(contentId, versionId, revision = 1) {
  await call(v(contentId, versionId, 'submit'), { body: { revision } });
  await call(v(contentId, versionId, 'approve'), { body: {} });
  return call(v(contentId, versionId, 'publish'), { body: {} });
}

describe('editorial: flujo approval', () => {
  it('enviar → aprobar → publicar, con autoría y auditoría de cada paso', async () => {
    const { content, version } = await createContent();
    const sent = await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    assert.equal(sent.version.status, 'pending_review');
    assert.deepEqual(sent.version.submittedBy, { id: admin.id, displayName: 'Usuario admin' });
    assert.equal(sent.content.openVersion.status, 'pending_review');

    const approved = await call(v(content.id, version.id, 'approve'), { body: { comment: 'Correcto' } });
    assert.equal(approved.version.status, 'approved');
    assert.equal(approved.version.approvedBy.id, admin.id);
    assert.ok(approved.version.approvedAt);
    assert.equal(approved.content.status, 'draft');

    const published = await call(v(content.id, version.id, 'publish'), { body: {} });
    assert.equal(published.version.status, 'published');
    assert.equal(published.version.publishedBy.id, admin.id);
    assert.equal(published.content.status, 'published');
    assert.deepEqual(published.content.publishedVersion, { id: version.id, versionNumber: 1 });
    assert.equal(published.content.openVersion, null);

    const reviews = (await call(v(content.id, version.id, 'reviews'), { method: 'GET' })).reviews;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].decision, 'approved');
    assert.equal(reviews[0].comment, 'Correcto');
    assert.deepEqual(reviews[0].reviewer, { id: admin.id, displayName: 'Usuario admin' });

    assert.deepEqual(audits('version.submit')[0].details, { versionId: version.id, versionNumber: 1 });
    assert.equal(audits('version.approve')[0].details.reviewId, reviews[0].id);
    const pub = audits('version.publish')[0];
    assert.deepEqual(pub.details, { versionId: version.id, versionNumber: 1, from: 'approved', replacedVersionId: null });
    assert.equal(pub.entity_id, content.id);
    assert.equal(pub.section_id, NEWS);
  });

  it('un borrador no se publica sin aprobación, ni una versión pendiente', async () => {
    const { content, version } = await createContent();
    const r = await call(v(content.id, version.id, 'publish'), { body: { revision: 1 }, expected: 409 });
    assert.equal(r.error, 'approval_required');
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    const p = await call(v(content.id, version.id, 'publish'), { body: {}, expected: 409 });
    assert.deepEqual(p, { error: 'invalid_transition', status: 'pending_review' });
    assert.equal(contentRow(content.id).status, 'draft');
  });

  it('solicitar cambios exige comentario; la versión queda cerrada y se continúa en una nueva', async () => {
    const { content, version } = await createContent();
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    const missing = await call(v(content.id, version.id, 'request-changes'), { body: {}, expected: 400 });
    assert.equal(missing.fields.comment, 'required');
    const blank = await call(v(content.id, version.id, 'request-changes'), { body: { comment: '   ' }, expected: 400 });
    assert.equal(blank.fields.comment, 'too_short');

    const r = await call(v(content.id, version.id, 'request-changes'), { body: { comment: 'Falta la fecha' } });
    assert.equal(r.version.status, 'changes_requested');
    assert.equal(r.version.approvedBy, null);
    assert.equal(r.content.openVersion, null);
    assert.equal(audits('version.request_changes').length, 1);

    // Ya revisada: ni se aprueba ni se vuelve a revisar.
    const again = await call(v(content.id, version.id, 'approve'), { body: {}, expected: 409 });
    assert.deepEqual(again, { error: 'invalid_transition', status: 'changes_requested' });

    // Se crea la v2 a partir de la rechazada y se reenvía.
    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: { basedOnVersionId: version.id }, expected: 201 })).version;
    await call(v(content.id, v2.id), { method: 'PATCH', body: { revision: 1, body: body('v2 con fecha') } });
    await approveAndPublish(content.id, v2.id, 2);
    const reviews = (await call(v(content.id, version.id, 'reviews'), { method: 'GET' })).reviews;
    assert.equal(reviews[0].comment, 'Falta la fecha');
  });

  it('la aprobación queda ligada a la versión exacta', async () => {
    const { content, version: v1 } = await createContent();
    await approveAndPublish(content.id, v1.id);
    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 })).version;
    // v1 ya no puede volver a aprobarse ni publicarse, y v2 no hereda la aprobación de v1.
    assert.equal((await call(v(content.id, v1.id, 'approve'), { body: {}, expected: 409 })).error, 'invalid_transition');
    assert.equal((await call(v(content.id, v2.id, 'publish'), { body: { revision: 1 }, expected: 409 })).error, 'approval_required');
    assert.equal((await call(v(content.id, v2.id, 'reviews'), { method: 'GET' })).reviews.length, 0);
    // Una versión enviada es inmutable: lo que se aprueba es lo que se publica.
    await call(v(content.id, v2.id, 'submit'), { body: { revision: 1 } });
    const edit = await call(v(content.id, v2.id), { method: 'PATCH', body: { revision: 1, title: 'Cambio' }, expected: 409 });
    assert.equal(edit.error, 'version_not_editable');
  });

  it('publicar una versión nueva archiva la anterior en la misma operación', async () => {
    const { content, version: v1 } = await createContent();
    await approveAndPublish(content.id, v1.id);
    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 })).version;
    await call(v(content.id, v2.id), { method: 'PATCH', body: { revision: 1, body: body('v2') } });

    // Mientras v2 está en revisión, v1 sigue publicada.
    await call(v(content.id, v2.id, 'submit'), { body: { revision: 2 } });
    assert.equal(contentRow(content.id).published_version_id, v1.id);
    await call(v(content.id, v2.id, 'approve'), { body: {} });
    assert.equal(contentRow(content.id).published_version_id, v1.id);

    const r = await call(v(content.id, v2.id, 'publish'), { body: {} });
    assert.deepEqual(r.content.publishedVersion, { id: v2.id, versionNumber: 2 });
    assert.equal(versionRow(v1.id).status, 'archived');
    assert.equal(versionRow(v1.id).published_by, admin.id, 'conserva quién la publicó');
    assert.equal(audits('version.publish')[1].details.replacedVersionId, v1.id);
    const history = (await call(`/api/contents/${content.id}/versions`, { method: 'GET' })).versions;
    assert.deepEqual(history.map((x) => x.status), ['published', 'archived']);
  });

  it('enviar exige la revisión actual del borrador y un cuerpo válido', async () => {
    const { content, version } = await createContent();
    await call(v(content.id, version.id), { method: 'PATCH', body: { revision: 1, title: 'Otra' } });
    const stale = await call(v(content.id, version.id, 'submit'), { body: { revision: 1 }, expected: 409 });
    assert.deepEqual(stale, { error: 'revision_conflict', currentRevision: 2 });
    assert.equal((await call(v(content.id, version.id, 'submit'), { body: {}, expected: 400 })).fields.revision, 'required');

    // Un cuerpo guardado que ya no cumple la lista blanca no se envía (escrito por otra vía).
    app.db.prepare('UPDATE content_versions SET body = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'doc', content: [{ type: 'script' }] }), version.id);
    const bad = await call(v(content.id, version.id, 'submit'), { body: { revision: 2 }, expected: 409 });
    assert.equal(bad.error, 'body_invalid');
    assert.equal(bad.fields.body, 'unknown_node');
    assert.equal(bad.bodyPath, '/content/0/type');
    assert.equal(versionRow(version.id).status, 'draft');
  });

  it('en secciones direct no se envía a revisión', async () => {
    const section = await directSection();
    const { content, version } = await createContent(section);
    assert.equal((await call(v(content.id, version.id, 'submit'), { body: { revision: 1 }, expected: 409 })).error, 'review_not_required');
  });
});

describe('editorial: flujo direct', () => {
  it('publica el borrador directamente (con su revisión) y reemplaza la versión publicada', async () => {
    const section = await directSection();
    const { content, version: v1 } = await createContent(section);
    assert.equal((await call(v(content.id, v1.id, 'publish'), { body: {}, expected: 400 })).fields.revision, 'required');
    assert.equal((await call(v(content.id, v1.id, 'publish'), { body: { revision: 7 }, expected: 409 })).error, 'revision_conflict');
    const r = await call(v(content.id, v1.id, 'publish'), { body: { revision: 1 } });
    assert.equal(r.content.status, 'published');
    assert.equal(r.version.approvedBy, null);
    assert.equal(audits('version.publish')[0].details.from, 'draft');

    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 })).version;
    await call(v(content.id, v2.id, 'publish'), { body: { revision: 1 } });
    assert.equal(versionRow(v1.id).status, 'archived');
    assert.equal(contentRow(content.id).published_version_id, v2.id);
  });

  it('una versión aprobada antes de pasar la sección a direct puede publicarse', async () => {
    const section = (await call('/api/sections', { body: { name: 'Cambia', type: 'news' }, expected: 201 })).section.id;
    const { content, version } = await createContent(section);
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    await call(v(content.id, version.id, 'approve'), { body: {} });
    await call(`/api/sections/${section}`, { method: 'PATCH', body: { workflow: 'direct' } });
    assert.equal((await call(v(content.id, version.id, 'publish'), { body: {} })).content.status, 'published');
  });
});

describe('editorial: despublicar, archivar y restaurar', () => {
  it('despublicar retira la versión publicada y deja el contenido en borrador', async () => {
    const { content, version } = await createContent();
    await approveAndPublish(content.id, version.id);
    const r = await call(`/api/contents/${content.id}/unpublish`);
    assert.equal(r.content.status, 'draft');
    assert.equal(r.content.publishedVersion, null);
    assert.equal(versionRow(version.id).status, 'archived');
    assert.deepEqual(audits('content.unpublish')[0].details, { versionId: version.id, versionNumber: 1 });
    assert.equal((await call(`/api/contents/${content.id}/unpublish`, { expected: 409 })).error, 'content_not_published');
    // Puede volver a publicarse con una versión nueva basada en la retirada.
    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: { basedOnVersionId: version.id }, expected: 201 })).version;
    await approveAndPublish(content.id, v2.id);
    assert.equal(contentRow(content.id).status, 'published');
  });

  it('despublicar no requiere aprobación ni afecta a una versión en revisión', async () => {
    const { content, version } = await createContent();
    await approveAndPublish(content.id, version.id);
    const v2 = (await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 })).version;
    await call(v(content.id, v2.id, 'submit'), { body: { revision: 1 } });
    await call(`/api/contents/${content.id}/unpublish`);
    assert.equal(versionRow(v2.id).status, 'pending_review');
    await call(v(content.id, v2.id, 'approve'), { body: {} });
    await call(v(content.id, v2.id, 'publish'), { body: {} });
    assert.equal(contentRow(content.id).published_version_id, v2.id);
  });

  it('archivar un contenido publicado lo despublica; restaurarlo lo deja en borrador y editable', async () => {
    const { content, version } = await createContent();
    await approveAndPublish(content.id, version.id);
    const r = await call(`/api/contents/${content.id}/archive`);
    assert.equal(r.content.status, 'archived');
    assert.equal(r.content.publishedVersion, null);
    assert.equal(versionRow(version.id).status, 'archived');
    assert.deepEqual(audits('content.archive')[0].details, { from: 'published', unpublishedVersionId: version.id });

    // Archivado: sin versiones nuevas ni transiciones.
    assert.equal((await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 409 })).error, 'content_not_editable');
    assert.equal((await call(`/api/contents/${content.id}/archive`, { expected: 409 })).error, 'invalid_transition');
    assert.equal((await call(`/api/contents/${content.id}/unpublish`, { expected: 409 })).error, 'content_not_editable');

    const restored = await call(`/api/contents/${content.id}/restore`);
    assert.equal(restored.content.status, 'draft');
    assert.equal(audits('content.restore').length, 1);
    assert.equal((await call(`/api/contents/${content.id}/restore`, { expected: 409 })).error, 'invalid_transition');
    await call(`/api/contents/${content.id}/versions`, { body: {}, expected: 201 });
  });

  it('archivar un borrador conserva el borrador para cuando se restaure', async () => {
    const { content, version } = await createContent();
    await call(`/api/contents/${content.id}/archive`);
    const edit = await call(v(content.id, version.id), { method: 'PATCH', body: { revision: 1, title: 'X' }, expected: 409 });
    assert.equal(edit.error, 'content_not_editable');
    assert.equal((await call(v(content.id, version.id, 'submit'), { body: { revision: 1 }, expected: 409 })).error, 'content_not_editable');
    await call(`/api/contents/${content.id}/restore`);
    await call(v(content.id, version.id), { method: 'PATCH', body: { revision: 1, title: 'X' } });
  });

  it('no se archiva un contenido con una versión en revisión o aprobada', async () => {
    const { content, version } = await createContent();
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 } });
    assert.equal((await call(`/api/contents/${content.id}/archive`, { expected: 409 })).error, 'content_in_review');
    await call(v(content.id, version.id, 'approve'), { body: {} });
    assert.equal((await call(`/api/contents/${content.id}/archive`, { expected: 409 })).error, 'content_in_review');
    assert.equal(contentRow(content.id).status, 'draft');
  });

  it('un contenido eliminado no admite transiciones (404)', async () => {
    const { content, version } = await createContent();
    await call(`/api/contents/${content.id}`, { method: 'DELETE', expected: 204 });
    await call(`/api/contents/${content.id}/archive`, { expected: 404 });
    await call(`/api/contents/${content.id}/restore`, { expected: 404 });
    await call(v(content.id, version.id, 'submit'), { body: { revision: 1 }, expected: 404 });
  });
});

describe('editorial: secciones', () => {
  it('en una sección archivada no hay transiciones; en una inactiva sí', async () => {
    const section = await directSection('Temporal');
    const a = await createContent(section, 'Uno');
    const b = await createContent(section, 'Dos');
    await call(v(a.content.id, a.version.id, 'publish'), { body: { revision: 1 } });

    await call(`/api/sections/${section}/deactivate`);
    await call(v(b.content.id, b.version.id, 'publish'), { body: { revision: 1 } });
    await call(`/api/contents/${b.content.id}/unpublish`);

    await call(`/api/sections/${section}/archive`);
    for (const [path, b2] of [
      [`/api/contents/${a.content.id}/unpublish`],
      [`/api/contents/${a.content.id}/archive`],
      [`/api/contents/${b.content.id}/restore`],
    ]) {
      assert.equal((await call(path, { body: b2, expected: 409 })).error, 'section_archived');
    }
    assert.equal(contentRow(a.content.id).status, 'published');
  });
});

describe('editorial: cola de revisión', () => {
  it('lista las versiones pendientes de todas las secciones, de la más antigua a la más reciente', async () => {
    const a = await createContent(NEWS, 'Noticia');
    const b = await createContent(3, 'Artículo');
    await createContent(NEWS, 'Sin enviar');
    await call(v(a.content.id, a.version.id, 'submit'), { body: { revision: 1 } });
    await call(v(b.content.id, b.version.id, 'submit'), { body: { revision: 1 } });

    let { pending } = await call('/api/reviews/pending', { method: 'GET' });
    assert.deepEqual(pending.map((p) => p.version.id), [a.version.id, b.version.id]);
    assert.equal(pending[0].section.id, NEWS);
    assert.equal(pending[0].content.slug, 'noticia');
    assert.equal(pending[0].version.title, 'Noticia');
    assert.equal(pending[0].version.submittedBy.id, admin.id);

    await call(v(a.content.id, a.version.id, 'approve'), { body: {} });
    ({ pending } = await call('/api/reviews/pending', { method: 'GET' }));
    assert.deepEqual(pending.map((p) => p.version.id), [b.version.id]);
  });
});
