import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGoInventory, readGoDirectory } from '../src/go/inventory.js';

const contexts = ['linux/amd64', 'windows/amd64', 'darwin/amd64', 'js/wasm'];
const base = () => ['builtin', 'unsafe', 'fmt'].flatMap(packagePath => contexts.map(context => ({ packagePath, context, files: ['doc_fipsv1.26.go'], experimental: false })));
const sourcePackages = () => [...base(), { packagePath: 'syscall/js', context: 'js/wasm', files: ['js.go'], experimental: false },
  { packagePath: 'syscall', context: 'windows/amd64', files: ['syscall_windows.go'], experimental: false },
  { packagePath: 'encoding/json/v2', context: 'linux/amd64', files: ['doc.go'], experimental: true }];
const renderedPackages = ['builtin', 'unsafe', 'fmt', 'syscall', 'syscall/js', 'encoding', 'encoding/json', 'encoding/json/v2', 'internal/abi', 'cmd/go', 'crypto/md5/_asm'];

test('Go inventory preserves platform-only packages and unique deterministic output routes', () => {
  const result = makeGoInventory({ version: '1.27.1', sourcePackages: sourcePackages(), renderedPackages, contexts });
  assert.equal(result.pages.length, 15);
  assert.equal(new Set(result.pages.map(p => p.outputPath)).size, 15);
  const js = result.pages.find(p => p.packagePath === 'syscall/js');
  assert.deepEqual(js, { packagePath: 'syscall/js', context: 'js/wasm', experimental: false,
    route: '/syscall/js@go1.27.1?GOOS=js&GOARCH=wasm', outputPath: 'platforms/js-wasm/syscall/js/index.html' });
  assert.equal(result.pages.find(p => p.packagePath === 'encoding/json/v2').experimental, true);
  assert.ok(result.excluded.some(p => p.packagePath === 'internal/abi' && p.reason === 'internal'));
  assert.ok(result.excluded.some(p => p.packagePath === 'crypto/md5/_asm' && p.reason === 'hidden'));
  assert.ok(result.excluded.some(p => p.packagePath === 'encoding' && p.reason === 'namespace'));
  assert.deepEqual(result, makeGoInventory({ version: '1.27.1', sourcePackages: sourcePackages().reverse(), renderedPackages: [...renderedPackages].reverse(), contexts }));
});

test('missing and unexpected public packages stop export rather than lowering counts', () => {
  for (const rendered of [renderedPackages.filter(p => p !== 'syscall/js'), [...renderedPackages, 'unexpected']]) {
    assert.throws(() => makeGoInventory({ version: '1.27.1', sourcePackages: sourcePackages(), renderedPackages: rendered, contexts }), /coverage/i);
  }
  assert.throws(() => makeGoInventory({ version: '1.27.1', sourcePackages: base().filter(p => p.packagePath !== 'builtin'), renderedPackages: ['unsafe', 'fmt'], contexts }), /builtin/);
});

test('unknown contexts, duplicates, unsafe identities and empty source packages fail', () => {
  for (const row of [
    { packagePath: 'fmt', context: 'linux/arm64', files: ['doc.go'], experimental: false },
    { packagePath: '../escape', context: 'linux/amd64', files: ['doc.go'], experimental: false },
    { packagePath: 'foo', context: 'linux/amd64', files: [], experimental: false },
    base()[0],
  ]) assert.throws(() => makeGoInventory({ version: '1.27.1', sourcePackages: [...base(), row], renderedPackages: ['builtin', 'unsafe', 'fmt'], contexts }));
  assert.throws(() => makeGoInventory({ version: '1.27.1', sourcePackages: base(), renderedPackages, contexts: ['linux/arm64'] }));
});

test('renderer directory parsing requires exact version and only directory-owned links', () => {
  const html = `<a aria-label="Version: go1.27.1">go1.27.1</a><nav><a href="/fake@go1.27.1">fake</a></nav>
  <table class="UnitDirectories-table"><tr><td><a href="/fmt@go1.27.1">fmt</a></td></tr>
  <tr><td><a href="/net/http@go1.27.1">http</a></td></tr>
  <tr><td><a href="/crypto/internal/entropy/v1.0.0@go1.27.1">v1.0.0</a></td></tr></table>`;
  assert.deepEqual(readGoDirectory(html, { version: '1.27.1' }), ['crypto/internal/entropy/v1.0.0', 'fmt', 'net/http']);
  for (const bad of [html.replaceAll('go1.27.1', 'go1.26.8'), html.replace('/fmt@go1.27.1', 'https://evil.invalid/fmt'), '<p>Loading go1.27.1</p>']) {
    assert.throws(() => readGoDirectory(bad, { version: '1.27.1' }));
  }
});
