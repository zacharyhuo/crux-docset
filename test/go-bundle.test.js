import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse as parsePlist } from 'plist';
import { exportGoDocs } from '../src/go/export.js';
import { writeGoBundle } from '../src/go/bundle.js';
import { validate } from '../src/validate.js';

const recipe = { schemaVersion: 2, id: 'go', familyId: 'go', sourceId: 'dev.crux', variantId: 'go-1-27-en', versionLine: '1.27', language: 'en', identifier: 'dev.crux.go', bundleName: 'Go', name: 'Go', homepage: 'index.html',
  validation: { minimumPages: 2, minimumSymbols: 2, requiredSymbols: ['fmt.Println'] } };
async function fixture(t, version = '1.27.1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = { packagePath: 'fmt', context: 'linux/amd64', route: '/fmt', outputPath: 'platforms/linux-amd64/fmt/index.html' };
  const exported = await exportGoDocs({ version, readPage: async () => `<a data-test-id="UnitHeader-breadcrumbCurrent" href="/fmt@go${version}">fmt</a>
    <span data-test-id="UnitHeader-version"><a aria-label="Version: go${version}">go${version}</a></span><main><div class="Documentation">
    <h4 id="Println" data-kind="function">Println</h4><div class="Documentation-declaration"><pre>func Println(v ...any)</pre></div></div></main>` },
  { pages: [page] }, { destination: path.join(root, 'export'), sourceLock: { version }, goroot: '/verified/sdk/go', licenses: { go: 'Go license fixture', pkgsite: 'pkgsite license fixture' } });
  const candidate = path.join(root, 'candidate'); await mkdir(candidate);
  return { root, candidate, exported };
}

test('packages actual SQLite search targets and consistent isolated version metadata', async t => {
  const f = await fixture(t);
  const result = await writeGoBundle(recipe, f.exported, { candidate: f.candidate, version: '1.27.1' });
  assert.equal(result.version, '1.27.1');
  const bundle = path.join(f.candidate, 'Go.docset');
  const info = parsePlist(await readFile(path.join(bundle, 'Contents/Info.plist'), 'utf8'));
  assert.equal(info.CFBundleIdentifier, 'dev.crux.go');
  assert.equal(info.isJavaScriptEnabled, false);
  assert.equal(info.dashIndexFilePath, 'index.html');
  const meta = JSON.parse(await readFile(path.join(bundle, 'meta.json')));
  assert.equal(meta.version, '1.27.1'); assert.equal(meta.extra.isJavaScriptEnabled, false);
  assert.deepEqual(meta.extra.platforms, ['linux/amd64', 'windows/amd64', 'darwin/amd64', 'js/wasm']);
  const db = new DatabaseSync(path.join(bundle, 'Contents/Resources/docSet.dsidx'), { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare('SELECT name,type,path FROM searchIndex WHERE name=?').get('fmt.Println') },
      { name: 'fmt.Println', type: 'Function', path: 'platforms/linux-amd64/fmt/index.html#Println' });
  } finally { db.close(); }
  const report = await validate(bundle, recipe);
  assert.equal(report.passed, true, JSON.stringify(report));
});

test('two lines preserve one installation identity without sharing files', async t => {
  const a = await fixture(t), b = await fixture(t, '1.26.8');
  await writeGoBundle(recipe, a.exported, { candidate: a.candidate, version: '1.27.1' });
  await writeGoBundle({ ...recipe, variantId: 'go-1-26-en', versionLine: '1.26' }, b.exported, { candidate: b.candidate, version: '1.26.8' });
  const first = JSON.parse(await readFile(path.join(a.candidate, 'Go.docset/meta.json')));
  const second = JSON.parse(await readFile(path.join(b.candidate, 'Go.docset/meta.json')));
  assert.equal(first.identifier, second.identifier);
  assert.equal(first.version, '1.27.1'); assert.equal(second.version, '1.26.8');
  await assert.rejects(writeGoBundle(recipe, b.exported, { candidate: b.candidate, version: '1.26.8' }), /version line/);
});

test('rejects unsafe identity, changed export version, invalid categories and duplicate search rows', async t => {
  const f = await fixture(t);
  await assert.rejects(writeGoBundle({ ...recipe, bundleName: '../escape' }, f.exported, { candidate: f.candidate, version: '1.27.1' }), /identity/);
  await assert.rejects(writeGoBundle(recipe, f.exported, { candidate: f.candidate, version: '1.27.2' }), /version/);
  await assert.rejects(writeGoBundle(recipe, { ...f.exported, symbols: [{ name: 'bad', type: 'Script', path: 'index.html' }] }, { candidate: f.candidate, version: '1.27.1' }), /symbol/);
  await assert.rejects(writeGoBundle(recipe, { ...f.exported, symbols: [...f.exported.symbols, f.exported.symbols[0]] }, { candidate: f.candidate, version: '1.27.1' }), /duplicate/i);
});
