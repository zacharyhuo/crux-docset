import test from 'node:test';
import assert from 'node:assert/strict';
import { readSpringKotlinDependencies } from '../src/spring/kotlin-dependencies.js';

const wrap = json => `sourceset_dependencies = '${json}'`;
test('reads generated source-set dependencies as data and preserves declaration order', () => {
  assert.deepEqual(readSpringKotlinDependencies(wrap('{":spring-core/main":[],":spring-web/main":[":spring-core/main"]}')), [
    { sourceSet: ':spring-core/main', dependencies: [] },
    { sourceSet: ':spring-web/main', dependencies: [':spring-core/main'] },
  ]);
});
test('rejects JavaScript expressions, wrapper mutations and trailing execution', () => {
  for (const text of ['sourceset_dependencies = JSON.stringify({})', 'var ' + wrap('{}'), wrap('{}') + ';fetch("https://example.com")',
    'sourceset_dependencies = `{"x":[]}`', "sourceset_dependencies = '{\"x\":[]}' + ''"]) assert.throws(() => readSpringKotlinDependencies(text), /Kotlin/i);
});
test('rejects duplicate keys and ambiguous escaped JSON instead of silently overwriting', () => {
  for (const json of ['{":spring-core/main":[],":spring-core/main":[]}', String.raw`{":spring-\u0063ore/main":[]}`, '{"__proto__":[]}']) {
    assert.throws(() => readSpringKotlinDependencies(wrap(json)), /Kotlin/i);
  }
});
test('rejects unknown, duplicate, self-referential and cyclic dependencies', () => {
  for (const json of ['{":spring-core/main":[":spring-missing/main"]}',
    '{":spring-core/main":[],":spring-web/main":[":spring-core/main",":spring-core/main"]}',
    '{":spring-core/main":[":spring-core/main"]}',
    '{":spring-core/main":[":spring-web/main"],":spring-web/main":[":spring-core/main]}']) {
    assert.throws(() => readSpringKotlinDependencies(wrap(json)), /Kotlin/i);
  }
});
test('rejects invalid shapes, source-set names and excessive input', () => {
  for (const json of ['[]', 'null', '{}', '{":spring-core/main":{}}', '{":spring-core/main":[1]}', '{"../../main":[]}', '{":spring-core/test":[]}']) {
    assert.throws(() => readSpringKotlinDependencies(wrap(json)), /Kotlin/i);
  }
  assert.throws(() => readSpringKotlinDependencies('x'.repeat(1024 * 1024 + 1)), /limit/i);
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`:spring-part-${i}/main`, []]));
  assert.throws(() => readSpringKotlinDependencies(wrap(JSON.stringify(tooMany))), /limit/i);
});
