import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { exportGoDocs, verifyGoOfflineTree } from '../src/go/export.js';

const pages = ['linux/amd64', 'windows/amd64'].map(context => ({ packagePath: 'net/http', context,
  route: `/net/http?GOOS=${context.split('/')[0]}&GOARCH=amd64`, outputPath: `platforms/${context.replace('/', '-')}/net/http/index.html` }));
const inventory = { pages };
const sourceLock = { version: '1.27.1' };
const licenses = { go: 'Copyright Go authors. Test license text.', pkgsite: 'Copyright pkgsite authors. Test license text.' };
const html = `<a data-test-id="UnitHeader-breadcrumbCurrent" href="/net/http@go1.27.1">http</a>
  <span data-test-id="UnitHeader-version"><a aria-label="Version: go1.27.1">go1.27.1</a></span>
  <main><div class="Documentation"><h4 id="Client" data-kind="type">Client</h4><div class="Documentation-declaration"><pre>type Client struct {}</pre></div>
  <p><a href="/net/http?GOOS=windows#Client">Windows Client</a><a href="/net">Package group</a></p></div></main>`;
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function session() { return { version: '1.27.1', readPage: async route => {
  assert.ok(pages.some(p => p.route === route), 'only finite declared page routes may be requested'); return html;
} }; }

test('exports finite pages, collapsed index, platform navigation, license and validated local symbols', async t => {
  const root = await temporary(t);
  const result = await exportGoDocs(session(), inventory, { destination: path.join(root, 'new'), sourceLock, goroot: '/verified/sdk/go', licenses });
  const output = await readFile(path.join(result.documentsRoot, pages[0].outputPath), 'utf8');
  const $ = load(output);
  assert.equal($('nav details').is('[open]'), false);
  assert.equal($('nav a[aria-current="page"]').text(), 'linux/amd64');
  assert.equal($('nav a').filter((_, n) => $(n).text() === 'windows/amd64').attr('href'), '../../../windows-amd64/net/http/index.html');
  assert.equal($('script,iframe').length, 0);
  assert.match($('link[rel="stylesheet"]').attr('href'), /offline\.css$/);
  assert.equal(result.symbols.length, 2);
  assert.equal(result.symbols[1].path, 'platforms/linux-amd64/net/http/index.html#Client');
  assert.equal(await readFile(path.join(result.documentsRoot, 'licenses/GO-LICENSE.txt'), 'utf8'), licenses.go);
  assert.equal(result.evidence.pages, 2);
  assert.equal(result.evidence.closure.brokenLinks, 0);
  assert.match(await readFile(path.join(result.documentsRoot, 'NOTICES.txt'), 'utf8'), /not executed offline/);
});

test('refuses existing destination and wrong session without overwriting files', async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'sentinel'), 'preserve');
  await assert.rejects(exportGoDocs(session(), inventory, { destination: root, sourceLock, goroot: '/verified/sdk/go', licenses }), /exist/i);
  assert.equal(await readFile(path.join(root, 'sentinel'), 'utf8'), 'preserve');
  await assert.rejects(exportGoDocs({ ...session(), version: '1.26.8' }, inventory, { destination: path.join(root, 'new'), sourceLock, goroot: '/verified/sdk/go', licenses }), /version/i);
});

test('final artifact verifier detects broken targets, remote resources and injected executable content', async t => {
  const root = await temporary(t);
  const result = await exportGoDocs(session(), inventory, { destination: path.join(root, 'new'), sourceLock, goroot: '/verified/sdk/go', licenses });
  const file = path.join(result.documentsRoot, pages[0].outputPath), original = await readFile(file, 'utf8');
  for (const bad of ['<a href="missing.html#Absent">broken</a>', '<a href="#Absent">broken anchor</a>',
    '<img src="https://example.org/remote.png">', '<script>run()</script>', '<a href="../../../../../../escape">escape</a>']) {
    await writeFile(file, original.replace('</body>', `${bad}</body>`));
    await assert.rejects(verifyGoOfflineTree(result.documentsRoot), /missing|resource|script|escape|unsupported/i);
  }
  await writeFile(file, original);
  await writeFile(path.join(result.documentsRoot, 'offline.css'), '@import "https://example.org/remote.css";');
  await assert.rejects(verifyGoOfflineTree(result.documentsRoot), /CSS|resource/i);
});

test('CSS string image-set cannot bypass offline resource verification', async t => {
  const root = await temporary(t);
  const result = await exportGoDocs(session(), inventory, { destination: path.join(root, 'new'), sourceLock, goroot: '/verified/sdk/go', licenses });
  await writeFile(path.join(result.documentsRoot, 'offline.css'), 'body { background: image-set("https://example.org/a.png" 1x); }');
  await assert.rejects(verifyGoOfflineTree(result.documentsRoot), /CSS|stylesheet|resource/i);
});

test('empty trees do not count as verified documentation', async t => {
  const root = await temporary(t);
  await assert.rejects(verifyGoOfflineTree(root), /missing|empty/i);
});
