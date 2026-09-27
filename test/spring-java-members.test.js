import test from 'node:test';
import assert from 'node:assert/strict';
import { readSpringJavaMembers } from '../src/spring/java-members.js';

const page = 'org/example/Api.html';
const html = content => `<html><body><nav><a id="navigation">x</a></nav><main>${content}</main></body></html>`;
test('reads canonical detail and erased-signature heading anchors as real members', () => {
  const result = readSpringJavaMembers(html('<section class="method-details"><section class="detail" id="body(P,java.lang.Class)"><h3 id="body(org.reactivestreams.Publisher,java.lang.Class)">body</h3><div class="member-signature">body(P publisher, Class type)</div></section></section>'), { page });
  assert.deepEqual(result.members, [
    { page, anchor: 'body(P,java.lang.Class)', kind: 'Method' },
    { page, anchor: 'body(org.reactivestreams.Publisher,java.lang.Class)', kind: 'Method' },
  ]);
});
test('keeps inherited targets separate until the declaring-page anchor is verified', () => {
  const result = readSpringJavaMembers(html('<div class="inherited-list"><h3><a href="Base.html#method-summary">Base</a></h3><code><a href="../base/Base.html#content(byte%5B%5D)">content</a><a href="https://example.com/Object.html#equals(java.lang.Object)">equals</a></code></div>'), { page });
  assert.deepEqual(result.members, []);
  assert.deepEqual(result.inherited, [{ page: 'org/base/Base.html', anchor: 'content(byte[])' }]);
  assert.deepEqual(result.externalInherited, ['https://example.com/Object.html#equals(java.lang.Object)']);
});
test('rejects duplicate navigation IDs that would steal a declaration anchor', () => {
  assert.throws(() => readSpringJavaMembers(html('<i id="get()"></i><section class="method-details"><section class="detail" id="get()"><h3>get</h3></section></section>'), { page }), /ambiguous/i);
});
test('does not mistake inherited nested-type pages for member-anchor links', () => {
  const result = readSpringJavaMembers(html('<div class="inherited-list"><h3 id="nested-classes-inherited-from-class-org.example.Base">Nested classes</h3><code><a href="Base.Nested.html">Nested</a></code></div>'), { page });
  assert.deepEqual(result.inherited, []);
  assert.deepEqual(result.members, []);
});
test('rejects inherited path escape and redirects instead of accepting a wrong declaring page', () => {
  for (const href of ['../../../outside.html#x', '%2e%2e/Outside.html#x', 'Base.html?q=x#x', 'javascript:alert(1)', 'Base.html']) {
    assert.throws(() => readSpringJavaMembers(html(`<div class="inherited-list"><code><a href="${href}">x</a></code></div>`), { page }), /inherited/i);
  }
  assert.throws(() => readSpringJavaMembers('<meta http-equiv="refresh" content="0;url=other.html"><main>x</main>', { page }), /redirect/i);
});
test('bounds inputs and does not index arbitrary nested IDs or non-body details', () => {
  assert.throws(() => readSpringJavaMembers('x'.repeat(16 * 1024 * 1024 + 1), { page }), /limit/i);
  assert.throws(() => readSpringJavaMembers('<main>x</main>', { page: '../Api.html' }), /path/i);
  const result = readSpringJavaMembers(html('<section class="field-details"><section class="detail" id="VALUE"><h3>VALUE</h3><p id="example">example</p></section></section>'), { page });
  assert.deepEqual(result.members, [{ page, anchor: 'VALUE', kind: 'Field' }]);
});
