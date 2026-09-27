import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { load } from 'cheerio';
import { exportSpringReference, verifySpringOfflineTree } from '../src/spring/export.js';

const page = body => `<html><head><meta name="version" content="7.0.9"><meta name="component" content="framework"></head><body><aside><a href="spring-projects.html">Website only</a></aside><main><article class="doc"><h1 id="page-title">Guide</h1><p>Documentation.</p>${body}</article></main></body></html>`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-spring-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), renderedRoot = path.join(root, 'rendered'), destination = path.join(root, 'candidate');
  await mkdir(path.join(sourceRoot, 'framework-docs/modules/ROOT/pages/testing'), { recursive: true });
  await mkdir(path.join(renderedRoot, 'testing'), { recursive: true }); await mkdir(path.join(renderedRoot, '_images'));
  await writeFile(path.join(sourceRoot, 'gradle.properties'), 'version=7.0.9\n');
  await writeFile(path.join(sourceRoot, 'LICENSE.txt'), 'Test upstream license.\n');
  await writeFile(path.join(sourceRoot, 'framework-docs/modules/ROOT/pages/index.adoc'), '= Guide\nBody.');
  await writeFile(path.join(sourceRoot, 'framework-docs/modules/ROOT/pages/testing/resttestclient.adoc'), 'xref:resttestclient-workflow[Assertions]\n[[resttestclient.workflow]]\n=== Built-in Assertions\nBody.');
  await writeFile(path.join(renderedRoot, 'old.html'), '<html><head><meta http-equiv="refresh" content="0; url=testing/resttestclient.html"></head></html>');
  await writeFile(path.join(renderedRoot, 'testing/resttestclient.html'), page('<h2 id="resttestclient.workflow">Assertions</h2><p><a href="#resttestclient-workflow">Workflow</a></p>'));
  // Only this originating page has a reviewed correction; index links to a
  // valid fragment through the redirect, not to the historical broken fragment.
  await writeFile(path.join(renderedRoot, 'index.html'), page('<a href="old.html#resttestclient.workflow">Assertions</a><a href="https://example.org/guide">External</a><img src="_images/diagram.png" alt="Diagram">'));
  await writeFile(path.join(renderedRoot, '_images/diagram.png'), png);
  return { root, sourceRoot, renderedRoot, destination, version: '7.0.9', commit: 'a'.repeat(40) };
}

test('writes a standalone reference tree with collapsed navigation, corrected links, images, licenses and verified symbols', async t => {
  const input = await fixture(t), result = await exportSpringReference(input);
  const index = load(await readFile(path.join(result.documentsRoot, 'reference/index.html'), 'utf8'));
  assert.equal(index('nav details[open]').length, 0);
  assert.equal(index('nav details').length, 1);
  assert.equal(index('aside,script').length, 0);
  assert.equal(index('article a').first().attr('href'), 'testing/resttestclient.html#resttestclient.workflow');
  assert.equal(index('article a[data-crux-online]').text(), 'External [Online]');
  const rest = load(await readFile(path.join(result.documentsRoot, 'reference/testing/resttestclient.html'), 'utf8'));
  assert.equal(rest('article p a').attr('href'), 'resttestclient.html#resttestclient.workflow');
  assert.deepEqual(await readFile(path.join(result.documentsRoot, 'reference/_images/diagram.png')), png);
  assert.equal(await readFile(path.join(result.documentsRoot, 'licenses/SPRING-LICENSE.txt'), 'utf8'), 'Test upstream license.\n');
  assert.equal(result.evidence.closure.brokenLinks, 0);
  assert.equal(result.evidence.pages, 2);
  assert.equal(result.evidence.corrections.length, 1);
  assert.equal(result.symbols.length, 3);
  assert.match(result.symbols[2].path, /^reference\//);
});

test('rejects existing destination and invalid inputs without modifying an existing candidate', async t => {
  const input = await fixture(t);
  await mkdir(input.destination); await writeFile(path.join(input.destination, 'sentinel'), 'preserve');
  await assert.rejects(exportSpringReference(input), /exist/i);
  assert.equal(await readFile(path.join(input.destination, 'sentinel'), 'utf8'), 'preserve');
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'bad-version'), version: '7.0.8' }), /version/i);
});

test('source reads reject symlinks and malformed UTF-8 instead of using external or replacement text', async t => {
  const input = await fixture(t), sourceFile = path.join(input.sourceRoot, 'framework-docs/modules/ROOT/pages/index.adoc');
  await rm(sourceFile); await symlink(path.join(input.sourceRoot, 'LICENSE.txt'), sourceFile);
  await assert.rejects(exportSpringReference(input), /symlink|regular/i);
  await rm(sourceFile); await writeFile(sourceFile, Buffer.from([0xc3, 0x28]));
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'bad-utf8') }), /utf|encoded|encoding/i);
});

