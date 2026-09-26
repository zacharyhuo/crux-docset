import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const api = await import('../src/recipes.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
async function fixture(t) {
  assert.equal(typeof api.loadRecipe, 'function', 'recipe loading must resolve a versioned identity');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-recipes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recipes', 'example');
  await mkdir(path.join(dir, 'variants'), { recursive: true });
  const base = { schemaVersion: 2, id: 'example', sourceId: 'dev.crux', name: 'Example', identifier: 'dev.crux.example', bundleName: 'Example', homepage: 'index.html', defaultVariant: 'example-2-en', builder: { adapter: 'python-intersphinx' }, source: { discoveryUrl: 'https://example.invalid/' }, validation: { minimumPages: 1 } };
  const put = (name, value) => writeFile(path.join(dir, name), JSON.stringify(value));
  await put('recipe.json', base);
  await put('variants/example-2-en.json', { variantId: 'example-2-en', versionLine: '2', language: 'en', enabled: true });
  await put('variants/example-1-en.json', { variantId: 'example-1-en', versionLine: '1', language: 'en', enabled: false, validation: { minimumPages: 2 } });
  return { root, dir, base, put };
}

test('recipe selection isolates production variants but preserves a family installation identity', async t => {
  const { root, put } = await fixture(t);
  const current = await api.loadRecipe({ root, id: 'example' });
  assert.equal(current.recipe.familyId, 'example');
  assert.equal(current.recipe.variantId, 'example-2-en');
  assert.equal(current.work, path.join(root, '.work/example-2-en'));
  await assert.rejects(api.loadRecipe({ root, id: 'example', variantId: 'example-1-en' }), /disabled/i);
  await put('variants/example-1-en.json', { variantId: 'example-1-en', versionLine: '1', language: 'en', enabled: true, validation: { minimumPages: 2 } });
  const old = await api.loadRecipe({ root, id: 'example', variantId: 'example-1-en' });
  assert.equal(old.recipe.identifier, 'dev.crux.example');
  assert.equal(old.recipe.bundleName, 'Example');
  assert.notEqual(old.work, current.work);
  assert.equal(old.recipe.validation.minimumPages, 2);
  assert.equal(current.recipe.validation.minimumPages, 1);
});

test('recipe listing includes disabled variants without enabling them', async t => {
  const { root } = await fixture(t);
  assert.equal(typeof api.listRecipes, 'function');
  const rows = await api.listRecipes({ root });
  assert.deepEqual(rows.map(r => [r.familyId, r.variantId, r.enabled, r.isDefault]), [
    ['example', 'example-1-en', false, false], ['example', 'example-2-en', true, true]
  ]);
});

test('listing does not advertise unimplemented adapters as buildable', async t => {
  const { root, base, put } = await fixture(t);
  assert.equal((await api.listRecipes({ root })).find(r => r.isDefault).buildable, true);
  await put('recipe.json', { ...base, builder: { adapter: 'unimplemented' } });
  const rows = await api.listRecipes({ root });
  assert.equal(rows.find(r => r.isDefault).enabled, true);
  assert.equal(rows.find(r => r.isDefault).implemented, false);
  assert.equal(rows.find(r => r.isDefault).buildable, false);
});

test('selection rejects path escape, ambiguous selectors and variant identity overrides', async t => {
  const { root, dir, put } = await fixture(t);
  for (const id of ['../example', '/tmp', 'EXAMPLE', 'a/b']) await assert.rejects(api.loadRecipe({ root, id }), /id/i);
  await assert.rejects(api.loadRecipe({ root, id: 'example', recipePath: path.join(dir, 'recipe.json') }), /together|exclusive/i);
  await assert.rejects(api.loadRecipe({ root, id: 'example', variantId: '../x' }), /variant/i);
  await put('variants/example-2-en.json', { variantId: 'other-2-en', versionLine: '2', language: 'en', enabled: true });
  await assert.rejects(api.loadRecipe({ root, id: 'example' }), /variant/i);
  await put('variants/example-2-en.json', { variantId: 'example-2-en', versionLine: '2', language: 'en', enabled: true, identifier: 'dev.crux.other' });
  await assert.rejects(api.loadRecipe({ root, id: 'example' }), /override|unknown/i);
});

test('recipe input validation rejects unknown schema, unsafe bundle name and symlink variants', async t => {
  const { root, dir, base, put } = await fixture(t);
  await put('recipe.json', { ...base, schemaVersion: 99 });
  await assert.rejects(api.loadRecipe({ root, id: 'example' }), /schema/i);
  await put('recipe.json', { ...base, bundleName: '../Example' });
  await assert.rejects(api.loadRecipe({ root, id: 'example' }), /bundle/i);
  await put('recipe.json', { ...base, defaultVariant: 'example-link-en' });
  await symlink(path.join(dir, 'variants/example-2-en.json'), path.join(dir, 'variants/example-link-en.json'));
  await assert.rejects(api.loadRecipe({ root, id: 'example' }), /symlink|regular/i);
});

test('Python default and explicit variant share legacy installation identity and workspace', async () => {
  assert.equal(typeof api.loadRecipe, 'function');
  const root = path.resolve('.');
  const current = await api.loadRecipe({ root });
  const explicit = await api.loadRecipe({ root, id: 'python', variantId: 'python-3-14-en' });
  assert.equal(current.recipe.identifier, 'dev.crux.python');
  assert.equal(current.recipe.variantId, 'python-3-14-en');
  assert.equal(current.recipe.versionLine, '3.14');
  assert.equal(current.recipe.source.discoveryUrl, 'https://docs.python.org/3.14/download.html');
  assert.equal(current.work, path.join(root, '.work/python'));
  assert.deepEqual(explicit, current);
});

test('nested adapter code and non-JS template changes invalidate build identity', async t => {
  assert.equal(typeof api.hashBuildInputs, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src/adapters'), { recursive: true });
  await writeFile(path.join(root, 'src/adapters/a.js'), 'export const a = 1;');
  await writeFile(path.join(root, 'src/adapters/template.html'), '<p>one</p>');
  const first = await api.hashBuildInputs(root, ['src']);
  await writeFile(path.join(root, 'src/adapters/template.html'), '<p>two</p>');
  assert.notDeepEqual(await api.hashBuildInputs(root, ['src']), first);
  await symlink(path.join(root, 'src/adapters/a.js'), path.join(root, 'src/adapters/link.js'));
  await assert.rejects(api.hashBuildInputs(root, ['src']), /symlink|regular/i);
});
