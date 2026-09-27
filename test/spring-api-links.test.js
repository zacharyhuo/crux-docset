import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpringApiLinkResolver } from '../src/spring/api-links.js';

const java = 'api/javadoc-api/', kotlin = 'api/kdoc-api/';
const javaPage = 'org/example/Api.html', basePage = 'org/example/Base.html';
const from = `${kotlin}spring-core/org.example/get.html`;
function fixture() {
  const pages = new Map([
    [java + 'index.html', new Set()], [kotlin + 'index.html', new Set()],
    [kotlin + 'spring-core/index.html', new Set()], [from, new Set(['literal%2Fid', '中文'])],
    [java + javaPage, new Set(['get(java.lang.String)'])], [java + basePage, new Set(['content(byte[])'])],
  ]);
  const javaMembers = new Map([
    [javaPage, { members: [{ page: javaPage, anchor: 'get(java.lang.String)', kind: 'Method' }], inherited: [{ page: basePage, anchor: 'content(byte[])' }] }],
    [basePage, { members: [{ page: basePage, anchor: 'content(byte[])', kind: 'Method' }], inherited: [] }],
  ]);
  return { version: '7.0.9', pages, javaMembers, resources: new Set([java + 'legal/LICENSE']) };
}
test('maps exact-version API URLs and inherited Dokka members to verified local targets', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  const root = 'https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/';
  assert.deepEqual(resolve(root + javaPage + '#get(kotlin.String)', from), {
    kind: 'local', href: '../../../javadoc-api/org/example/Api.html#get(java.lang.String)', target: java + javaPage, fragment: 'get(java.lang.String)', correction: 'dokka-java-member',
  });
  assert.equal(resolve(root + javaPage + '#content(kotlin.ByteArray)', from).target, java + basePage);
});
test('resolves sibling API and module directory links to explicit index pages', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  assert.equal(resolve('../kdoc-api/', java + 'index.html').href, '../kdoc-api/index.html');
  assert.equal(resolve('spring-core/', kotlin + 'index.html').href, 'spring-core/index.html');
  assert.equal(resolve('legal/LICENSE', java + 'index.html').target, java + 'legal/LICENSE');
});
test('preserves raw Dokka fragments and encoded Unicode while preferring exact targets', () => {
  const data = fixture(); data.pages.get(java + javaPage).add('get(kotlin.String)');
  const resolve = createSpringApiLinkResolver(data);
  assert.equal(resolve('#literal%2Fid', from).fragment, 'literal%2Fid');
  assert.equal(resolve('#%E4%B8%AD%E6%96%87', from).fragment, '%E4%B8%AD%E6%96%87');
  const result = resolve('https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/' + javaPage + '#get(kotlin.String)', from);
  assert.equal(result.fragment, 'get(kotlin.String)');
  assert.equal(result.correction, undefined);
});
test('keeps other versions and third-party links online without guessing latest', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  for (const href of ['https://docs.spring.io/spring-framework/docs/current/javadoc-api/index.html', 'https://docs.spring.io/spring-framework/docs/6.2.0/javadoc-api/index.html', 'https://example.com/index.html?q=x']) {
    assert.deepEqual(resolve(href, from), { kind: 'online', href });
  }
});
test('fails missing or ambiguous same-version targets and never applies Dokka correction to Java pages', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  for (const href of ['missing.html', '#absent', '#literal%25252Fid']) assert.throws(() => resolve(href, from), /missing/i);
  assert.throws(() => resolve('#get(kotlin.String)', java + javaPage), /missing/i);
});
test('rejects escaping paths, credentials and executable URLs before normalizing them', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  for (const href of ['../../../../../x.html', '%2e%2e/%2e%2e/%2e%2e/%2e%2e/x.html', 'a%2fb.html', 'a%252fb.html', '/index.html', '//evil/x', 'javascript:alert(1)', 'https://user:pass@example.com/', 'x.html?y=z', 'a\\b.html']) {
    assert.throws(() => resolve(href, from), /unsafe|unsupported/i);
  }
});
test('verifies declaring anchors and snapshots caller inventories', () => {
  const broken = fixture(); broken.pages.get(java + basePage).clear();
  assert.throws(() => createSpringApiLinkResolver(broken), /member|anchor/i);
  const data = fixture(), resolve = createSpringApiLinkResolver(data);
  data.pages.clear(); data.javaMembers.clear(); data.resources.clear();
  assert.equal(resolve('../kdoc-api/', java + 'index.html').target, kotlin + 'index.html');
});
test('does not map a versioned remote URL that escapes its version root', () => {
  const data = fixture(); data.pages.set('other.html', new Set());
  const resolve = createSpringApiLinkResolver(data);
  assert.throws(() => resolve('https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/../../other.html', from), /unsafe/i);
});
test('preserves plain author email links but refuses mail headers or encoded controls', () => {
  const resolve = createSpringApiLinkResolver(fixture());
  assert.deepEqual(resolve('mailto:author@example.org', from), { kind: 'online', href: 'mailto:author@example.org' });
  for (const href of ['mailto:author@example.org?subject=x', 'mailto:author@example.org%0d%0aBcc:other@example.org', 'mailto:author@example.org#x']) {
    assert.throws(() => resolve(href, from), /unsupported|unsafe/i);
  }
});
