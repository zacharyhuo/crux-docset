import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSpringJavaReferencePolicy, resolveReviewedSpringJavaReference } from '../src/spring/java-reference-policy.js';
import { createSpringApiLinkResolver } from '../src/spring/api-links.js';
import { rewriteSpringApiPage } from '../src/spring/api-page.js';
import { load } from 'cheerio';

const commit = '82a6b40b9366ec181ededdad282b307ee5381a52';
const prefix = 'spring-webmvc/src/main/java/org/springframework/web/servlet/mvc/';
const from = 'api/javadoc-api/org/springframework/web/servlet/mvc/AbstractController.html';
const target = 'api/javadoc-api/org/springframework/web/servlet/mvc/Controller.html';
async function input() {
  const sources = new Map([['gradle.properties', 'version=7.0.9\n']]);
  for (const name of ['Controller.java', 'AbstractController.java']) sources.set(prefix + name, await readFile(new URL(`./fixtures/spring-java/${name}`, import.meta.url), 'utf8'));
  return { version: '7.0.9', commit, sources };
}
test('authorizes only the exact source-proven dangling reference with a commit-pinned origin', async () => {
  const policy = createSpringJavaReferencePolicy(await input());
  const result = resolveReviewedSpringJavaReference(policy, '7.0.9', from, target, 'config');
  assert.deepEqual(result, { kind: 'unavailable', reason: 'upstream-missing-section', ruleId: 'controller-interface-config',
    evidence: `https://github.com/spring-projects/spring-framework/blob/${commit}/${prefix}AbstractController.java#L51` });
  assert.equal(policy.evidence.length, 1);
  assert.equal(resolveReviewedSpringJavaReference(policy, '7.0.9', from, target, 'workflow'), undefined);
  assert.equal(resolveReviewedSpringJavaReference(policy, '7.0.9', target, target, 'config'), undefined);
});
test('source drift or missing evidence cannot authorize an exception', async () => {
  for (const name of ['Controller.java', 'AbstractController.java']) {
    const data = await input(); data.sources.set(prefix + name, data.sources.get(prefix + name) + '\n');
    const policy = createSpringJavaReferencePolicy(data);
    assert.equal(resolveReviewedSpringJavaReference(policy, '7.0.9', from, target, 'config'), undefined);
  }
  const data = await input(); data.sources.delete(prefix + 'Controller.java');
  assert.equal(createSpringJavaReferencePolicy(data).evidence.length, 0);
});
test('rejects forged or cross-version policy and mismatched source identity', async () => {
  const data = await input(), policy = createSpringJavaReferencePolicy(data);
  assert.throws(() => resolveReviewedSpringJavaReference({ ...policy }, '7.0.9', from, target, 'config'), /policy/i);
  assert.throws(() => resolveReviewedSpringJavaReference(policy, '6.2.0', from, target, 'config'), /version/i);
  assert.throws(() => createSpringJavaReferencePolicy({ ...data, version: '7.0.10' }), /version/i);
  assert.throws(() => createSpringJavaReferencePolicy({ ...data, commit: 'main' }), /identity/i);
});
test('bounds and snapshots evidence inputs rather than retaining mutable caller data', async () => {
  const data = await input(), policy = createSpringJavaReferencePolicy(data);
  data.sources.clear();
  assert.ok(resolveReviewedSpringJavaReference(policy, '7.0.9', from, target, 'config'));
  const bad = await input(); bad.sources.set(prefix + 'Controller.java', 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => createSpringJavaReferencePolicy(bad), /limit/i);
});
test('rewrites a proven unavailable section as visible notice without losing original link text or IDs', async () => {
  const javaReferencePolicy = createSpringJavaReferencePolicy(await input());
  const pages = new Map([[from, new Set(['origin'])], [target, new Set(['workflow'])]]);
  const resolve = createSpringApiLinkResolver({ version: '7.0.9', pages, javaReferencePolicy });
  const original = '<main><a id="origin" href="Controller.html#config"><code>and those defined by interface</code></a></main>';
  const result = rewriteSpringApiPage(original, { from, resolve }), $ = load(result.html);
  assert.equal($('#origin').text(), 'and those defined by interface');
  assert.equal($('#origin').attr('href'), undefined);
  assert.equal($('#origin code').length, 1);
  assert.match($('[role="note"]').text(), /section unavailable/i);
  assert.equal($('[role="note"] a').attr('href'), `https://github.com/spring-projects/spring-framework/blob/${commit}/${prefix}AbstractController.java#L51`);
  assert.equal($('a a').length, 0);
  assert.equal(result.counts.unavailable, 1);
  assert.equal(result.warnings.length, 1);
});
test('rendered original targets win and missing target files never get a section exception', async () => {
  const javaReferencePolicy = createSpringJavaReferencePolicy(await input());
  let pages = new Map([[from, new Set()], [target, new Set(['config'])]]);
  const resolve = createSpringApiLinkResolver({ version: '7.0.9', pages, javaReferencePolicy });
  assert.equal(resolve('Controller.html#config', from).kind, 'local');
  pages = new Map([[from, new Set()]]);
  assert.throws(() => createSpringApiLinkResolver({ version: '7.0.9', pages, javaReferencePolicy })('Controller.html#config', from), /missing/i);
  assert.throws(() => createSpringApiLinkResolver({ version: '7.0.9', pages, javaReferencePolicy: { ...javaReferencePolicy } }), /policy/i);
});
