import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { prepareGoOfflinePage, adaptGoOfflinePage } from '../src/go/offline.js';
import { createGoLinkResolver } from '../src/go/links.js';

const entry = { packagePath: 'fmt', version: '1.27.1', context: 'linux/amd64', outputPath: 'platforms/linux-amd64/fmt/index.html' };
function page(extra = '') {
  return `<html><head><script src="/site.js"></script><link rel="stylesheet" href="/site.css"></head><body>
    <a data-test-id="UnitHeader-breadcrumbCurrent" href="/fmt@go1.27.1">fmt</a>
    <span data-test-id="UnitHeader-version"><a aria-label="Version: go1.27.1">go1.27.1</a></span>
    <main><div class="Documentation"><h4 data-kind="function" id="Println">Println</h4>
    <div class="Documentation-declaration"><pre>func Println(v ...any)</pre></div>${extra}</div></main></body></html>`;
}

test('preserves example code, native disclosure and supplied output without server controls', () => {
  const prepared = prepareGoOfflinePage(page(`<details id="example"><summary>Example</summary>
    <pre class="Documentation-exampleCode">fmt.Println("hello")</pre>
    <pre hidden class="Documentation-exampleOutputContainer"><span class="Documentation-exampleOutput">hello</span></pre>
    <button class="Documentation-exampleRunButton">Run</button>
    <button class="Documentation-exampleShareButton">Share</button>
    <button class="Documentation-exampleFormatButton">Format</button></details>`), entry);
  const $ = load(prepared.bodyHTML);
  assert.equal($('details#example > summary').text(), 'Example');
  assert.equal($('.Documentation-exampleCode').text(), 'fmt.Println("hello")');
  assert.equal($('.Documentation-exampleOutput').text(), 'hello');
  assert.equal($('.Documentation-exampleOutputContainer').is('[hidden]'), false);
  assert.equal($('script,link,button').length, 0);
  assert.equal(prepared.removedControls, 3);
  assert.equal(prepared.anchors.has('Println'), true);
  assert.equal(prepared.anchors.has('example'), true);
});

test('unknown body resources and dynamic components fail instead of disappearing', () => {
  for (const component of ['<img src="/diagram.png">', '<img srcset="/small.png 1x, /large.png 2x">',
    '<iframe src="https://example.org"></iframe>', '<script>run()</script>', '<style>@import "/a.css";</style>',
    '<svg><image href="/a.svg"></image></svg>', '<custom-chart></custom-chart>', '<button>New action</button>',
    '<p onclick="run()">text</p>', '<p style="background:url(https://example.org/a)">text</p>', '<p hidden>meaningful text</p>']) {
    assert.throws(() => prepareGoOfflinePage(page(component), entry), /unsupported|unknown/i, component);
  }
});

test('duplicate non-symbol anchors cannot silently become accepted local targets', () => {
  assert.throws(() => prepareGoOfflinePage(page('<p id="same">one</p><p id="same">two</p>'), entry), /duplicate/i);
});

test('adapter emits exact links, explicit online markers and leaves example URL as text', () => {
  const prepared = prepareGoOfflinePage(page('<p><a href="#Println">Println</a> <a href="https://go.dev/doc/">Guide</a> <a href="http://address:port">literal address</a></p>'), entry);
  const resolver = createGoLinkResolver({ pages: [entry] }, { version: entry.version, goroot: '/verified/sdk/go', anchors: new Map([[entry.outputPath, prepared.anchors]]) });
  const result = adaptGoOfflinePage(prepared, entry, resolver);
  const $ = load(result.bodyHTML);
  assert.equal($('a[href="#Println"]').text(), 'Println');
  assert.equal($('a[href="https://go.dev/doc/"]').attr('data-crux-online'), 'external-reference');
  assert.match($('a[href="https://go.dev/doc/"]').text(), /Online/);
  assert.equal($('a[href="http://address:port"]').length, 0);
  assert.match($.text(), /literal address/);
  assert.match($.text(), /not executed offline/);
  assert.deepEqual(result.links, { local: 1, online: 1, literal: 1 });
});

test('adapter preserves reviewed broken prose with visible warning and evidence', () => {
  const prepared = prepareGoOfflinePage(page('<p><a href="/broken">Original API name</a></p>'), entry);
  const result = adaptGoOfflinePage(prepared, entry, () => ({ kind: 'literal', reason: 'upstream-broken-reference', evidence: 'https://github.com/golang/go/blob/go1.27.1/src/example.go#L1' }));
  const $ = load(result.bodyHTML);
  assert.match($.text(), /Original API name/);
  assert.match($.text(), /Upstream reference has no valid target/);
  assert.equal($('a[href="/broken"]').length, 0);
  assert.equal(result.warnings[0].href, '/broken');
  assert.equal(result.warnings[0].evidence, 'https://github.com/golang/go/blob/go1.27.1/src/example.go#L1');
});
