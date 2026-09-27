import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpringReferencePolicy, resolveReviewedSpringReference } from '../src/spring/references.js';

const commit = '82a6b40b9366ec181ededdad282b307ee5381a52';
const origin = 'testing/resttestclient.html';
const text = '1. xref:resttestclient-workflow[Built-in Assertions] extend the request workflow with a chain of expectations\n\n[[resttestclient.workflow]]\n=== Built-in Assertions\n\nAssertions body.\n';
function input(version = '7.0.9') {
  return { version, commit, sources: new Map([['gradle.properties', `version=${version}\n`], ['testing/resttestclient.adoc', text]]) };
}

test('repairs only reviewed origin/target/fragment with current source proof', () => {
  const policy = createSpringReferencePolicy(input());
  assert.deepEqual(resolveReviewedSpringReference(policy, '7.0.9', origin, origin, 'resttestclient-workflow'), {
    kind: 'local', target: origin, fragment: 'resttestclient.workflow', ruleId: 'resttestclient-workflow',
  });
  assert.equal(resolveReviewedSpringReference(policy, '7.0.9', 'testing/other.html', origin, 'resttestclient-workflow'), undefined);
  assert.equal(resolveReviewedSpringReference(policy, '7.0.9', origin, origin, 'unknown-workflow'), undefined);
  assert.equal(policy.evidence.length, 1);
  assert.match(policy.evidence[0].proofs[0].sha256, /^[a-f0-9]{64}$/);
});

test('missing, changed or ambiguous source declarations do not authorize a repair', () => {
  for (const value of [text.replace('xref:resttestclient-workflow[', 'xref:other['), text.replace('[[resttestclient.workflow]]', '[[new-workflow]]'),
    text.replace('=== Built-in Assertions', '=== Unrelated section'), text + '\n[[resttestclient.workflow]]\n=== Built-in Assertions\n']) {
    const data = input(); data.sources.set('testing/resttestclient.adoc', value);
    assert.equal(createSpringReferencePolicy(data).evidence.length, 0);
  }
  const data = input(); data.sources.delete('testing/resttestclient.adoc');
  assert.equal(createSpringReferencePolicy(data).evidence.length, 0);
});

test('same proofs on a new patch retain rule with current digests and commit evidence', () => {
  const before = createSpringReferencePolicy(input());
  const data = input('7.0.10'); data.commit = 'a'.repeat(40); data.sources.set('testing/resttestclient.adoc', '\n// shifted\n' + text);
  const after = createSpringReferencePolicy(data);
  assert.equal(after.evidence.length, 1);
  assert.notEqual(before.evidence[0].proofs[0].sha256, after.evidence[0].proofs[0].sha256);
  assert.equal(after.commit, 'a'.repeat(40));
  assert.equal(after.evidence[0].proofs[0].line, 3);
});

test('audit serialization, cross-version replay and mutation cannot grant policy access', () => {
  const data = input(), policy = createSpringReferencePolicy(data);
  for (const fake of [JSON.parse(JSON.stringify(policy)), { ...policy }, {}]) {
    assert.throws(() => resolveReviewedSpringReference(fake, '7.0.9', origin, origin, 'resttestclient-workflow'), /policy/i);
  }
  assert.throws(() => resolveReviewedSpringReference(policy, '7.0.10', origin, origin, 'resttestclient-workflow'), /version|policy/i);
  assert.throws(() => policy.evidence.push({}), TypeError);
  assert.throws(() => { policy.evidence[0].proofs[0].sha256 = 'b'.repeat(64); }, TypeError);
  data.sources.clear();
  assert.equal(resolveReviewedSpringReference(policy, '7.0.9', origin, origin, 'resttestclient-workflow').kind, 'local');
});

