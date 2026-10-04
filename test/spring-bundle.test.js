import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parse as parsePlist } from 'plist';
import { writeSpringBundle } from '../src/spring/bundle.js';
import { createSpringBundleReferencePolicy } from '../src/spring/bundle-reference-policy.js';
import { load } from 'cheerio';

const commit = '82a6b40b9366ec181ededdad282b307ee5381a52';
const recipe = { schemaVersion: 2, id: 'spring-framework', familyId: 'spring-framework', sourceId: 'dev.crux', variantId: 'spring-framework-7-0-en',
  versionLine: '7.0', language: 'en', identifier: 'dev.crux.spring-framework', bundleName: 'Spring_Framework', name: 'Spring Framework', homepage: 'index.html' };
async function fixture(t, version = '7.0.9') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-spring-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentsRoot = path.join(root, 'export'), candidate = path.join(root, 'candidate');
  await mkdir(candidate); await mkdir(documentsRoot);
  const symbols = [
    { name: 'org.spring.ApplicationContext', type: 'Interface', path: 'api/javadoc-api/index.html#ApplicationContext' },
    { name: 'org.spring.register — fun register()', type: 'Function', path: 'api/kdoc-api/index.html#12%2FMain%2F0' },
    { name: 'Transactions', type: 'Guide', path: 'reference/index.html' },
  ];
  for (const [file, html] of [['api/javadoc-api/index.html', '<main id="ApplicationContext">Java API</main>'],
    ['api/kdoc-api/index.html', '<main id="12%2FMain%2F0">Kotlin API</main>'], ['reference/index.html', '<main>Transactions</main>'],
    ['reference/licenses/UPSTREAM.txt', 'Fixture notice retained']]) {
    await mkdir(path.dirname(path.join(documentsRoot, file)), { recursive: true });
    await writeFile(path.join(documentsRoot, file), html);
  }
  return { root, candidate, exported: { documentsRoot, symbols, evidence: { version, commit } } };
}
test('packages Java, Kotlin and reference search rows with one identity and a local homepage', async t => {
  const f = await fixture(t), result = await writeSpringBundle(recipe, f.exported, { candidate: f.candidate, version: '7.0.9', commit });
  const info = parsePlist(await readFile(path.join(result.bundle, 'Contents/Info.plist'), 'utf8'));
  assert.equal(info.CFBundleIdentifier, 'dev.crux.spring-framework'); assert.equal(info.CFBundleVersion, '7.0.9');
  assert.equal(info.isJavaScriptEnabled, true); assert.equal(info.dashIndexFilePath, 'index.html');
  const db = new DatabaseSync(path.join(result.bundle, 'Contents/Resources/docSet.dsidx'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT name,type,path FROM searchIndex ORDER BY id').all().map(x => ({ ...x })), f.exported.symbols); }
  finally { db.close(); }
  const docs = path.join(result.bundle, 'Contents/Resources/Documents');
  const home = await readFile(path.join(docs, 'index.html'), 'utf8');
  for (const target of ['api/javadoc-api/index.html', 'api/kdoc-api/index.html', 'reference/index.html']) assert.ok(home.includes(`href="${target}"`));
  assert.equal(await readFile(path.join(docs, 'reference/licenses/UPSTREAM.txt'), 'utf8'), 'Fixture notice retained');
  assert.equal(await readFile(path.join(f.exported.documentsRoot, 'reference/index.html'), 'utf8'), '<main>Transactions</main>');
});
test('different version lines keep one installation identifier with separate candidate files', async t => {
  const a = await fixture(t), b = await fixture(t, '6.2.19');
  const first = await writeSpringBundle(recipe, a.exported, { candidate: a.candidate, version: '7.0.9', commit });
  const second = await writeSpringBundle({ ...recipe, versionLine: '6.2', variantId: 'spring-framework-6-2-en' }, b.exported, { candidate: b.candidate, version: '6.2.19', commit });
  const one = JSON.parse(await readFile(path.join(first.bundle, 'meta.json'))), two = JSON.parse(await readFile(path.join(second.bundle, 'meta.json')));
  assert.equal(one.identifier, two.identifier); assert.equal(one.familyId, two.familyId);
  assert.equal(one.version, '7.0.9'); assert.equal(two.version, '6.2.19'); assert.notEqual(first.bundle, second.bundle);
});
test('packages a snapshot of validated metadata and symbols across asynchronous file reads', async t => {
  const f = await fixture(t), inputRecipe = { ...recipe }, expected = structuredClone(f.exported.symbols);
  const pending = writeSpringBundle(inputRecipe, f.exported, { candidate: f.candidate, version: '7.0.9', commit });
  inputRecipe.name = 'Changed after validation';
  f.exported.symbols[0].name = 'Changed after validation';
  const result = await pending;
  const info = parsePlist(await readFile(path.join(result.bundle, 'Contents/Info.plist'), 'utf8'));
  assert.equal(info.CFBundleName, 'Spring Framework');
  const db = new DatabaseSync(path.join(result.bundle, 'Contents/Resources/docSet.dsidx'), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT name,type,path FROM searchIndex ORDER BY id').all().map(x => ({ ...x })), expected); }
  finally { db.close(); }
});
test('rejects source/version mixups, wrong identity and unsafe or duplicate search rows', async t => {
  const f = await fixture(t), options = { candidate: f.candidate, version: '7.0.9', commit };
  await assert.rejects(writeSpringBundle(recipe, f.exported, { ...options, commit: 'a'.repeat(40) }), /source|commit/i);
  await assert.rejects(writeSpringBundle(recipe, f.exported, { ...options, version: '6.2.19' }), /version/i);
  await assert.rejects(writeSpringBundle({ ...recipe, bundleName: '../escape' }, f.exported, options), /identity/i);
  for (const symbols of [[...f.exported.symbols, f.exported.symbols[0]], [{ name: 'bad', type: 'Class', path: 'api/javadoc-api/%2e%2e/secret.html' }]]) {
    await assert.rejects(writeSpringBundle(recipe, { ...f.exported, symbols }, options), /symbol|duplicate/i);
  }
});
test('failure leaves exported input and an existing candidate untouched', async t => {
  const f = await fixture(t), options = { candidate: f.candidate, version: '7.0.9', commit };
  const old = path.join(f.candidate, 'Spring_Framework.docset'); await mkdir(old); await writeFile(path.join(old, 'keep'), 'existing');
  await assert.rejects(writeSpringBundle(recipe, f.exported, options), /exist/i);
  assert.equal(await readFile(path.join(old, 'keep'), 'utf8'), 'existing');
  assert.equal(await readFile(path.join(f.exported.documentsRoot, 'reference/index.html'), 'utf8'), '<main>Transactions</main>');
});
test('rejects symlink resources and missing index anchors without consuming the source export', async t => {
  const f = await fixture(t), options = { candidate: f.candidate, version: '7.0.9', commit };
  await symlink('index.html', path.join(f.exported.documentsRoot, 'reference/alias.html'));
  await assert.rejects(writeSpringBundle(recipe, f.exported, options), /symlink|regular/i);
  const g = await fixture(t); g.exported.symbols[0].path = 'api/javadoc-api/index.html#absent';
  await assert.rejects(writeSpringBundle(recipe, g.exported, { ...options, candidate: g.candidate }), /anchor|validation/i);
  assert.equal(await readFile(path.join(g.exported.documentsRoot, 'reference/index.html'), 'utf8'), '<main>Transactions</main>');
});
test('rejects overlapping source and destination before creating a bundle', async t => {
  const f = await fixture(t), nested = path.join(f.exported.documentsRoot, 'candidate');
  await mkdir(nested);
  for (const candidate of [f.exported.documentsRoot, nested, f.root]) {
    await assert.rejects(writeSpringBundle(recipe, f.exported, { candidate, version: '7.0.9', commit }), /separate/i);
  }
  assert.deepEqual(await readdir(nested), []);
  assert.equal(await readFile(path.join(f.exported.documentsRoot, 'reference/index.html'), 'utf8'), '<main>Transactions</main>');
});
test('requires search coverage and a homepage for all three sections before writing a candidate', async t => {
  const f = await fixture(t), options = { candidate: f.candidate, version: '7.0.9', commit };
  await assert.rejects(writeSpringBundle(recipe, { ...f.exported, symbols: f.exported.symbols.slice(0, 2) }, options), /cover/i);
  await rm(path.join(f.exported.documentsRoot, 'reference/index.html'));
  await assert.rejects(writeSpringBundle(recipe, f.exported, options), /homepage/i);
  assert.deepEqual(await readdir(f.candidate), []);
});
test('the packaged manual uses local same-version API links with verified targets', async t => {
  const f = await fixture(t);
  const original = '<main>Transactions <a data-crux-online="true" href="https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/index.html#ApplicationContext">API</a></main>';
  await writeFile(path.join(f.exported.documentsRoot, 'reference/index.html'), original);
  const result = await writeSpringBundle(recipe, f.exported, { candidate: f.candidate, version: '7.0.9', commit });
  const saved = await readFile(path.join(result.bundle, 'Contents/Resources/Documents/reference/index.html'), 'utf8');
  assert.match(saved, /href="\.\.\/api\/javadoc-api\/index.html#ApplicationContext"/);
  assert.doesNotMatch(saved, /data-crux-online/);
  assert.equal(await readFile(path.join(f.exported.documentsRoot, 'reference/index.html'), 'utf8'), original);
});
test('ambiguous cross-link anchors fail packaging even when search rows do not reference them', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.exported.documentsRoot, 'reference/index.html'), '<main><h1 id="duplicate">One</h1><h2 id="duplicate">Two</h2></main>');
  await assert.rejects(writeSpringBundle(recipe, f.exported, { candidate: f.candidate, version: '7.0.9', commit }), /duplicate|ambiguous/i);
});
test('packages a source-proven unavailable API notice and audit without deleting original content', async t => {
  const f = await fixture(t), sources = new Map(), sourceRoot = new URL('./fixtures/spring-bundle-sources/', import.meta.url);
  for (const file of await readdir(sourceRoot, { recursive: true })) if (/\.(?:java|adoc)$/.test(file) || file === 'gradle.properties') sources.set(file, await readFile(new URL(file, sourceRoot), 'utf8'));
  const referencePolicy = createSpringBundleReferencePolicy({ version: '7.0.9', commit, sources });
  const file = 'reference/core/beans/context-introduction.html';
  const original = '<main id="body"><pre>\noriginal code</pre><a id="source" href="https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/org/springframework/jca/context/SpringContextResourceAdapter.html"><code>SpringContextResourceAdapter</code></a></main>';
  await mkdir(path.dirname(path.join(f.exported.documentsRoot, file)), { recursive: true });
  await writeFile(path.join(f.exported.documentsRoot, file), original);
  const result = await writeSpringBundle(recipe, f.exported, { candidate: f.candidate, version: '7.0.9', commit, referencePolicy });
  const $ = load(await readFile(path.join(result.bundle, 'Contents/Resources/Documents', file), 'utf8'));
  assert.equal($('#source').attr('href'), undefined); assert.equal($('#source code').text(), 'SpringContextResourceAdapter');
  assert.equal($('.Crux-missingApiNotice').length, 1); assert.equal($('a a').length, 0);
  assert.match($('.Crux-missingApiNotice').text(), /API unavailable in this version/);
  $('.Crux-missingApiNotice').remove(); assert.equal($('body').text(), load(original)('body').text());
  const audit = JSON.parse(await readFile(path.join(result.bundle, 'Contents/Resources/spring-links.json'), 'utf8'));
  assert.equal(audit.warnings[0].ruleId, 'missing-jca'); assert.equal(audit.warnings[0].from, file);
  assert.equal(audit.sourceProofs.length, 8);
  assert.equal(Object.keys(audit.verifiedSources).length, 15);
  assert.equal(audit.verifiedSources['gradle.properties'], 'c80e650987313e2cf190a87581541acac4d9346a55a354dff2ddf4e6213aa539');
  assert.equal(await readFile(path.join(f.exported.documentsRoot, file), 'utf8'), original);
  const g = await fixture(t); g.exported.evidence.commit = 'a'.repeat(40);
  await assert.rejects(writeSpringBundle(recipe, g.exported, { candidate: g.candidate, version: '7.0.9', commit: 'a'.repeat(40), referencePolicy }), /policy|identity/i);
  assert.deepEqual(await readdir(g.candidate), []);
});
