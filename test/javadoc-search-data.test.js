import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseSearchData } from '../src/javadoc/search-data.js';

const wrap = (data, kind = 'module') => `${kind}SearchIndex = ${data};updateSearchResults();`;

test('accepts complete real JDK25 fixture indexes and preserves overload fragments', async () => {
  const result = {};
  for (const [kind, count] of [['module', 1], ['package', 2], ['type', 7], ['member', 19]]) {
    const text = await readFile(new URL(`./fixtures/javadoc25/${kind}-search-index.js`, import.meta.url), 'utf8');
    result[kind] = parseSearchData(text, kind);
    assert.equal(result[kind].length, count);
  }
  assert.deepEqual(result.module, [{ l: 'dev.crux.fixture' }]);
  assert.equal(result.member.find(row => row.l === 'copy(List, int...)').u, 'copy(java.util.List,int...)');
  assert.equal(result.member.find(row => row.l === 'Example(String[])').u, '%3Cinit%3E(java.lang.String[])');
  assert.equal(result.type.find(row => row.l === 'Example.Contract').k, '10');
});

test('parses string records without confusing punctuation for wrapper boundaries', () => {
  assert.deepEqual(parseSearchData(wrap('[{"l":"dev.crux.fixture"}]'), 'module'), [{ l: 'dev.crux.fixture' }]);
  const value = 'a];"\\λ';
  assert.deepEqual(parseSearchData(`\n ${wrap(JSON.stringify([{ l: value }]))}\t`, 'module'), [{ l: value }]);
  assert.deepEqual(parseSearchData(wrap('[]'), 'module'), []);
});

test('retains enum constant zero and absent method kind distinctly', () => {
  const rows = [{ p: 'p', c: 'E', l: 'FIRST', k: '0' }, { p: 'p', c: 'E', l: 'run()' }];
  assert.deepEqual(parseSearchData(wrap(JSON.stringify(rows), 'member'), 'member'), rows);
  const summary = [{ l: 'All Types', u: 'allclasses-index.html', k: '18' }];
  assert.deepEqual(parseSearchData(wrap(JSON.stringify(summary), 'type'), 'type'), summary);
});

test('rejects executable wrappers rather than evaluating any upstream code', () => {
  const marker = '__cruxJavadocParserExecuted';
  assert.equal(Object.hasOwn(globalThis, marker), false);
  for (const value of [
    `globalThis.${marker}=true;${wrap('[]')}`,
    `${wrap('[]')}globalThis.${marker}=true;`,
    'moduleSearchIndex = [];globalThis.__cruxJavadocParserExecuted=true;updateSearchResults();',
    'moduleSearchIndex = (() => [])();updateSearchResults();',
    'var moduleSearchIndex = [];updateSearchResults();',
    wrap('[]', 'type'),
  ]) assert.throws(() => parseSearchData(value, 'module'));
  assert.equal(Object.hasOwn(globalThis, marker), false);
});

test('rejects malformed JSON, duplicate decoded keys and unrecognized schemas', () => {
  for (const value of [
    '{}', 'null', '[null]', '[[]]', '[1]', '[{"l":1}]', '[{"l":null}]',
    '[{"l":{}}]', '[{"l":[]}]', '[{"l":"a","l":"b"}]',
    '[{"l":"a","\\u006c":"b"}]', '[{"l":"a","__proto__":"b"}]',
    '[{"l":"a","m":"b"}]', '[{}]', '[{"l":""}]',
    '[{"l":"a",}]', '[{"l":"a"},]', '[{"l":"\\x61"}]',
  ]) assert.throws(() => parseSearchData(wrap(value), 'module'), value);
  for (const [kind, row] of [
    ['type', { l: 'C' }], ['member', { p: 'p', l: 'f()' }],
    ['type', { p: 'p', l: 'C', k: 10 }], ['type', { p: 'p', l: 'C', k: '0' }],
    ['member', { p: 'p', c: 'C', l: 'f()', k: '12' }],
    ['package', { l: 'p', k: '99' }], ['type', { l: 'All', k: '18' }],
  ]) assert.throws(() => parseSearchData(wrap(JSON.stringify([row]), kind), kind));
  assert.throws(() => parseSearchData(wrap('[]'), '__proto__'));
  assert.throws(() => parseSearchData(Buffer.from(wrap('[]')), 'module'));
});

test('enforces byte, item and decoded field limits without truncating input', () => {
  assert.throws(() => parseSearchData(wrap(JSON.stringify([{ l: 'x'.repeat(16385) }])), 'module'));
  assert.throws(() => parseSearchData(wrap(JSON.stringify([{ l: 'λ'.repeat(8193) }])), 'module'));
  assert.throws(() => parseSearchData(wrap(JSON.stringify(Array.from({ length: 200001 }, () => ({ l: 'm' })))), 'module'));
  assert.throws(() => parseSearchData(' '.repeat(16 * 1024 * 1024 + 1), 'module'));
  assert.equal(parseSearchData(wrap(JSON.stringify([{ l: 'x'.repeat(16384) }])), 'module')[0].l.length, 16384);
});
