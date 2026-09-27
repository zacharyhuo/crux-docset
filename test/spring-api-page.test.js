import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createSpringApiLinkResolver } from '../src/spring/api-links.js';
import { rewriteSpringApiPage } from '../src/spring/api-page.js';
const from = 'api/kdoc-api/index.html';
const resolver = () => createSpringApiLinkResolver({ version: '7.0.9', pages: new Map([[from, new Set()], ['api/javadoc-api/index.html', new Set()]]) });
test('rewrites actual HTML links, labels online links, and retains text and code', () => {
  const input = '<html><head><script type="text/javascript" src="https://unpkg.com/kotlin-playground@1/dist/playground.min.js" async=""></script></head><body><a href="../javadoc-api/">Java API</a><a href="https://example.com/">External</a><pre><code>val s = &quot;&lt;x&gt;&quot;</code></pre></body></html>';
  const result = rewriteSpringApiPage(input, { from, resolve: resolver() }), $ = load(result.html);
  assert.equal($('a').first().attr('href'), '../javadoc-api/index.html');
  assert.equal($('a').last().attr('data-crux-online'), 'true');
  assert.equal($('body').text(), load(input)('body').text());
  assert.equal($('script').length, 0);
  assert.deepEqual(result.counts, { local: 1, online: 1, corrected: 0, changed: 1, unavailable: 0, removedPlayground: 1 });
});
test('fails the page on a missing link instead of emitting a partially repaired success', () => {
  assert.throws(() => rewriteSpringApiPage('<a href="../javadoc-api/">valid</a><a href="missing.html">missing</a>', { from, resolve: resolver() }), /missing/i);
});
test('retains leading blank lines in preformatted content across Java and Kotlin serialization', () => {
  const input = '<main><pre>\n\n  code()\n</pre><textarea>\n\nexample</textarea><listing>\n\ntext</listing></main>';
  for (const page of [from, 'api/javadoc-api/index.html']) {
    const result = rewriteSpringApiPage(input, { from: page, resolve: resolver() });
    assert.equal(load(result.html)('body').text(), load(input)('body').text());
    const twice = rewriteSpringApiPage(result.html, { from: page, resolve: resolver() });
    assert.equal(load(twice.html)('body').text(), load(input)('body').text());
  }
});
