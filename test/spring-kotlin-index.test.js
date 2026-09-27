import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpringKotlinIndex } from '../src/spring/kotlin-index.js';

const row = (name, description, location = 'spring-core/org.example/item.html') => ({ name, description, location, searchKeys: [description.split('.').at(-1), name, description] });
const resolve = rows => resolveSpringKotlinIndex(JSON.stringify(rows));

test('preserves extension receiver and overload signatures sharing a page', () => {
  const result = resolve([row('fun A.get(key: String): Any', 'org.example.get'), row('fun B.get(key: Int): Any', 'org.example.get')]);
  assert.deepEqual(result, [
    { name: 'org.example.get — fun A.get(key: String): Any', type: 'Function', path: 'spring-core/org.example/item.html' },
    { name: 'org.example.get — fun B.get(key: Int): Any', type: 'Function', path: 'spring-core/org.example/item.html' },
  ]);
});

test('classifies declarations and proves enum ownership independent of row order', () => {
  const rows = [row('ON', 'org.example.Mode.ON'), row('enum Mode : Enum<Mode>', 'org.example.Mode'),
    row('abstract class Box', 'org.example.Box'), row('constructor()', 'org.example.Box.Box'),
    row('override suspend fun get(): String', 'org.example.Box.get'), row('lateinit var value: String', 'org.example.Box.value'),
    row('interface Client', 'org.example.Client'), row('object Companion', 'org.example.Box.Companion')];
  assert.deepEqual(resolve(rows).map(x => x.type), ['Class', 'Constructor', 'Class', 'Method', 'Property', 'Interface', 'Enum', 'Constant']);
  assert.deepEqual(resolve(rows), resolve(rows.toReversed()));
  assert.throws(() => resolve([row('ON', 'org.example.Mode.ON')]), /declaration|enum/i);
});

test('rejects executable wrappers, schema drift, duplicate symbols, and inconsistent search identities', () => {
  assert.throws(() => resolveSpringKotlinIndex('run([])'), /JSON/i);
  const valid = row('fun get()', 'org.example.get');
  for (const data of [null, {}, [], [{ ...valid, extra: true }], [valid, valid], [{ ...valid, searchKeys: ['get', 'fun other()', valid.description] }]]) {
    assert.throws(() => resolve(data), /invalid|empty|duplicate|schema|identity/i);
  }
});

test('rejects unsafe locations instead of manufacturing a local path', () => {
  for (const location of ['../a.html', '/a.html', 'https://host/a.html', 'a/../b.html', 'a/%2e%2e/b.html', 'a/%252e%252e/b.html', 'a%2Fb.html', 'a.html?x=1', 'a.html#x', 'a\\b.html', 'a/%00.html', 'a//b.html']) {
    assert.throws(() => resolve([row('fun get()', 'org.example.get', location)]), /path|location|encoding/i);
  }
});

test('bounds file and field sizes and rejects control or invalid identity data', () => {
  assert.throws(() => resolveSpringKotlinIndex(' '.repeat(8 * 1024 * 1024 + 1)), /limit/i);
  for (const value of ['x'.repeat(8193), 'fun get()\u0000']) assert.throws(() => resolve([row(value, 'org.example.get')]), /field|limit/i);
  assert.throws(() => resolve([row('fun get()', 'org..get')]), /identity/i);
});
