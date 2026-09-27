import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { goAdapter } from '../src/adapters/go.js';
import { getAdapter } from '../src/adapters.js';
import { listRecipes, loadRecipe } from '../src/recipes.js';
import { resolveEnabledVariants } from '../src/version-matrix.js';

const recipe = { schemaVersion: 2, id: 'go', familyId: 'go', sourceId: 'dev.crux', variantId: 'go-1-27-en', versionLine: '1.27', language: 'en', identifier: 'dev.crux.go', bundleName: 'Go', name: 'Go', homepage: 'index.html',
  builder: { adapter: 'go-pkgsite' }, source: { discoveryUrl: 'https://go.dev/dl/?mode=json&include=all', strategy: 'stable-line-official-sdk' } };
const metadata = ['1.27.1', '1.26.8'].map(v => ({ version: `go${v}`, stable: true, files: [{ version: `go${v}`, filename: `go${v}.darwin-arm64.tar.gz`, os: 'darwin', arch: 'arm64', kind: 'archive', sha256: 'a'.repeat(64), size: 1000 }] }));
function fetcher(url) { assert.equal(url, 'https://go.dev/dl/?mode=json&include=all'); return Promise.resolve(new Response(JSON.stringify(metadata))); }

test('resolve discovers only metadata and fingerprints exact source/renderer per version line', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const directory = path.resolve('/tmp/nonexistent-go-resolution-fixture');
  const a = await goAdapter.resolve(recipe, { directory, fetcher });
  const b = await goAdapter.resolve({ ...recipe, variantId: 'go-1-26-en', versionLine: '1.26' }, { directory, fetcher });
  assert.equal(a.source.version, '1.27.1'); assert.equal(b.source.version, '1.26.8');
  assert.equal(a.source.sha256, 'a'.repeat(64));
  assert.match(a.source.lock.renderer.commit, /^[a-f0-9]{40}$/);
  assert.equal(a.input.directory, directory);
  assert.notEqual(a.source.url, b.source.url);
  assert.ok(goAdapter.inputFiles.includes('tools/pkgsite/toolchain-lock.json'));
  assert.equal(goAdapter.acceptsArchive, false);
});

test('unknown recipe configuration or local archive fails before network or builder execution', async () => {
  const noNetwork = () => assert.fail('invalid inputs must not trigger network');
  for (const bad of [{ ...recipe, identifier: 'foreign.go' }, { ...recipe, builder: { adapter: 'go-pkgsite', command: 'evil' } },
    { ...recipe, source: { ...recipe.source, discoveryUrl: 'https://evil.invalid/' } }, { ...recipe, variantId: 'go-1-26-en' }]) {
    await assert.rejects(goAdapter.resolve(bad, { directory: '/tmp/unused', fetcher: noNetwork }), /Go|identity|configuration/);
  }
  await assert.rejects(goAdapter.resolve(recipe, { directory: '/tmp/unused', archive: '/tmp/archive.zip', fetcher: noNetwork }), /archive/);
});

test('build refuses changed snapshot or cross-line recipe before acquisition', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const snapshot = await goAdapter.resolve(recipe, { directory: '/tmp/nonexistent-go-resolution-fixture', fetcher });
  await assert.rejects(goAdapter.build(recipe, { ...snapshot, source: { ...snapshot.source, sha256: 'b'.repeat(64) } }, { candidate: '/tmp/unused' }), /snapshot/);
  await assert.rejects(goAdapter.build({ ...recipe, variantId: 'go-1-26-en', versionLine: '1.26' }, snapshot, { candidate: '/tmp/unused' }), /version line/);
});

test('failed acquisition preserves stage diagnostics outside disposable source scratch', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-adapter-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'source'), candidate = path.join(root, 'candidate');
  await mkdir(directory); await mkdir(candidate);
  const snapshot = await goAdapter.resolve(recipe, { directory, fetcher });
  snapshot.input.lock.schemaVersion = 999;
  await assert.rejects(goAdapter.build(recipe, snapshot, { candidate }), /lock/i);
  const diagnostic = JSON.parse(await readFile(path.join(candidate, 'go-failure.json')));
  assert.equal(diagnostic.stage, 'acquire'); assert.match(diagnostic.message, /lock/i);
});

test('reviewed Go variants are visible but cannot build or enter the automatic matrix before acceptance', async () => {
  const root = path.resolve('.');
  assert.equal(getAdapter('go-pkgsite'), goAdapter);
  const rows = (await listRecipes({ root })).filter(row => row.familyId === 'go');
  assert.deepEqual(rows.map(row => [row.variantId, row.implemented, row.enabled, row.buildable]), [
    ['go-1-26-en', true, false, false], ['go-1-27-en', true, false, false],
  ]);
  assert.deepEqual(await resolveEnabledVariants({ root, id: 'go' }), []);
  await assert.rejects(loadRecipe({ root, id: 'go' }), /disabled/);
  assert.equal((await loadRecipe({ root, id: 'python' })).recipe.variantId, 'python-3-14-en');
});
