import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createSpringBundleReferencePolicy, resolveSpringBundleReference } from '../src/spring/bundle-reference-policy.js';
import { createSpringApiLinkResolver } from '../src/spring/api-links.js';
import { rewriteSpringBundleLinks } from '../src/spring/bundle-links.js';

const version = '7.0.9', commit = '82a6b40b9366ec181ededdad282b307ee5381a52';
const root = new URL('./fixtures/spring-bundle-sources/', import.meta.url);
async function inputs() {
  const sources = new Map();
  for (const file of await readdir(root, { recursive: true })) if (file.endsWith('.java') || file.endsWith('.adoc') || file === 'gradle.properties') sources.set(file, await readFile(new URL(file, root), 'utf8'));
  return { version, commit, sources };
}
const java = 'api/javadoc-api/org/springframework/';
const cases = [
  ['web/webmvc-view/mvc-jsp', 'web/servlet/tags/package-summary.html', 'package.description', 'web/servlet/tags/package-summary.html', 'package-description'],
  ['web/webmvc-view/mvc-jsp', 'web/servlet/tags/form/package-summary.html', 'package.description', 'web/servlet/tags/form/package-summary.html', 'package-description'],
  ['web/webmvc/mvc-config/message-converters', 'web/servlet/config/annotation/WebMvcConfigurer.html', 'configureMessageConverters(org.springframework.http.converter.HttpMessageConverters.Builder)', 'web/servlet/config/annotation/WebMvcConfigurer.html', 'configureMessageConverters(org.springframework.http.converter.HttpMessageConverters.ServerBuilder)'],
  ['languages/kotlin/spring-projects-in', 'context/annotation/Configuration.html', 'proxyBeanMethods--', 'context/annotation/Configuration.html', 'proxyBeanMethods()'],
  ['data-access/oxm', 'oxm/xstream/XStreamMarshaller.html', 'setConverters(com.thoughtworks.xstream.converters.ConverterMatcher…\u200b)', 'oxm/xstream/XStreamMarshaller.html', 'setConverters(com.thoughtworks.xstream.converters.ConverterMatcher...)'],
  ['core/beans/factory-scopes', 'beans/factory/config/Scope.html', 'registerDestructionCallback', 'beans/factory/config/Scope.html', 'registerDestructionCallback(java.lang.String,java.lang.Runnable)'],
];
test('authorizes six exact Java anchor corrections and the Java class mislinked as Kotlin', async () => {
  const policy = createSpringBundleReferencePolicy(await inputs());
  for (const [from, file, fragment, target, anchor] of cases) {
    const result = resolveSpringBundleReference(policy, version, `reference/${from}.html`, java + file, fragment);
    assert.equal(result.kind, 'local'); assert.equal(result.target, java + target); assert.equal(result.fragment, anchor);
  }
  const result = resolveSpringBundleReference(policy, version, 'reference/languages/kotlin/coroutines.html', 'api/kdoc-api/spring-core/org.springframework.core/-propagation-context-element/index.html', '');
  assert.equal(result.target, java + 'core/PropagationContextElement.html'); assert.equal(result.fragment, '');
});
test('missing JCA class gets evidence and not an invented replacement page', async () => {
  const policy = createSpringBundleReferencePolicy(await inputs());
  const result = resolveSpringBundleReference(policy, version, 'reference/core/beans/context-introduction.html', java + 'jca/context/SpringContextResourceAdapter.html', '');
  assert.equal(result.kind, 'unavailable'); assert.equal(result.target, undefined);
  assert.equal(result.evidence, `https://github.com/spring-projects/spring-framework/blob/${commit}/framework-docs/modules/ROOT/pages/core/beans/context-introduction.adoc`);
});
test('rejects changed or missing source, unknown commit/version, forged or deserialized authorization', async () => {
  const data = await inputs();
  for (const file of data.sources.keys()) {
    const changed = new Map(data.sources); changed.set(file, changed.get(file) + '\n');
    assert.throws(() => createSpringBundleReferencePolicy({ ...data, sources: changed }), /source|proof/i);
  }
  const missing = new Map(data.sources); missing.delete('gradle.properties');
  assert.throws(() => createSpringBundleReferencePolicy({ ...data, sources: missing }), /source|proof/i);
  assert.throws(() => createSpringBundleReferencePolicy({ ...data, version: '7.0.10' }), /identity|version/i);
  assert.throws(() => createSpringBundleReferencePolicy({ ...data, commit: 'a'.repeat(40) }), /identity|commit/i);
  const policy = createSpringBundleReferencePolicy(data);
  for (const fake of [{}, JSON.parse(JSON.stringify(policy))]) assert.throws(() => resolveSpringBundleReference(fake, version, '', '', ''), /policy/i);
  assert.throws(() => resolveSpringBundleReference(policy, '7.0.10', '', '', ''), /policy|version/i);
});
test('does not authorize another origin, similar fragment or mutable input after creation', async () => {
  const data = await inputs(), policy = createSpringBundleReferencePolicy(data); data.sources.clear();
  assert.equal(resolveSpringBundleReference(policy, version, 'reference/other.html', java + cases[0][1], cases[0][2]), undefined);
  assert.equal(resolveSpringBundleReference(policy, version, 'reference/web/webmvc-view/mvc-jsp.html', java + cases[0][1], 'package.descriptions'), undefined);
  assert.equal(resolveSpringBundleReference(policy, version, 'reference/web/webmvc-view/mvc-jsp.html', java + cases[0][1], cases[0][2]).fragment, 'package-description');
});
test('resolver prefers repaired upstream original and verifies the replacement actually exists', async () => {
  const referencePolicy = createSpringBundleReferencePolicy(await inputs());
  const from = 'reference/languages/kotlin/spring-projects-in.html', target = java + 'context/annotation/Configuration.html';
  const href = 'https://docs.spring.io/spring-framework/docs/7.0.9/javadoc-api/org/springframework/context/annotation/Configuration.html#proxyBeanMethods--';
  const pages = new Map([[from, new Set()], [target, new Set(['proxyBeanMethods()'])]]);
  const result = createSpringApiLinkResolver({ version, pages, referencePolicy })(href, from);
  assert.equal(result.fragment, 'proxyBeanMethods()');
  const rewritten = rewriteSpringBundleLinks(`<a href="${href}">proxyBeanMethods</a>`, { from, resolve: createSpringApiLinkResolver({ version, pages, referencePolicy }) });
  assert.equal(rewritten.corrections[0].originalHref, href);
  assert.equal(rewritten.corrections[0].resolvedHref, '../../../api/javadoc-api/org/springframework/context/annotation/Configuration.html#proxyBeanMethods()');
  pages.get(target).add('proxyBeanMethods--');
  assert.equal(createSpringApiLinkResolver({ version, pages, referencePolicy })(href, from).fragment, 'proxyBeanMethods--');
  pages.get(target).clear();
  assert.throws(() => createSpringApiLinkResolver({ version, pages, referencePolicy })(href, from), /replacement|missing/i);
});
