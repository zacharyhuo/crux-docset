import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseSearchData } from '../src/javadoc/search-data.js';
import { resolveJavadocSymbols } from '../src/javadoc/symbols.js';

const input = overrides => ({ modules: [], packages: [{ l: 'p' }], types: [{ p: 'p', l: 'C' }], members: [], ...overrides });

test('maps real module, nested type, constructors and overloads to exact targets', async () => {
  const data = {};
  for (const kind of ['module', 'package', 'type', 'member']) {
    data[`${kind}s`] = parseSearchData(await readFile(new URL(`./fixtures/javadoc25/${kind}-search-index.js`, import.meta.url), 'utf8'), kind);
  }
  const symbols = resolveJavadocSymbols(data);
  assert.equal(symbols.length, 27);
  for (const expected of [
    { name: 'dev.crux.fixture', type: 'Module', path: 'dev.crux.fixture/module-summary.html' },
    { name: 'probe.api', type: 'Package', path: 'dev.crux.fixture/probe/api/package-summary.html' },
    { name: 'probe.api.Example.Contract', type: 'Interface', path: 'dev.crux.fixture/probe/api/Example.Contract.html' },
    { name: 'probe.api.Example.Example(String[])', type: 'Constructor', path: 'dev.crux.fixture/probe/api/Example.html#%3Cinit%3E(java.lang.String[])' },
    { name: 'probe.api.Example.copy()', type: 'Method', path: 'dev.crux.fixture/probe/api/Example.html#copy()' },
    { name: 'probe.api.Example.copy(List, int...)', type: 'Method', path: 'dev.crux.fixture/probe/api/Example.html#copy(java.util.List,int...)' },
  ]) assert.ok(symbols.some(row => JSON.stringify(row) === JSON.stringify(expected)), JSON.stringify(expected));
  assert.deepEqual(resolveJavadocSymbols({ ...data, members: [...data.members].reverse() }), symbols);
});

test('supports ordinary and unnamed packages and explicit whole-page overrides', () => {
  assert.deepEqual(resolveJavadocSymbols(input({})), [
    { name: 'p', type: 'Package', path: 'p/package-summary.html' },
    { name: 'p.C', type: 'Class', path: 'p/C.html' },
  ]);
  assert.deepEqual(resolveJavadocSymbols(input({ packages: [], types: [{ p: '<Unnamed>', l: 'C' }] })), [
    { name: 'C', type: 'Class', path: 'C.html' },
  ]);
  assert.equal(resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'C', u: 'custom/C.html' }] })).find(row => row.type === 'Class').path, 'custom/C.html');
  assert.equal(resolveJavadocSymbols(input({ packages: [{ l: 'p', u: 'custom/package.html' }] }))[0].path, 'custom/package.html');
});

test('rejects ambiguous package modules and honors an explicit module', () => {
  const data = input({ modules: [{ l: 'a' }, { l: 'b' }], packages: [{ m: 'a', l: 'p' }, { m: 'b', l: 'p' }] });
  assert.throws(() => resolveJavadocSymbols(data), /ambiguous/i);
  const symbols = resolveJavadocSymbols({ ...data, types: [{ m: 'b', p: 'p', l: 'C' }] });
  assert.equal(symbols.find(row => row.type === 'Class').path, 'b/p/C.html');
  assert.throws(() => resolveJavadocSymbols({ ...data, types: [{ m: 'unknown', p: 'p', l: 'C' }] }));
});

test('maps known kinds literally and excludes only explicit summary items', () => {
  for (const [k, type] of [[undefined, 'Class'], ['8', 'Annotation'], ['9', 'Enum'], ['10', 'Interface'], ['11', 'Struct'], ['12', 'Class'], ['13', 'Class']]) {
    assert.equal(resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'C', ...(k === undefined ? {} : { k }) }] })).find(row => row.name === 'p.C').type, type);
  }
  for (const [k, type] of [[undefined, 'Method'], ['0', 'Constant'], ['1', 'Field'], ['2', 'Field'], ['3', 'Constructor'], ['4', 'Property'], ['5', 'Method'], ['6', 'Method'], ['7', 'Property']]) {
    assert.equal(resolveJavadocSymbols(input({ members: [{ p: 'p', c: 'C', l: 'item', ...(k === undefined ? {} : { k }) }] })).find(row => row.name === 'p.C.item').type, type);
  }
  const symbols = resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'AllClasses' }, { l: 'Navigation', u: 'all.html', k: '18' }] }));
  assert.equal(symbols.some(row => row.name === 'p.AllClasses'), true);
  assert.equal(symbols.some(row => row.name === 'Navigation'), false);
  for (const k of ['0', '99', 10]) assert.throws(() => resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'C', k }] })));
  for (const k of ['12', '18', '99']) assert.throws(() => resolveJavadocSymbols(input({ members: [{ p: 'p', c: 'C', l: 'x', k }] })));
});

test('rejects unsafe paths, invalid identities and conflicting duplicates', () => {
  for (const u of ['/tmp/C.html', '//host/C.html', 'https://host/C.html', '../C.html', 'p/../C.html', 'p/./C.html', 'p\\C.html', '%2e%2e/C.html', 'p%2f../C.html', 'p/C.html?x', 'p/C.html#x', 'p/\u0000C.html', 'p/%00C.html', 'p/%252e%252e/C.html']) {
    assert.throws(() => resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'C', u }] })), u);
  }
  for (const l of ['../C', 'a/b', 'a\\b', '..', 'a\u0000b']) assert.throws(() => resolveJavadocSymbols(input({ types: [{ p: 'p', l }] })));
  assert.throws(() => resolveJavadocSymbols(input({ types: [{ p: 'p', l: 'C' }, { p: 'p', l: 'C', u: 'other.html' }] })));
  assert.throws(() => resolveJavadocSymbols(input({ members: [{ p: 'p', c: 'Missing', l: 'run()' }] })));
});

test('retains equal short signatures when qualified overload targets differ', () => {
  const symbols = resolveJavadocSymbols(input({ members: [
    { p: 'p', c: 'C', l: 'copy(Item)', u: 'copy(a.Item)' },
    { p: 'p', c: 'C', l: 'copy(Item)', u: 'copy(b.Item)' },
  ] }));
  assert.deepEqual(symbols.filter(row => row.type === 'Method').map(row => row.path), ['p/C.html#copy(a.Item)', 'p/C.html#copy(b.Item)']);
});
