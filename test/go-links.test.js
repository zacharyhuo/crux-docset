import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoLinkResolver } from '../src/go/links.js';

const entry = (packagePath, context = 'linux/amd64') => ({ packagePath, context,
  outputPath: `platforms/${context.replace('/', '-')}/${packagePath}/index.html` });
const pages = [entry('fmt'), entry('net/http'), entry('net/http', 'windows/amd64'), entry('syscall/js', 'js/wasm')];
const anchors = new Map(pages.map(p => [p.outputPath, new Set(['pkg-overview', ...(p.packagePath === 'fmt' ? ['Println'] : p.packagePath === 'syscall/js' ? ['Value'] : ['Client'])])]));
function resolve() { return createGoLinkResolver({ pages }, { version: '1.27.1', goroot: '/verified/sdk/go', anchors }); }

test('local package/context/fragment routes point to exact offline pages', () => {
  const links = resolve();
  assert.equal(links('/fmt#Println', pages[1]).href, '../../fmt/index.html#Println');
  assert.equal(links('/net/http?GOOS=windows#Client', pages[0]).href, '../../windows-amd64/net/http/index.html#Client');
  assert.equal(links('#Client', pages[1]).href, '#Client');
  assert.equal(links('', pages[1]).href, 'index.html');
  const js = links('/syscall/js#Value', pages[0]);
  assert.equal(js.href, '../../js-wasm/syscall/js/index.html#Value');
  assert.equal(js.context, 'js/wasm'); assert.equal(js.platformFallback, true);
});

test('hosted current standard-library links become offline, other versions remain explicit online', () => {
  const links = resolve();
  assert.equal(links('https://pkg.go.dev/fmt@go1.27.1#Println', pages[1]).href, '../../fmt/index.html#Println');
  assert.equal(links('https://go.dev/pkg/fmt/#Println', pages[1]).href, '../../fmt/index.html#Println');
  assert.equal(links('https://pkg.go.dev/fmt@go1.26.8#Println', pages[1]).kind, 'online');
  assert.equal(links('/golang.org/x/net/html#Parse', pages[0]).href, 'https://pkg.go.dev/golang.org/x/net/html#Parse');
  assert.equal(links('/cmd/go', pages[0]).kind, 'online');
});

test('missing in-scope pages and fragments fail, never degrade to online links', () => {
  const links = resolve();
  assert.throws(() => links('/fmt#Absent', pages[1]), /anchor/i);
  assert.throws(() => links('/net/http/missing', pages[0]), /missing|scope/i);
  assert.throws(() => links('/net/http?GOOS=linux&GOARCH=arm64#Client', pages[0]), /context/i);
});

test('source URLs use only known GOROOT and exact upstream tag', () => {
  const links = resolve();
  assert.deepEqual(links('/files/verified/sdk/go/std/fmt/print.go#L306', pages[0]), {
    kind: 'online', href: 'https://github.com/golang/go/blob/go1.27.1/src/fmt/print.go#L306', reason: 'source',
  });
  assert.throws(() => links('/files/private/user/secret.go#L1', pages[0]));
  assert.throws(() => links('/files/verified/sdk/go/std/../secret#L1', pages[0]));
});

test('namespace navigation is local and unsafe URLs never survive', () => {
  const links = resolve();
  assert.equal(links('/net', pages[0]).href, '../../../index.html#package-group-net');
  for (const href of ['javascript:alert(1)', 'data:text/html,evil', 'file:///tmp/a', '//evil.invalid/', '/../fmt', '/%2e%2e/fmt', '/fmt?GOOS=linux&GOOS=windows', 'https://user:password@pkg.go.dev/fmt']) {
    assert.throws(() => links(href, pages[0]), href);
  }
});

test('known literal example addresses remain text instead of connecting to local services', () => {
  const links = resolve();
  assert.equal(links('http://address:port', pages[0]).kind, 'literal');
  assert.equal(links('http://localhost:6060/debug/pprof/', pages[0]).kind, 'literal');
  assert.throws(() => links('http://other:bad-port', pages[0]));
});

