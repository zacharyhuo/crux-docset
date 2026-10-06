import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm, mkdir, cp, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build as plist } from 'plist';
import { runCLI } from '../src/commands.js';
import os from 'node:os';
import path from 'node:path';
const { springAdapter } = await import('../src/adapters/spring.js').catch(error => { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {}; });
const raw = JSON.parse(await readFile(new URL('../recipes/spring-framework/recipe.json', import.meta.url)));
const recipe = { ...raw, familyId: raw.id, variantId: 'spring-framework-7-0-en', versionLine: '7.0', language: 'en' };

test('Spring resolution is metadata-only and rejects recipe-controlled execution or unreviewed versions', async t => {
  assert.ok(springAdapter, 'Spring adapter exists');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spring-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await springAdapter.resolve(recipe, { directory });
  assert.equal(snapshot.source.version, '7.0.9');
  assert.equal(snapshot.source.commit, '82a6b40b9366ec181ededdad282b307ee5381a52');
  assert.deepEqual(await readdir(directory), []);
  for (const modified of [
    { ...recipe, builder: { adapter: 'spring-framework', command: 'echo unsafe' } },
    { ...recipe, source: { ...recipe.source, repository: 'https://example.org/repo' } },
    { ...recipe, versionLine: '7.1', variantId: 'spring-framework-7-1-en' },
  ]) await assert.rejects(springAdapter.resolve(modified, { directory }), /Spring recipe/);
  await assert.rejects(springAdapter.resolve(recipe, { directory, archive: '/tmp/source.zip' }), /archive/);
});

test('Spring build rejects mutated source identity before acquiring or executing anything', async t => {
  assert.ok(springAdapter, 'Spring adapter exists');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spring-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = await springAdapter.resolve(recipe, { directory });
  snapshot.source.commit = '0'.repeat(40);
  await assert.rejects(springAdapter.build(recipe, snapshot, { candidate: directory }), /snapshot identity/);
  assert.deepEqual(await readdir(directory), []);
});

test('Spring refuses scratch overlap and preserves failed acquisition evidence outside scratch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spring-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'scratch'), candidate = path.join(root, 'candidate');
  await mkdir(directory); await mkdir(candidate);
  const snapshot = await springAdapter.resolve(recipe, { directory });
  await assert.rejects(springAdapter.build(recipe, snapshot, { candidate: directory }), /separate/);
  // Acquisition requires an exclusive new directory, so this triggers a real
  // filesystem failure before any fetch/compiler invocation.
  await mkdir(path.join(directory, 'upstream'));
  await writeFile(path.join(directory, 'upstream/keep.txt'), 'untouched');
  await assert.rejects(springAdapter.build(recipe, snapshot, { candidate }), { code: 'EEXIST' });
  const failure = JSON.parse(await readFile(path.join(candidate, 'spring-failure.json')));
  assert.equal(failure.stage, 'source'); assert.equal(failure.version, '7.0.9');
  assert.match(failure.message, /EEXIST/);
  assert.equal(await readFile(path.join(directory, 'upstream/keep.txt'), 'utf8'), 'untouched');
});

test('Spring CLI fingerprints nested tool inputs, keeps no-op stable and increments same-version revision', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spring-cli-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/fixture.js'), '// isolated fixture');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await mkdir(path.join(root, 'tools/spring/metadata'), { recursive: true });
  await writeFile(path.join(root, 'tools/spring/metadata/input.txt'), 'first reviewed metadata');
  const recipeRoot = path.join(root, 'recipes/spring-framework');
  await cp(new URL('../recipes/spring-framework/', import.meta.url), recipeRoot, { recursive: true });
  await writeFile(path.join(recipeRoot, 'recipe.json'), JSON.stringify({ ...raw, validation: { requireIcons: true, minimumPages: 1, minimumSymbols: 1 } }));
  await writeFile(path.join(recipeRoot, 'variants/spring-framework-7-0-en.json'), JSON.stringify({ variantId: recipe.variantId, versionLine: '7.0', language: 'en', enabled: true }));
  // Only the expensive network/compiler boundary is substituted. Resolution,
  // tool-input hashing, icons, SQLite validation and publication state are real.
  const adapter = { ...springAdapter, async build(r, snapshot, { candidate }) {
    const bundle = path.join(candidate, 'Spring_Framework.docset');
    await mkdir(path.join(bundle, 'Contents/Resources/Documents'), { recursive: true });
    await writeFile(path.join(bundle, 'Contents/Info.plist'), plist({ CFBundleIdentifier: r.identifier, CFBundleName: r.name, isDashDocset: true, dashIndexFilePath: 'index.html' }));
    await writeFile(path.join(bundle, 'Contents/Resources/Documents/index.html'), '<h1 id="spring">Spring</h1>');
    const db = new DatabaseSync(path.join(bundle, 'Contents/Resources/docSet.dsidx'));
    try { db.exec("CREATE TABLE searchIndex(id INTEGER PRIMARY KEY,name TEXT,type TEXT,path TEXT); INSERT INTO searchIndex VALUES(1,'Spring','Guide','index.html#spring')"); } finally { db.close(); }
    return { version: snapshot.source.version };
  } };
  const run = async () => JSON.parse((await runCLI(['build', '--id', 'spring-framework'], { root, resolveAdapter: () => adapter })).output);
  const first = await run();
  assert.equal(first.status, 'built');
  const hot = await run();
  assert.equal(hot.status, 'unchanged'); assert.equal(hot.fingerprint, first.fingerprint);
  await writeFile(path.join(root, 'tools/spring/metadata/input.txt'), 'second reviewed metadata');
  const revised = await run();
  assert.equal(revised.status, 'built'); assert.notEqual(revised.fingerprint, first.fingerprint);
  const oldManifest = JSON.parse(await readFile(path.join(first.directory, 'manifest.json')));
  const newManifest = JSON.parse(await readFile(path.join(revised.directory, 'manifest.json')));
  assert.equal(oldManifest.revision, 1); assert.equal(newManifest.revision, 2);
  assert.equal(newManifest.version, '7.0.9');
  assert.equal((await run()).status, 'unchanged');
  await writeFile(path.join(recipeRoot, 'notices/new-evidence.txt'), 'updated notice evidence');
  const noticeRevision = await run();
  assert.equal(noticeRevision.status, 'built', 'notice evidence participates in the adapter fingerprint');
  assert.equal(JSON.parse(await readFile(path.join(noticeRevision.directory, 'manifest.json'))).revision, 3);
  assert.equal((await run()).status, 'unchanged');
});