test('title and prefix corrections require exact source identity, not similar title matching', () => {
  const data = input();
  data.sources.set('web.adoc', 'xref:web/webmvc.adoc#mvc[Spring MVC],\n');
  data.sources.set('web/webmvc.adoc', '[[mvc]]\n:chapter: mvc\n[[spring-web-mvc]]\n= Spring Web MVC\nBody.');
  const xml = 'core/appendix/xml-custom.adoc';
  data.sources.set(xml, '. xref:core/appendix/xml-custom.adoc#core.appendix.xsd-custom-schema[Author] an XML schema to describe your custom element(s).\n[[xsd-custom-schema]]\n== Authoring the Schema\nBody.');
  const policy = createSpringReferencePolicy(data);
  assert.equal(resolveReviewedSpringReference(policy, '7.0.9', 'web.html', 'web/webmvc.html', 'mvc').fragment, 'page-title');
  assert.equal(resolveReviewedSpringReference(policy, '7.0.9', 'core/appendix/xml-custom.html', 'core/appendix/xml-custom.html', 'core.appendix.xsd-custom-schema').fragment, 'xsd-custom-schema');
  data.sources.set('web/webmvc.adoc', 'Unrelated preamble\n' + data.sources.get('web/webmvc.adoc'));
  assert.equal(resolveReviewedSpringReference(createSpringReferencePolicy(data), '7.0.9', 'web.html', 'web/webmvc.html', 'mvc'), undefined);
});

test('deleted-section warnings cannot be granted by an unreviewed target file', () => {
  const data = input();
  data.sources.set('testing/testcontext-framework/ctx-management/groovy.adoc', 'xref:core/beans/basics.adoc#beans-factory-groovy[Groovy Bean Definition DSL], you can annotate\n');
  data.sources.set('core/beans/basics.adoc', '[[beans-basics]]\n= Container Overview\nChanged source.');
  assert.equal(resolveReviewedSpringReference(createSpringReferencePolicy(data), '7.0.9', 'testing/testcontext-framework/ctx-management/groovy.html', 'core/beans/basics.html', 'beans-factory-groovy'), undefined);
});

test('cross-page correction names the actual transaction page, never the stale chapter root', () => {
  const data = input();
  data.sources.set('core/appendix/xsd-schemas.adoc', 'you can use the <<data-access.adoc#tx-decl-explained, `<tx:annotation-driven/>`>>\n');
  data.sources.set('data-access/transaction/declarative/tx-decl-explained.adoc', "[[tx-decl-explained]]\n= Understanding the Spring Framework's Declarative Transaction Implementation\n\nReal explanation.");
  const resolve = d => resolveReviewedSpringReference(createSpringReferencePolicy(d), '7.0.9', 'core/appendix/xsd-schemas.html', 'data-access.html', 'tx-decl-explained');
  assert.deepEqual(resolve(data), { kind: 'local', target: 'data-access/transaction/declarative/tx-decl-explained.html', fragment: 'page-title', ruleId: 'transaction-explanation' });
  data.sources.delete('data-access/transaction/declarative/tx-decl-explained.adoc');
  assert.equal(resolve(data), undefined);
});

test('aggregate source budget cannot be bypassed with individually bounded files', () => {
  const data = input();
  for (let i = 0; i < 9; i++) data.sources.set(`page-${i}.adoc`, 'x'.repeat(4 * 1024 ** 2));
  assert.throws(() => createSpringReferencePolicy(data), /size limit/i);
});

test('rejects invalid identity, path, source type and source size budgets', () => {
  for (const mutation of [d => { d.commit = 'main'; }, d => { d.version = '7.0.9-SNAPSHOT'; }, d => { d.sources.set('gradle.properties', 'version=7.0.8\n'); },
    d => { d.sources.set('../outside.adoc', 'x'); }, d => { d.sources.set('other.adoc', Buffer.from('x')); },
    d => { d.sources.set('other.adoc', 'x'.repeat(4 * 1024 ** 2 + 1)); }, d => { d.sources.set('gradle.properties', 'version=7.0.9\nversion=7.0.9\n'); }]) {
    const data = input(); mutation(data); assert.throws(() => createSpringReferencePolicy(data), /identity|version|path|source|limit/i);
  }
});