test('reviewed upstream defects remain explicit text, bounded by source page and exact release', () => {
  const source = entry('database/sql/driver'), sql = entry('database/sql');
  const set = [source, sql];
  const ids = new Map(set.map(p => [p.outputPath, new Set(['DB.Query'])]));
  const options = { version: '1.27.1', goroot: '/verified/sdk/go', anchors: ids };
  const links = createGoLinkResolver({ pages: set }, options);
  const result = links('/database/sql?GOOS=linux#Query', source);
  assert.equal(result.kind, 'literal');
  assert.equal(result.reason, 'upstream-broken-reference');
  assert.match(result.evidence, /types\.go#L40/);
  assert.throws(() => links('/database/sql#Query', sql), /anchor/);
  assert.throws(() => links('/database/sql?GOOS=linux#Unexpected', source), /anchor/);
  assert.throws(() => links('/database/sql?GOOS=plan9#Query', source), /context/);
  assert.throws(() => createGoLinkResolver({ pages: set }, { ...options, version: '1.27.2' })('/database/sql#Query', source), /anchor/);
});

test('reviewed Plan 9 reference links to exact official source rather than a nonexistent local symbol', () => {
  const source = entry('os'), syscall = entry('syscall');
  const links = createGoLinkResolver({ pages: [source, syscall] }, {
    version: '1.27.1', goroot: '/verified/sdk/go', anchors: new Map([source, syscall].map(p => [p.outputPath, new Set()])),
  });
  assert.deepEqual(links('/syscall?GOOS=linux#EPLAN9', source), {
    kind: 'online', reason: 'out-of-scope-platform',
    href: 'https://github.com/golang/go/blob/go1.27.1/src/syscall/errors_plan9.go#L41',
  });
  assert.throws(() => links('/syscall#EPLAN9', syscall), /anchor/);
});

test('previous-line audited source references use their own version and source line', () => {
  const source = entry('database/sql/driver'), sql = entry('database/sql');
  const options = { version: '1.26.8', goroot: '/verified/sdk/go', anchors: new Map([source, sql].map(p => [p.outputPath, new Set()])) };
  const links = createGoLinkResolver({ pages: [source, sql] }, options);
  const result = links('/database/sql?GOOS=linux#Query', source);
  assert.equal(result.kind, 'literal');
  assert.equal(result.evidence, 'https://github.com/golang/go/blob/go1.26.8/src/database/sql/driver/types.go#L39');
  assert.throws(() => createGoLinkResolver({ pages: [source, sql] }, { ...options, version: '1.26.9' })('/database/sql#Query', source), /anchor/);
});

test('old jsonv2-only APIs are explicit source references, not mislabeled as missing stable APIs', () => {
  const source = entry('encoding/json/v2'), target = entry('encoding/json'), time = entry('time');
  const links = createGoLinkResolver({ pages: [source, target, time] }, {
    version: '1.26.8', goroot: '/verified/sdk/go', anchors: new Map([source, target, time].map(p => [p.outputPath, new Set()])),
  });
  const result = links('/encoding/json#Options', source);
  assert.equal(result.kind, 'online');
  assert.equal(result.reason, 'out-of-scope-build-tag');
  assert.equal(result.requirement, 'GOEXPERIMENT=jsonv2');
  assert.equal(result.href, 'https://github.com/golang/go/blob/go1.26.8/src/encoding/json/v2_options.go#L203');
  assert.equal(links('/encoding/json#DefaultOptionsV1', source).href, 'https://github.com/golang/go/blob/go1.26.8/src/encoding/json/v2_options.go#L237');
  assert.equal(links('/time#Time.Parse', source).reason, 'upstream-broken-reference');
  assert.throws(() => links('/encoding/json#Unexpected', source), /anchor/);
  assert.equal(links('http://ipaddr:port', source).kind, 'literal');
});
