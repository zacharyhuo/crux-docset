import test from 'node:test';
import assert from 'node:assert/strict';
import { readGoPage, selectGoSymbols } from '../src/go/page.js';

const options = { packagePath: 'net/http', version: '1.27.1', context: 'linux/amd64', outputPath: 'platforms/linux-amd64/net/http/index.html' };
function page(body, extra = '') {
  return `<html><head><title>http package</title></head><body>${extra}
  <nav><a data-test-id="UnitHeader-breadcrumbCurrent" href="/net/http@go1.27.1">http</a></nav>
  <span data-test-id="UnitHeader-version"><a aria-label="Version: go1.27.1" href="?tab=versions">go1.27.1</a><a href="/net/http" aria-label="Go to Latest Version">Latest</a></span>
  <main><div class="Documentation">${body}</div></main></body></html>`;
}
const header = (id, kind, decl) => `<h4 id="${id}" data-kind="${kind}">label unrelated to identity</h4><div class="Documentation-declaration"><pre>${decl}</pre></div>`;

test('indexes declarations by exact import path, symbol kind and body anchor', () => {
  const html = page(header('Client', 'type', 'type Client struct {\n<span id="Client.Timeout" data-kind="field"><span class="comment">// timeout</span></span> Timeout int\n}') +
    header('Client.Get', 'method', 'func (c *Client) Get(url string) error') +
    header('Reader', 'type', 'type Reader interface {\n<span id="Reader.Read" data-kind="method"><span class="comment">// comment</span></span>Read(p []byte) int\n}') +
    header('Println', 'function', 'func Println(v ...any)') +
    '<div class="Documentation-declaration"><pre>const (<span id="OK" data-kind="constant">OK = 1</span>)</pre></div>' +
    '<div class="Documentation-declaration"><pre>var <span id="Default" data-kind="variable">Default = 1</span></pre></div>');
  const result = readGoPage(html, options);
  assert.deepEqual(result.symbols.map(s => [s.name, s.type]), [
    ['net/http', 'Package'], ['net/http.Client', 'Struct'], ['net/http.Client.Timeout', 'Field'],
    ['net/http.Client.Get', 'Method'], ['net/http.Reader', 'Interface'], ['net/http.Reader.Read', 'Method'],
    ['net/http.Println', 'Function'], ['net/http.OK', 'Constant'], ['net/http.Default', 'Variable'],
  ]);
  assert.equal(result.symbols[3].path, 'platforms/linux-amd64/net/http/index.html#Client.Get');
});

test('generic types, Unicode identifiers and aliases keep exact targets without guessing kind', () => {
  const result = readGoPage(page(header('集合', 'type', 'type 集合[T interface{ ~[]byte }] struct {}') +
    header('Alias', 'type', 'type Alias = 集合[byte]') + header('Scalar', 'type', 'type Scalar int')), options);
  assert.deepEqual(result.symbols.slice(1).map(s => [s.name, s.type, s.path.split('#')[1]]), [
    ['net/http.集合', 'Struct', '%E9%9B%86%E5%90%88'], ['net/http.Alias', 'Type', 'Alias'], ['net/http.Scalar', 'Type', 'Scalar'],
  ]);
});

test('version/package proof is header-owned and page body must contain real declarations', () => {
  const good = page(header('Client', 'type', 'type Client struct {}'));
  for (const bad of [
    good.replace('Version: go1.27.1', 'Version: go1.26.8'),
    good.replace('/net/http@go1.27.1', '/other/http@go1.27.1'),
    good.replace('data-test-id="UnitHeader-version"', 'data-test-id="unrelated"'),
    page('<p>Loading go1.27.1</p>'), page('<script>type Client struct {}</script>'),
    good.replace('type Client struct {}', 'type Different struct {}'),
  ]) assert.throws(() => readGoPage(bad, options));
});

test('explicit rendered platform cannot silently substitute another context', () => {
  const html = page(header('Client', 'type', 'type Client struct {}'), '<div class="UnitBuildContext-titleContext"><select class="js-buildContextSelect"><option>linux/amd64</option><option selected>windows/amd64</option></select></div>');
  assert.throws(() => readGoPage(html, options), /context/i);
  assert.equal(readGoPage(html.replace(' selected', ''), options).symbols.length, 2);
  assert.throws(() => readGoPage(page(header('Client', 'type', 'type Client struct {}'), '<div class="UnitBuildContext-titleContext"><div class="UnitBuildContext-singleContext"><a>Rendered for</a> js/wasm</div></div>'), options), /context/i);
});

test('duplicate, misplaced, missing and fabricated declaration anchors are rejected', () => {
  const good = header('Client', 'type', 'type Client struct {}');
  for (const bad of [page(good, '<nav id="Client"></nav>'), page(good, '<a name="Client"></a>'),
    page(good + '<script id="Client"></script>'), page(good.replace('id="Client"', '')),
    page('<h4 id="Client" data-kind="type">Client</h4><p>No declaration</p>'),
    page('<p id="Client" data-kind="type">type Client struct {}</p>'),
    page(header('Client.Get', 'method', 'func (x *Other) Get()')),
    page('<div class="Documentation-declaration"><pre>const <span id="Wrong" data-kind="constant">Actual=1</span></pre></div>'),
  ]) assert.throws(() => readGoPage(bad, options));
});

