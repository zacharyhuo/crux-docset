import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { prepareSpringOfflinePage } from '../src/spring/offline.js';

const identity = { version: '7.0.9', outputPath: 'reference/core/beans.html' };
const base = '<h1 id="page-title">Container</h1><p>Body.</p><h2 id="usage">Usage</h2>';
const page = body => `<html><head><meta name="version" content="7.0.9"><meta name="component" content="framework"></head><body><aside>Website navigation</aside><main><article class="doc">${base}${body}</article></main></body></html>`;
const tabs = '<div id="examples" class="openblock tabs is-sync is-loading"><div class="content"><div class="ulist tablist"><ul><li id="java" class="tab"><p>Java</p></li><li id="kotlin" class="tab"><p>Kotlin</p></li></ul></div><div id="java--panel" class="tabpanel" aria-labelledby="java"><pre><code data-lang="java">new Context();</code></pre></div><div id="kotlin--panel" class="tabpanel" aria-labelledby="kotlin"><pre><code data-lang="kotlin"><span class="fold-block is-hidden-folded">import Context\n</span>Context()</code></pre></div></div></div>';

test('replaces script-dependent tabs with labeled native disclosures without losing either example or its anchors', () => {
  const prepared = prepareSpringOfflinePage(page(tabs), identity), $ = load(prepared.bodyHTML);
  assert.equal($('aside').length, 0);
  assert.equal($('details').length, 2);
  assert.equal($('details#java--panel > summary#java').text(), 'Java');
  assert.equal($('details#kotlin--panel > summary#kotlin').text(), 'Kotlin');
  assert.equal($('details#java--panel code').text(), 'new Context();');
  assert.equal($('details#kotlin--panel code').text(), 'import Context\nContext()');
  assert.equal($('details[open]').length, 2);
  assert.equal($('.is-loading,.is-sync,.is-hidden-folded,.tablist').length, 0);
  assert.ok(['examples', 'java', 'java--panel', 'kotlin', 'kotlin--panel'].every(id => prepared.anchors.has(id)));
  assert.equal(prepared.tabPanels, 2);
  assert.equal(prepared.symbols.length, 2);
});

test('reports every required image and preserves tables, inline column widths and body links', () => {
  const prepared = prepareSpringOfflinePage(page('<table><colgroup><col style="width: 50%;"></colgroup><tr><td>Data</td></tr></table><img src="../_images/container.png" alt="Container" width="60%"><a href="../core.html#beans">Beans</a>'), identity);
  assert.deepEqual(prepared.resources, [{ tag: 'img', attribute: 'src', url: '../_images/container.png' }]);
  const $ = load(prepared.bodyHTML);
  assert.equal($('td').text(), 'Data');
  assert.equal($('col').attr('style'), 'width: 50%;');
  assert.equal($('img').attr('width'), '60%');
  assert.equal($('a').attr('href'), '../core.html#beans');
});

test('preserves the optional example title alongside language disclosures', () => {
  const titled = tabs.replace('<div class="content">', '<div class="title">Request-scoped bean test</div><div class="content">');
  const prepared = prepareSpringOfflinePage(page(titled), identity), $ = load(prepared.bodyHTML);
  assert.equal($('#examples > .title').text(), 'Request-scoped bean test');
  assert.equal($('#examples details').length, 2);
  assert.throws(() => prepareSpringOfflinePage(page(tabs.replace('<div class="content">', '<div class="paragraph">Unexpected sibling</div><div class="content">')), identity), /tab/i);
});

test('rejects unknown body resources, remote images and executable or hidden components rather than silently dropping content', () => {
  for (const body of ['<script>throw 1</script>', '<iframe src="video.html"></iframe>', '<img src="https://example.invalid/x.png">',
    '<img src="x.png" srcset="other.png 2x">', '<p style="background:url(x.png)">Text</p>', '<div onclick="alert(1)">Text</div>',
    '<div class="js-unreviewed">Text</div>', '<div hidden>Text</div>', '<style>@import "x.css";</style>', '<img src="data:image/png;base64,AA==">',
    '<img src="../../../outside.png">', '<img src="%2foutside.png">', '<img src="x.png?remote=1">', '<img src="">']) {
    assert.throws(() => prepareSpringOfflinePage(page(body), identity), /unsupported|unsafe|missing/i, body);
  }
});

test('rejects duplicate paragraph anchors and malformed or orphaned tab panels', () => {
  for (const body of ['<p id="duplicate">One</p><p id="duplicate">Two</p>', tabs.replace('aria-labelledby="kotlin"', 'aria-labelledby="java"'),
    tabs.replace('id="kotlin"', 'id="wrong"'), '<div class="tabpanel" aria-labelledby="missing">Lost content</div>',
    tabs.replace('<p>Kotlin</p>', '<p><a href="other.html">Kotlin</a></p>')]) {
    assert.throws(() => prepareSpringOfflinePage(page(body), identity), /anchor|tab|panel/i);
  }
});

test('keeps admonition labels legible without an icon font and identifies collapsed-code summaries', () => {
  const prepared = prepareSpringOfflinePage(page('<div class="admonitionblock note"><table><tr><td class="icon"><i class="fa icon-note" title="Note"></i></td><td class="content">Take care.</td></tr></table></div><pre><code><span class="fold-block is-hidden-folded">full source</span><span class="fold-block is-hidden-unfolded">// ...</span></code></pre>'), identity);
  const $ = load(prepared.bodyHTML);
  assert.equal($('.icon').text(), 'Note');
  assert.equal($('code').text(), 'full source');
  assert.equal($('.Crux-foldSummary pre').text(), '// ...');
  assert.equal($('.Crux-foldSummary').parents('pre,code').length, 0);
  assert.equal($('.Crux-foldSummary[open]').length, 0);
  assert.equal($('.is-hidden-unfolded').length, 0);
});

test('navigation-only IDs cannot serve as rendered correction targets', () => {
  const prepared = prepareSpringOfflinePage(page('<nav id="nav-target"><a href="#usage">Usage</a></nav><p id="body-target">Text</p>'), identity);
  assert.ok(prepared.anchors.has('nav-target'));
  assert.ok(prepared.contentAnchors.has('body-target'));
  assert.equal(prepared.contentAnchors.has('nav-target'), false);
});
