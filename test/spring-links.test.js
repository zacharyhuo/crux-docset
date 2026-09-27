import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpringLinkResolver } from '../src/spring/links.js';
import { createSpringReferencePolicy } from '../src/spring/references.js';

const file = 'testing/resttestclient.html';
function inputs() {
  return { version: '7.0.9', pages: new Map([[file, new Set(['page-title', 'resttestclient.workflow'])], ['index.html', new Set(['page-title'])]]),
    resources: new Set(['_images/container.png']), redirects: new Map([['old.html', 'index.html']]),
    policy: createSpringReferencePolicy({ version: '7.0.9', commit: 'a'.repeat(40), sources: new Map([
      ['gradle.properties', 'version=7.0.9\n'], ['testing/resttestclient.adoc', 'xref:resttestclient-workflow[Assertions]\n[[resttestclient.workflow]]\n=== Built-in Assertions\nBody.'],
    ]) }) };
}

test('repairs only missing targets and preserves an upstream-fixed original anchor', () => {
  const input = inputs();
  assert.deepEqual(createSpringLinkResolver(input)('#resttestclient-workflow', file), { kind: 'local', href: 'resttestclient.html#resttestclient.workflow', ruleId: 'resttestclient-workflow' });
  input.pages.get(file).add('resttestclient-workflow');
  assert.deepEqual(createSpringLinkResolver(input)('#resttestclient-workflow', file), { kind: 'local', href: 'resttestclient.html#resttestclient-workflow' });
});

test('source proof cannot authorize a nonexistent rendered replacement or an unknown reference', () => {
  const input = inputs(); input.pages.get(file).delete('resttestclient.workflow');
  assert.throws(() => createSpringLinkResolver(input)('#resttestclient-workflow', file), /replacement/i);
  assert.throws(() => createSpringLinkResolver(inputs())('#unreviewed', file), /missing/i);
  assert.throws(() => createSpringLinkResolver(inputs())('../absent.html', file), /missing/i);
});

test('resolves bounded local redirects, preserves encoded fragments once and inventories local resources', () => {
  const input = inputs(); input.pages.get('index.html').add('λ%20');
  const resolve = createSpringLinkResolver(input);
  assert.deepEqual(resolve('../old.html#%CE%BB%2520', file), { kind: 'local', href: '../index.html#%CE%BB%2520' });
  assert.deepEqual(resolve('../_images/container.png', file), { kind: 'local', href: '../_images/container.png' });
  assert.throws(() => resolve('../_images/container.png#bad', file), /missing/i);
  input.redirects.set('index.html', 'old.html');
  assert.throws(() => createSpringLinkResolver(input), /redirect|collision/i);
  input.redirects = new Map([['a.html', 'b.html'], ['b.html', 'a.html']]);
  assert.throws(() => createSpringLinkResolver(input)('../a.html', file), /redirect/i);
});

test('rejects escaping or executable links while explicitly classifying online navigation', () => {
  const resolve = createSpringLinkResolver(inputs());
  for (const href of ['../../outside.html', '../%2e%2e/outside.html', '/index.html', '//example.invalid/x', 'javascript:alert(1)',
    'file:///tmp/x', 'data:text/html,hi', '../index.html?x=1', '../%2findex.html', '../x\\y.html', '../index.html#%zz',
    'https://user:pass@example.invalid/x', 'https:\\example.invalid/x']) {
    assert.throws(() => resolve(href, file), /unsafe|unsupported|missing|encoding/i, href);
  }
  assert.deepEqual(resolve('https://docs.spring.io/other/?v=1#part', file), { kind: 'online', href: 'https://docs.spring.io/other/?v=1#part' });
});

test('snapshots inventories and rejects mismatched or forged source policy', () => {
  const input = inputs(), resolve = createSpringLinkResolver(input);
  input.pages.clear(); input.resources.clear();
  assert.equal(resolve('../index.html', file).href, '../index.html');
  assert.throws(() => resolve('#page-title', 'not-in-inventory.html'), /origin/i);
  assert.throws(() => createSpringLinkResolver({ ...inputs(), version: '7.0.10' }), /policy|version/i);
  assert.throws(() => createSpringLinkResolver({ ...inputs(), policy: {} }), /policy/i);
});
