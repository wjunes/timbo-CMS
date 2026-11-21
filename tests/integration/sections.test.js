import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { insertContent, submitVersion } from '../helpers/db.js';
import { startApp } from '../helpers/http.js';

let app;
let api;
let admin;

beforeEach(async () => {
  app = await startApp();
  ({ admin, api } = await app.loginAsAdmin());
});
afterEach(() => app.stop());

const lastAudit = (action) =>
  app.db.prepare('SELECT actor_user_id, entity_id, section_id, details FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

async function create(body, expected = 201) {
  const r = await api.json('/api/sections', { method: 'POST', body });
  assert.equal(r.status, expected, JSON.stringify(r.body));
  return r.body.section ?? r.body;
}

describe('API de secciones: lectura y catálogos', () => {
  it('lista las 5 secciones del sistema en orden, con ruta y nivel', async () => {
    const r = await api.json('/api/sections');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sections.map((s) => s.path), ['institucional', 'noticias', 'articulos', 'biblioteca', 'preguntas-frecuentes']);
    const news = r.body.sections[1];
    assert.equal(news.type, 'news');
    assert.equal(news.presentation, 'list');
    assert.equal(news.workflow, 'approval');
    assert.equal(news.isSystem, true);
    assert.equal(news.depth, 1);
  });

  it('expone los catálogos de tipos y presentaciones', async () => {
    const types = await api.json('/api/section-types');
    assert.deepEqual(types.body.types.map((t) => t.code), ['institutional', 'news', 'articles', 'documents', 'faq']);
    assert.equal(types.body.types[4].defaultPresentation, 'accordion');
    const p = await api.json('/api/presentations');
    assert.deepEqual(p.body.presentations.map((x) => x.code), ['page', 'list', 'grid', 'accordion', 'document_list']);
  });

  it('GET de una sección inexistente responde 404', async () => {
    assert.equal((await api.json('/api/sections/999')).status, 404);
    assert.equal((await api.json('/api/sections/abc')).status, 404);
  });
});

describe('API de secciones: alta', () => {
  it('crea una sección personalizada con valores por defecto del tipo y la audita', async () => {
    const s = await create({ name: 'Año Académico', type: 'faq' });
    assert.equal(s.slug, 'ano-academico');
    assert.equal(s.presentation, 'accordion');
    assert.equal(s.workflow, 'approval');
    assert.equal(s.status, 'active');
    assert.equal(s.isSystem, false);
    assert.equal(s.sortOrder, 60);
    const row = lastAudit('section.create');
    assert.equal(row.actor_user_id, admin.id);
    assert.equal(row.entity_id, s.id);
    assert.deepEqual(JSON.parse(row.details), { slug: 'ano-academico', type: 'faq', parentId: null });
  });

  it('crea subsecciones con slug, presentación y flujo explícitos', async () => {
    const s = await create({ name: 'Memorias', type: 'documents', parentId: 1, slug: 'memorias', presentation: 'grid', workflow: 'direct' });
    assert.equal(s.path, 'institucional/memorias');
    assert.equal(s.depth, 2);
    assert.equal(s.presentation, 'grid');
    assert.equal(s.workflow, 'direct');
    const list = (await api.json('/api/sections')).body.sections.map((x) => x.path);
    assert.deepEqual(list.slice(0, 2), ['institucional', 'institucional/memorias']);
  });

  it('valida la entrada de forma estricta', async () => {
    const r = await create(
      { name: '', type: 'blog', slug: 'Mal Slug', presentation: 'custom_html', workflow: 'auto', parentId: 'x', isSystem: true, status: 'archived' },
      400,
    );
    assert.deepEqual(r.fields, {
      isSystem: 'unknown_field', status: 'unknown_field', name: 'too_short', type: 'invalid_value', slug: 'invalid_format',
      presentation: 'invalid_value', workflow: 'invalid_value', parentId: 'invalid_type',
    });
  });

  it('rechaza slugs reservados en la raíz, vacíos, repetidos y padres inexistentes', async () => {
    assert.deepEqual((await create({ name: 'Admin', type: 'news' }, 400)).fields, { slug: 'reserved' });
    await create({ name: 'Admin', type: 'news', parentId: 2 }); // en un subnivel está permitido
    assert.deepEqual((await create({ name: '¿¡!?', type: 'news' }, 400)).fields, { slug: 'required' });
    assert.equal((await create({ name: 'Noticias', type: 'news' }, 409)).error, 'slug_taken');
    assert.deepEqual((await create({ name: 'Hija', type: 'news', parentId: 999 }, 400)).fields, { parentId: 'not_found' });
  });

  it('limita la jerarquía a 3 niveles y no permite colgar de una sección archivada', async () => {
    const l2 = await create({ name: 'Nivel dos', type: 'news', parentId: 2 });
    const l3 = await create({ name: 'Nivel tres', type: 'news', parentId: l2.id });
    assert.equal(l3.depth, 3);
    assert.equal((await create({ name: 'Nivel cuatro', type: 'news', parentId: l3.id }, 409)).error, 'section_depth_exceeded');

    const p = await create({ name: 'Archivo', type: 'news' });
    await api.json(`/api/sections/${p.id}/archive`, { method: 'POST' });
    assert.equal((await create({ name: 'Bajo archivo', type: 'news', parentId: p.id }, 409)).error, 'parent_archived');
  });
});

