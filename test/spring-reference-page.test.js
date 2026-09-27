import assert from 'node:assert/strict';
import test from 'node:test';
import { readSpringReferencePage } from '../src/spring/reference-page.js';

const identity = { version: '7.0.9', outputPath: 'reference/core/beans.html' };
const article = '<h1 id="page-title">Container Overview</h1><p>The container creates beans.</p><h2 id="configuration">Configuration</h2><p>Configure beans.</p><h3 id="xml">XML</h3><pre><code>&lt;bean/&gt;</code></pre><h2 id="lifecycle">Lifecycle</h2><p>Lifecycle callbacks.</p>';
function page(body = article, before = '', head = '') {
  return `<html><head><meta name="version" content="7.0.9"><meta name="component" content="framework">${head}</head><body>${before}<main><article class="doc">${body}</article></main></body></html>`;
}

test('indexes page and hierarchical sections with exact targets rather than website chrome', () => {
  const html = page(article + '<nav><h2 id="nav">Wrong navigation</h2></nav>', '<header><h1>Spring Website</h1></header><aside><h2 id="side">Versions</h2></aside>');
  const result = readSpringReferencePage(html, identity);
  assert.equal(result.title, 'Container Overview');
  assert.deepEqual(result.symbols, [
    { name: 'Container Overview', type: 'Guide', path: 'reference/core/beans.html' },
    { name: 'Container Overview — Configuration', type: 'Section', path: 'reference/core/beans.html#configuration' },
    { name: 'Container Overview — Configuration — XML', type: 'Section', path: 'reference/core/beans.html#xml' },
    { name: 'Container Overview — Lifecycle', type: 'Section', path: 'reference/core/beans.html#lifecycle' },
  ]);
  assert.deepEqual(result.headings, [
    { title: 'Configuration', level: 2, path: 'reference/core/beans.html#configuration' },
    { title: 'XML', level: 3, path: 'reference/core/beans.html#xml' },
    { title: 'Lifecycle', level: 2, path: 'reference/core/beans.html#lifecycle' },
  ]);
});

test('preserves repeated titles, skipped heading levels and encoded Unicode fragments', () => {
  const result = readSpringReferencePage(page('<h1>Overview &amp; Usage</h1><p>Guide.</p><h2 id="a">Examples</h2><h4 id="λ%20 &amp; x">XML &amp; Java</h4><h6 id="deep">Details</h6><h3 id="b">Examples</h3><h2 id="c">Examples</h2>'), identity);
  assert.deepEqual(result.symbols.map(s => [s.name, s.path]), [
    ['Overview & Usage', 'reference/core/beans.html'],
    ['Overview & Usage — Examples', 'reference/core/beans.html#a'],
    ['Overview & Usage — Examples — XML & Java', 'reference/core/beans.html#%CE%BB%2520%20%26%20x'],
    ['Overview & Usage — Examples — XML & Java — Details', 'reference/core/beans.html#deep'],
    ['Overview & Usage — Examples — Examples', 'reference/core/beans.html#b'],
    ['Overview & Usage — Examples', 'reference/core/beans.html#c'],
  ]);
});

test('rejects wrong, missing or duplicate version/component metadata', () => {
  for (const html of [page().replace('7.0.9', '7.0.8'), page().replace('framework', 'boot'),
    page().replace('<meta name="version" content="7.0.9">', ''), page(article, '', '<meta name="version" content="7.0.9">'),
    page(article, '', '<meta name="component" content="framework">')]) {
    assert.throws(() => readSpringReferencePage(html, identity), /identity|version|component/i);
  }
});

test('keeps chapter guide pages but excludes generated section-summary navigation headings', () => {
  const html = page('<h1>Core Technologies</h1><div class="section-summary"><h2>Localized section summary</h2><ul class="nav-section-summary"><li><a href="beans.html">IoC Container</a></li></ul></div>');
  assert.deepEqual(readSpringReferencePage(html, identity).symbols, [
    { name: 'Core Technologies', type: 'Guide', path: 'reference/core/beans.html' },
  ]);
  assert.throws(() => readSpringReferencePage(page('<h1>Guide</h1><p>Text.</p><h2>Section Summary</h2>'), identity), /anchor/i);
});

test('rejects redirect, missing article, empty title, title-only and ambiguous article', () => {
  for (const html of [page(article, '', '<meta http-equiv="Refresh" content="0;url=other.html">'), page().replace('class="doc"', ''),
    page('<h1></h1><p>Body.</p>'), page('<h1>Title only</h1>'), page('', '<article class="doc">Other body</article>'),
    page('<h1>One</h1><h1>Two</h1><p>Body.</p>')]) {
    assert.throws(() => readSpringReferencePage(html, identity), /redirect|article|body|title/i);
  }
});

test('rejects missing, empty or ambiguous heading anchors including collisions outside article', () => {
  for (const html of [page(article.replace('id="xml"', '')), page(article.replace('id="xml"', 'id=""')),
    page(article.replace('>XML</h3>', '></h3>')), page(article, '<nav id="xml">Wrong</nav>'),
    page(article, '<a name="xml">Wrong</a>'), page(article, '<script id="xml">void 0</script>'),
    page(article, '', '<meta id="xml">'), page(article.replace('id="lifecycle"', 'id="xml"'))]) {
    assert.throws(() => readSpringReferencePage(html, identity), /anchor|heading/i);
  }
});

test('does not execute scripts or index code/template/UI headings', () => {
  const hidden = '<script>throw new Error("executed")</script><template><h2 id="template">Wrong</h2></template><pre><h2 id="pre">Wrong</h2></pre><code><h2 id="code">Wrong</h2></code><footer><h2 id="foot">Wrong</h2></footer>';
  assert.equal(readSpringReferencePage(page(article + hidden), identity).symbols.length, 4);
  assert.throws(() => readSpringReferencePage(page('<h1>Title</h1>' + hidden), identity), /body/i);
});

test('rejects unsafe paths, unstable versions and oversized input before accepting symbols', () => {
  for (const outputPath of ['/reference/a.html', 'reference/../a.html', 'reference/%2e%2e/a.html', 'reference/a.html#x',
    'reference/a.html?x=1', 'https://example.invalid/a.html', 'reference/a\\b.html', 'api/a.html', 'reference//a.html', 'reference/a\n.html']) {
    assert.throws(() => readSpringReferencePage(page(), { ...identity, outputPath }), /path|identity/i);
  }
  for (const version of ['7.0', '7.0.9-SNAPSHOT', '07.0.9', '7.0.9\n']) {
    assert.throws(() => readSpringReferencePage(page(), { ...identity, version }), /version|identity/i);
  }
  assert.throws(() => readSpringReferencePage('x'.repeat(16 * 1024 ** 2 + 1), identity), /limit/i);
  assert.throws(() => readSpringReferencePage(page(article.replace('id="xml"', 'id="bad&#10;id"')), identity), /anchor/i);
});

test('counts comments and text toward the DOM budget before cloning the article', () => {
  for (const extra of ['<!--x-->'.repeat(300001), 'x<!--x-->'.repeat(150001)]) {
    assert.throws(() => readSpringReferencePage(page(article + extra), identity), /DOM.*limit/i);
  }
  assert.equal(readSpringReferencePage(page(article + 'x<!--x-->'.repeat(1000)), identity).symbols.length, 4);
});
