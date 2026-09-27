import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { createSpringApiLinkResolver } from '../src/spring/api-links.js';
import { rewriteSpringBundleLinks } from '../src/spring/bundle-links.js';

const from = 'reference/core/beans.html';
const root = 'https://docs.spring.io/spring-framework/docs/7.0.9/';
const pages = new Map([[from, new Set(['title'])], ['api/javadoc-api/org/example/Bean.html', new Set(['get()'])],
  ['api/kdoc-api/spring-core/index.html', new Set(['raw%2Fid'])]]);
const resolve = () => createSpringApiLinkResolver({ version: '7.0.9', pages });
test('localizes assembled reference to Java and Kotlin links without changing content or IDs', () => {
  const html = `<main id="title"><h1>Beans</h1><pre>\nfirst\nsecond</pre><a data-crux-online="true" href="${root}javadoc-api/org/example/Bean.html#get()"><code>get()</code></a><a data-crux-online="true" href="${root}kdoc-api/spring-core/#raw%2Fid">Kotlin</a></main>`;
  const result = rewriteSpringBundleLinks(html, { from, resolve: resolve() });
  const $ = load(result.html);
  assert.equal($('main').text(), load(html)('main').text());
  assert.equal($('main').attr('id'), 'title');
  assert.equal($('a').eq(0).attr('href'), '../../api/javadoc-api/org/example/Bean.html#get()');
  assert.equal($('a').eq(1).attr('href'), '../../api/kdoc-api/spring-core/index.html#raw%2Fid');
  assert.equal($('a[data-crux-online]').length, 0);
  assert.equal(result.changed, 2);
});
test('retains explicit online markers for other versions, unversioned and external links', () => {
  const urls = [root.replace('7.0.9', 'current') + 'javadoc-api/index.html', 'https://docs.spring.io/spring-framework/reference/core/beans.html', 'https://example.org/'];
  const result = rewriteSpringBundleLinks(`<main>${urls.map(url => `<a href="${url}">online</a>`).join('')}</main>`, { from, resolve: resolve() });
  const $ = load(result.html);
  assert.deepEqual($('a').toArray().map(n => n.attribs.href), urls);
  assert.equal($('a[data-crux-online="true"]').length, 3);
  assert.equal(result.changed, 0);
});
test('fails unresolved exact-version links instead of silently retaining them online', () => {
  assert.throws(() => rewriteSpringBundleLinks(`<a href="${root}javadoc-api/missing.html">Missing</a>`, { from, resolve: resolve() }), /missing/i);
});