describe('API de secciones: edición', () => {
  it('modifica campos, audita solo lo que cambia y no admite el tipo', async () => {
    const s = await create({ name: 'Eventos', type: 'news' });
    const r = await api.json(`/api/sections/${s.id}`, { method: 'PATCH', body: { name: 'Agenda', slug: 'agenda', workflow: 'approval', presentation: 'grid' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.section.name, 'Agenda');
    assert.equal(r.body.section.slug, 'agenda');
    assert.deepEqual(JSON.parse(lastAudit('section.update').details), {
      changes: { name: { from: 'Eventos', to: 'Agenda' }, slug: { from: 'eventos', to: 'agenda' }, presentation: { from: 'list', to: 'grid' } },
    });
    const bad = await api.json(`/api/sections/${s.id}`, { method: 'PATCH', body: { type: 'faq' } });
    assert.deepEqual(bad.body.fields, { type: 'unknown_field' });
    assert.deepEqual((await api.json(`/api/sections/${s.id}`, { method: 'PATCH', body: {} })).body.fields, { _: 'empty_update' });
  });

  it('una edición sin cambios no genera auditoría', async () => {
    const s = await create({ name: 'Eventos', type: 'news' });
    const before = app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'section.update'").get().n;
    await api.json(`/api/sections/${s.id}`, { method: 'PATCH', body: { name: 'Eventos' } });
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'section.update'").get().n, before);
  });

  it('mueve secciones y aplica ciclo, profundidad y prefijos reservados', async () => {
    const a = await create({ name: 'A', type: 'news', slug: 'seccion-a' });
    const b = await create({ name: 'B', type: 'news', slug: 'seccion-b', parentId: a.id });
    const moved = await api.json(`/api/sections/${a.id}`, { method: 'PATCH', body: { parentId: 1 } });
    assert.equal(moved.body.section.path, 'institucional/seccion-a');
    assert.equal((await api.json(`/api/sections/${b.id}`)).body.section.path, 'institucional/seccion-a/seccion-b');

    assert.equal((await api.json(`/api/sections/${a.id}`, { method: 'PATCH', body: { parentId: b.id } })).body.error, 'section_cycle');
    const c = await create({ name: 'C', type: 'news', slug: 'seccion-c', parentId: 2 });
    assert.equal((await api.json(`/api/sections/${a.id}`, { method: 'PATCH', body: { parentId: c.id } })).body.error, 'section_depth_exceeded');

    const child = await create({ name: 'API', type: 'news', parentId: 2 }); // slug 'api' bajo noticias
    const toRoot = await api.json(`/api/sections/${child.id}`, { method: 'PATCH', body: { parentId: null } });
    assert.deepEqual(toRoot.body.fields, { slug: 'reserved' });
    assert.equal((await api.json(`/api/sections/${child.id}`, { method: 'PATCH', body: { slug: 'noticias', parentId: null } })).body.error, 'slug_taken');
  });

  it('no pasa a flujo directo con versiones pendientes de revisión', async () => {
    const { versionId } = insertContent(app.db, { sectionId: 2, userId: admin.id });
    submitVersion(app.db, { versionId, userId: admin.id });
    const r = await api.json('/api/sections/2', { method: 'PATCH', body: { workflow: 'direct' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'pending_reviews_exist');
    assert.equal((await api.json('/api/sections/3', { method: 'PATCH', body: { workflow: 'direct' } })).status, 200);
  });

  it('una sección archivada es de solo lectura hasta reactivarla', async () => {
    const s = await create({ name: 'Viejo', type: 'news' });
    await api.json(`/api/sections/${s.id}/archive`, { method: 'POST' });
    assert.equal((await api.json(`/api/sections/${s.id}`, { method: 'PATCH', body: { name: 'X' } })).body.error, 'section_archived');
  });
});

describe('API de secciones: estados', () => {
  it('activa, desactiva y archiva con transiciones válidas y auditadas', async () => {
    const s = await create({ name: 'Ciclo', type: 'news' });
    const path = (a) => `/api/sections/${s.id}/${a}`;
    assert.equal((await api.json(path('deactivate'), { method: 'POST' })).body.section.status, 'inactive');
    assert.deepEqual(JSON.parse(lastAudit('section.status_change').details), { from: 'active', to: 'inactive' });
    assert.equal((await api.json(path('deactivate'), { method: 'POST' })).body.error, 'invalid_status_transition');
    assert.equal((await api.json(path('archive'), { method: 'POST' })).body.section.status, 'archived');
    assert.equal((await api.json(path('activate'), { method: 'POST' })).body.section.status, 'active');
  });

  it('las secciones del sistema se desactivan pero no se archivan', async () => {
    assert.equal((await api.json('/api/sections/5/deactivate', { method: 'POST' })).body.section.status, 'inactive');
    const r = await api.json('/api/sections/5/archive', { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'system_section_protected');
  });

  it('no archiva con subsecciones activas ni reactiva bajo un padre archivado', async () => {
    const p = await create({ name: 'Padre', type: 'news' });
    const h = await create({ name: 'Hija', type: 'news', parentId: p.id });
    assert.equal((await api.json(`/api/sections/${p.id}/archive`, { method: 'POST' })).body.error, 'section_has_active_children');
    await api.json(`/api/sections/${h.id}/archive`, { method: 'POST' });
    await api.json(`/api/sections/${p.id}/archive`, { method: 'POST' });
    assert.equal((await api.json(`/api/sections/${h.id}/activate`, { method: 'POST' })).body.error, 'parent_archived');
  });
});

describe('API de secciones: borrado', () => {
  it('borra una sección personalizada sin uso, con sus asignaciones, y lo audita', async () => {
    const s = await create({ name: 'Temporal', type: 'news' });
    const user = await app.createUser({ username: 'editor' });
    await api.json(`/api/users/${user.id}/sections/${s.id}`, { method: 'PUT' });
    await api.json(`/api/users/${user.id}/sections/${s.id}/permissions`, { method: 'PUT', body: { permissions: ['content.create'] } });

    assert.equal((await api.json(`/api/sections/${s.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api.json(`/api/sections/${s.id}`)).status, 404);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_sections WHERE section_id = ?').get(s.id).n, 0);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_section_permissions WHERE section_id = ?').get(s.id).n, 0);
    assert.deepEqual(JSON.parse(lastAudit('section.delete').details), { slug: 'temporal', name: 'Temporal', removedAssignments: [user.id] });
  });

  it('no borra secciones del sistema ni secciones en uso', async () => {
    assert.equal((await api.json('/api/sections/1', { method: 'DELETE' })).body.error, 'system_section_protected');
    const p = await create({ name: 'Con hija', type: 'news' });
    await create({ name: 'Hija', type: 'news', parentId: p.id });
    const r = await api.json(`/api/sections/${p.id}`, { method: 'DELETE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'section_in_use');
    assert.deepEqual(r.body.usage, { children: 1, contents: 0, media: 0 });

    const withContent = await create({ name: 'Con contenido', type: 'news' });
    insertContent(app.db, { sectionId: withContent.id, userId: admin.id });
    assert.deepEqual((await api.json(`/api/sections/${withContent.id}`, { method: 'DELETE' })).body.usage, { children: 0, contents: 1, media: 0 });
  });
});

describe('API de secciones: orden', () => {
  it('reordena un nivel completo y lo audita', async () => {
    const r = await api.json('/api/sections/order', { method: 'PUT', body: { parentId: null, ids: [5, 4, 3, 2, 1] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ids, [5, 4, 3, 2, 1]);
    assert.equal(r.body.changed, true);
    assert.deepEqual((await api.json('/api/sections')).body.sections.map((s) => s.id), [5, 4, 3, 2, 1]);
    assert.deepEqual(JSON.parse(lastAudit('section.reorder').details), { parentId: null, before: [1, 2, 3, 4, 5], after: [5, 4, 3, 2, 1] });
  });

  it('exige exactamente las secciones de ese nivel', async () => {
    const order = (body) => api.json('/api/sections/order', { method: 'PUT', body });
    assert.equal((await order({ parentId: null, ids: [1, 2, 3] })).body.error, 'order_mismatch');
    assert.equal((await order({ parentId: null, ids: [1, 2, 3, 4, 999] })).body.error, 'order_mismatch');
    assert.deepEqual((await order({ parentId: null, ids: [1, 1, 2, 3, 4] })).body.fields, { ids: 'duplicated_value' });
    assert.deepEqual((await order({ ids: [1] })).body.fields, { parentId: 'required' });
    assert.deepEqual((await order({ parentId: 999, ids: [] })).body.fields, { parentId: 'not_found' });
    const same = await order({ parentId: null, ids: [1, 2, 3, 4, 5] });
    assert.equal(same.body.changed, false);
  });
});
