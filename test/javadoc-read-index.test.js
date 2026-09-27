import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJavadocIndex } from '../src/javadoc/read-index.js';

async function fixture(t, fragment = '%3Cinit%3E(java.lang.String[])') {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-javadoc-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = { module: [], package: [{ l: 'p' }], type: [{ p: 'p', l: 'C' }],
    member: [{ p: 'p', c: 'C', l: 'C(String[])', u: fragment, k: '3' }] };
  for (const [kind, data] of Object.entries(rows)) {
    await writeFile(path.join(root, `${kind}-search-index.js`), `${kind}SearchIndex = ${JSON.stringify(data)};updateSearchResults();`);
  }
  await mkdir(path.join(root, 'p'));
  await writeFile(path.join(root, 'p/package-summary.html'), '<html><body><main><h1>Package p</h1></main></body></html>');
  await writeFile(path.join(root, 'p/C.html'), '<html><body><main><h1>Class C</h1><section id="&lt;init&gt;(java.lang.String[])">Constructor</section></main></body></html>');
  return root;
}

test('validates all targets and decodes HTML entities and fragments exactly once', async t => {
  const root = await fixture(t);
  const before = await readFile(path.join(root, 'p/C.html'));
  const result = await readJavadocIndex(root);
  assert.deepEqual(result.evidence, { files: 4, pages: 2, symbols: 3 });
  assert.equal(result.symbols.find(row => row.type === 'Constructor').path, 'p/C.html#%3Cinit%3E(java.lang.String[])');
  assert.deepEqual(await readFile(path.join(root, 'p/C.html')), before);
  const twice = await fixture(t, '%253Cinit%253E(java.lang.String[])');
  await assert.rejects(readJavadocIndex(twice), /anchor/i);
});

test('rejects missing pages, missing anchors, head-only anchors and empty body', async t => {
  const root = await fixture(t);
  const page = path.join(root, 'p/C.html');
  for (const html of [
    '<html><body><main>Class C</main></body></html>',
    '<html><head><meta id="&lt;init&gt;(java.lang.String[])"></head><body><main>Class C</main></body></html>',
    '<html><body><main id="&lt;init&gt;(java.lang.String[])"></main></body></html>',
    '<html><head><meta http-equiv="refresh" content="0;url=https://example.invalid"></head><body><main id="&lt;init&gt;(java.lang.String[])">Redirecting</main></body></html>',
  ]) {
    await writeFile(page, html);
    await assert.rejects(readJavadocIndex(root), /anchor|body|redirect/i);
  }
  await rm(page);
  await assert.rejects(readJavadocIndex(root), /ENOENT|missing/i);
});

test('rejects linked index files, pages, parent directories and roots', async t => {
  const outside = await fixture(t);
  for (const relative of ['member-search-index.js', 'p/C.html', 'p']) {
    const root = await fixture(t);
    await rm(path.join(root, relative), { recursive: true });
    await symlink(path.join(outside, relative), path.join(root, relative));
    await assert.rejects(readJavadocIndex(root), /symlink|regular|directory/i);
  }
  const holder = await fixture(t);
  const link = path.join(holder, 'linked-root');
  await symlink(outside, link);
  await assert.rejects(readJavadocIndex(link), /symlink|directory/i);
});

test('rejects invalid UTF8, nonregular inputs and oversized files before parsing', async t => {
  for (const relative of ['member-search-index.js', 'p/C.html']) {
    const root = await fixture(t);
    const file = path.join(root, relative);
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readJavadocIndex(root), /UTF|encoding/i);
    await truncate(file, 16 * 1024 * 1024 + 1);
    await assert.rejects(readJavadocIndex(root), /limit|large/i);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readJavadocIndex(root), /regular/i);
  }
});

test('matches Unicode and encoded array fragments without running page scripts', async t => {
  const root = await fixture(t, '%CE%BB(java.lang.String%5B%5D)');
  await writeFile(path.join(root, 'p/C.html'), '<html><body><main><h1>C</h1><section id="λ(java.lang.String[])">API</section><script>throw new Error("must not run")</script></main></body></html>');
  assert.equal((await readJavadocIndex(root)).symbols.length, 3);
});

test('rejects targets duplicated outside main where a browser can land first', async t => {
  const root = await fixture(t, 'run()');
  for (const outside of ['<nav id="run()">Wrong</nav>', '<script id="run()">void 0</script>', '<a name="run()">Wrong</a>']) {
    await writeFile(path.join(root, 'p/C.html'), `<html><body>${outside}<main>Class C<section id="run()">Real method</section></main></body></html>`);
    await assert.rejects(readJavadocIndex(root), /ambiguous|duplicate/i);
  }
});

test('does not treat non-content script IDs as verified method anchors', async t => {
  const root = await fixture(t, 'run()');
  await writeFile(path.join(root, 'p/C.html'), '<html><body><main>Class C<script id="run()">void 0</script></main></body></html>');
  await assert.rejects(readJavadocIndex(root), /anchor/i);
});
