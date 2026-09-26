import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRecipe } from '../src/recipes.js';
import { runCLI } from '../src/commands.js';

const matrix = await import('../src/version-matrix.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('manual matrix schedules only enabled implemented variants with isolated work and reviewed inputs', async t => {
  assert.equal(typeof matrix.resolveEnabledVariants, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'recipes/example');
  await mkdir(path.join(directory, 'variants'), { recursive: true });
  const base = { schemaVersion: 2, id: 'example', sourceId: 'dev.crux', name: 'Example', identifier: 'dev.crux.example', bundleName: 'Example', homepage: 'index.html', defaultVariant: 'example-2-en', builder: { adapter: 'python-intersphinx', doc2dash: '3.1.0' }, source: { discoveryUrl: 'https://example.invalid/2/' }, limits: { maxBytes: 1048576, maxFiles: 100 } };
  await writeFile(path.join(directory, 'recipe.json'), JSON.stringify(base));
  for (const [line, enabled, adapter] of [['1', false, 'python-intersphinx'], ['2', true, 'python-intersphinx'], ['3', true, 'not-implemented']]) {
    const variant = { variantId: `example-${line}-en`, versionLine: line, language: 'en', enabled, builder: { adapter } };
    await writeFile(path.join(directory, `variants/${variant.variantId}.json`), JSON.stringify(variant));
  }
  const rows = await matrix.resolveEnabledVariants({ root });
  assert.deepEqual(rows.map(row => row.variantId), ['example-2-en']);
  assert.equal(rows[0].source.discoveryUrl, 'https://example.invalid/2/');
  assert.equal(rows[0].builder.doc2dash, '3.1.0');
  assert.deepEqual(rows[0].limits, { maxBytes: 1048576, maxFiles: 100 });
  assert.equal(rows[0].work, path.join(root, '.work/example-2-en'));
  await assert.rejects(matrix.resolveEnabledVariants({ root, id: 'missing' }), /unknown|not found/i);
});

test('Python current and previous lines share one installation identity but never mutable state', async () => {
  const current = await loadRecipe({ root: path.resolve('.'), id: 'python' });
  const previous = await loadRecipe({ root: path.resolve('.'), id: 'python', variantId: 'python-3-13-en' });
  assert.equal(previous.recipe.source.discoveryUrl, 'https://docs.python.org/3.13/download.html');
  assert.equal(previous.recipe.builder.doc2dash, '3.1.0');
  assert.equal(previous.recipe.identifier, current.recipe.identifier);
  assert.equal(previous.recipe.bundleName, current.recipe.bundleName);
  assert.notEqual(previous.work, current.work);
  assert.equal(previous.recipe.versionLine, '3.13');
  assert.equal(current.recipe.versionLine, '3.14');
});

test('matrix CLI emits reviewed scheduling inputs without building or publishing', async () => {
  const result = await runCLI(['matrix', '--id', 'python'], { root: path.resolve('.') });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output).map(row => row.variantId), ['python-3-13-en', 'python-3-14-en']);
  await assert.rejects(runCLI(['matrix', '--archive', '/tmp/untrusted.zip'], { root: path.resolve('.') }), /options/i);
});