test('unknown kinds, unsafe paths and oversize HTML fail closed', () => {
  assert.throws(() => readGoPage(page(header('Client', 'mystery', 'type Client struct {}')), options));
  assert.throws(() => readGoPage(page(header('Client', 'type', 'type Client struct {}')), { ...options, outputPath: '../escape.html' }));
  assert.throws(() => readGoPage('x'.repeat(16 * 1024 ** 2 + 1), options));
});

test('deprecated details retain type and inline method declarations', () => {
  const html = page('<details><summary><h4 id="Old" data-kind="type">deprecated</h4></summary>' +
    '<div class="Documentation-deprecatedItemBody"><div class="Documentation-declaration"><pre>type Old interface {<span id="Old.Done" data-kind="method">Done()</span>}</pre></div></div></details>');
  assert.deepEqual(readGoPage(html, options).symbols.slice(1).map(s => [s.name, s.type]), [['net/http.Old', 'Interface'], ['net/http.Old.Done', 'Method']]);
});

test('grouped field names retain every nested anchor in one declaration', () => {
  const html = page(header('Point', 'type', 'type Point struct {<span id="Point.X" data-kind="field"><span id="Point.Y" data-kind="field">X, Y int</span></span>}'));
  assert.deepEqual(readGoPage(html, options).symbols.slice(2).map(s => s.name), ['net/http.Point.X', 'net/http.Point.Y']);
  assert.throws(() => readGoPage(html.replace('id="Point.Y"', 'id="Point.Z"'), options));
});

test('inline classification must agree with const/var and owner declarations', () => {
  for (const html of [
    page('<div class="Documentation-declaration"><pre>var <span id="Value" data-kind="constant">Value = 1</span></pre></div>'),
    page(header('Owner', 'type', 'type Owner struct {<span id="Owner.Field" data-kind="method">Field int</span>}')),
    page(header('Owner', 'type', 'type Owner interface {<span id="Owner.Method" data-kind="field">Method()</span>}')),
  ]) assert.throws(() => readGoPage(html, options));
});

test('document-only packages retain overview and warnings without fabricated API symbols', () => {
  const html = page('<section class="Documentation-overview"><h3 id="pkg-overview">Overview</h3><p>Package http has no public interface on this platform.</p></section>');
  assert.deepEqual(readGoPage(html, options).symbols, [{ name: 'net/http', type: 'Package', path: options.outputPath }]);
  assert.throws(() => readGoPage(html.replace('</section>', '<div class="Documentation-declaration"><pre>func Missing()</pre></div></section>'), options));
});

test('resource and source-link inventory does not execute or fetch upstream content', () => {
  const result = readGoPage(page(header('Client', 'type', 'type Client struct {}') +
    '<img src="/static/chart.svg"><a class="Documentation-source" href="/files/sdk/std/net/http/client.go#L1">source</a>' +
    '<script>throw new Error("do not run")</script>'), options);
  assert.ok(result.resources.includes('/static/chart.svg'));
  assert.deepEqual(result.sourceLinks, ['/files/sdk/std/net/http/client.go#L1']);
});

test('cross-context index selects default symbols and labels platform-only API without dropping pages', () => {
  const linux = readGoPage(page(header('Shared', 'function', 'func Shared()')), options);
  const windows = readGoPage(page(header('Shared', 'function', 'func Shared()') + header('Windows', 'function', 'func Windows()')),
    { ...options, context: 'windows/amd64', outputPath: 'platforms/windows-amd64/net/http/index.html' });
  const result = selectGoSymbols([{ context: 'windows/amd64', ...windows }, { context: 'linux/amd64', ...linux }]);
  assert.equal(result.find(s => s.name === 'net/http.Shared').path, `${options.outputPath}#Shared`);
  assert.equal(result.find(s => s.name === 'net/http.Windows [windows/amd64]').path, 'platforms/windows-amd64/net/http/index.html#Windows');
  assert.equal(windows.symbols.length, 3);
});

test('platform-dependent representation of one symbol produces one preferred index entry', () => {
  const linux = readGoPage(page(header('Handle', 'type', 'type Handle struct {}')), options);
  const windows = readGoPage(page(header('Handle', 'type', 'type Handle uintptr')),
    { ...options, context: 'windows/amd64', outputPath: 'platforms/windows-amd64/net/http/index.html' });
  const result = selectGoSymbols([{ context: 'windows/amd64', ...windows }, { context: 'linux/amd64', ...linux }]);
  assert.equal(result.filter(s => s.name.startsWith('net/http.Handle')).length, 1);
  assert.equal(result.find(s => s.name === 'net/http.Handle').type, 'Struct');
});