test('unknown missing links or images and invalid redirects cannot produce a successful export', async t => {
  const input = await fixture(t);
  for (const [i, body] of ['<a href="missing.html">Missing</a>', '<img src="_images/absent.png">', '<a href="old.html">Redirect loop</a>'].entries()) {
    await writeFile(path.join(input.renderedRoot, 'index.html'), page(body));
    if (i === 2) await writeFile(path.join(input.renderedRoot, 'old.html'), '<meta http-equiv="refresh" content="0; url=old.html">');
    await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, `bad-${i}`) }), /missing|ENOENT|redirect/i);
  }
});

test('records unreferenced diagram source assets but refuses links that would require their omission', async t => {
  const input = await fixture(t);
  await writeFile(path.join(input.renderedRoot, '_images/diagram.svg'), '<svg>Authoring source</svg>');
  const result = await exportSpringReference(input);
  assert.ok(result.evidence.omitted.some(e => e.file === '_images/diagram.svg' && e.reason === 'unreferenced-diagram-source'));
  await assert.rejects(readFile(path.join(result.documentsRoot, 'reference/_images/diagram.svg')), /ENOENT/);
  await writeFile(path.join(input.renderedRoot, 'index.html'), page('<a href="_images/diagram.svg">Original diagram</a>'));
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'required-svg') }), /missing|unsafe|unsupported/i);
});

test('final verification rereads artifacts and rejects resource, anchor, CSS and executable-content tampering', async t => {
  const input = await fixture(t), result = await exportSpringReference(input);
  const file = path.join(result.documentsRoot, 'reference/index.html'), original = await readFile(file, 'utf8');
  for (const bad of ['<a href="absent.html">Missing</a>', '<a href="#absent">Missing</a>', '<script>run()</script>',
    '<img src="https://example.org/x.png">', '<img src="_images/diagram.png" srcset="missing.png 2x">', '<p style="background:url(missing.png)">Style</p>',
    '<a href="https://example.org/guide" data-crux-online="external" src="https://example.org/image.png">Ambiguous resource</a>']) {
    await writeFile(file, original.replace('</body>', `${bad}</body>`));
    await assert.rejects(verifySpringOfflineTree(result.documentsRoot), /missing|unsupported|unsafe/i);
  }
  await writeFile(file, original); await writeFile(path.join(result.documentsRoot, 'offline.css'), '@import "https://example.org/style.css";');
  await assert.rejects(verifySpringOfflineTree(result.documentsRoot), /CSS|stylesheet/i);
});

test('truncated PNG payloads fail both candidate creation and final artifact verification', async t => {
  const input = await fixture(t), result = await exportSpringReference(input);
  const broken = png.subarray(0, 33);
  await writeFile(path.join(result.documentsRoot, 'reference/_images/diagram.png'), broken);
  await assert.rejects(verifySpringOfflineTree(result.documentsRoot), /PNG|image|resource/i);
  await writeFile(path.join(input.renderedRoot, '_images/diagram.png'), broken);
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'bad-image') }), /PNG|image|resource/i);
});

test('layout helpers require exact source proof and empty content; real content cannot disappear under that name', async t => {
  const input = await fixture(t);
  const sourceFile = path.join(input.sourceRoot, 'framework-docs/modules/ROOT/pages/page-layout.adoc');
  const renderedFile = path.join(input.renderedRoot, 'page-layout.html');
  await writeFile(sourceFile, ':tabsize: 4\n:docinfo1:\n');
  await writeFile(renderedFile, '<main><article class="doc"></article></main>');
  const result = await exportSpringReference(input);
  assert.ok(result.evidence.omitted.some(e => e.file === 'page-layout.html'));
  await writeFile(renderedFile, page('<p>Real content.</p>'));
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'nonempty-layout') }), /layout/i);
  await writeFile(renderedFile, '<main><article class="doc"></article></main>');
  await writeFile(sourceFile, ':tabsize: 4\n:docinfo1:\n= New content\n');
  await assert.rejects(exportSpringReference({ ...input, destination: path.join(input.root, 'changed-layout') }), /layout/i);
});

test('preserves upstream footer copyright, trademark notices and legal URLs as non-executing text', async t => {
  const input = await fixture(t), file = path.join(input.renderedRoot, 'index.html');
  await writeFile(file, (await readFile(file, 'utf8')).replace('</body>', '<footer><p>Copyright © 2005 - <script>document.write(new Date().getFullYear())</script> Example. All Rights Reserved.</p><p>Example is a trademark.</p><a href="https://example.org/legal">Legal terms</a></footer></body>'));
  const result = await exportSpringReference(input);
  const notices = await readFile(path.join(result.documentsRoot, 'licenses/UPSTREAM-NOTICES.txt'), 'utf8');
  assert.match(notices, /Copyright © 2005/);
  assert.match(notices, /All Rights Reserved/);
  assert.match(notices, /Example is a trademark/);
  assert.match(notices, /https:\/\/example.org\/legal/);
  assert.doesNotMatch(notices, /<script>|document.write/);
});
