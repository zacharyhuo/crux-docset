import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { resolveGoSource, acquireGoInputs } from '../src/go/source.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const recipe = { familyId: 'go', versionLine: '1.27' };
function release(version, changes = {}) {
  return { version: `go${version}`, stable: true, files: [{
    filename: `go${version}.darwin-arm64.tar.gz`, os: 'darwin', arch: 'arm64',
    version: `go${version}`, kind: 'archive', size: 123, sha256: 'a'.repeat(64),
  }], ...changes };
}
const options = data => ({ platform: 'darwin', arch: 'arm64', fetcher: async (url, opts) => {
  assert.equal(url, 'https://go.dev/dl/?mode=json&include=all');
  assert.equal(opts.redirect, 'error');
  return Response.json(data);
} });

test('Go discovery selects highest stable patch only in the requested line and architecture', async () => {
  const latest = release('1.27.10');
  latest.files.unshift({ ...latest.files[0], arch: 'amd64', filename: 'go1.27.10.darwin-amd64.tar.gz' });
  const lock = await resolveGoSource(recipe, options([
    release('1.28.0'), release('1.27.11rc1'), release('1.27.12', { stable: false }),
    release('1.27.2'), release('1.26.8'), latest,
  ]));
  assert.equal(lock.version, '1.27.10');
  assert.deepEqual(lock.archive, {
    url: 'https://dl.google.com/go/go1.27.10.darwin-arm64.tar.gz', sha256: 'a'.repeat(64), bytes: 123,
  });
  assert.equal(lock.renderer.module, 'golang.org/x/pkgsite');
  assert.match(lock.renderer.moduleSum, /^h1:/);
  assert.ok(lock.renderer.dependencies.some(d => d.module === 'golang.org/x/tools' && d.moduleSum.startsWith('h1:')));
});

test('Go discovery refuses cross-line fallback, ambiguous metadata and malformed selected archives', async () => {
  for (const data of [[], [release('1.26.8')], [release('1.27.1'), release('1.27.1')]]) {
    await assert.rejects(resolveGoSource(recipe, options(data)));
  }
  for (const changes of [
    { sha256: 'bad' }, { size: 0 }, { size: 256 * 1024 ** 2 + 1 }, { size: 1.5 },
    { filename: '../escape.tar.gz' }, { filename: 'go1.26.8.darwin-arm64.tar.gz' },
    { version: 'go1.26.8' }, { os: 'linux' }, { kind: 'installer' },
  ]) {
    const row = release('1.27.1'); Object.assign(row.files[0], changes);
    await assert.rejects(resolveGoSource(recipe, options([row])));
  }
});

test('invalid recipe and unsupported execution platforms fail before network access', async () => {
  const fetcher = () => assert.fail('must not fetch');
  for (const bad of [{ familyId: 'python', versionLine: '1.27' }, { familyId: 'go', versionLine: 'current' }]) {
    await assert.rejects(resolveGoSource(bad, { fetcher }));
  }
  await assert.rejects(resolveGoSource(recipe, { platform: 'linux', arch: 'amd64', fetcher }));
});

test('metadata redirect, HTTP error and oversized stream are rejected', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.invalid/' } }),
    new Response('', { status: 500 }), new Response('x'.repeat(8 * 1024 ** 2 + 1))]) {
    await assert.rejects(resolveGoSource(recipe, { platform: 'darwin', arch: 'arm64', fetcher: async () => response }));
  }
});

function tarBytes(entries) {
  const blocks = [];
  for (const { name, content = '', type = 'File', linkpath = '' } of entries) {
    const data = Buffer.from(content);
    const block = Buffer.alloc(512);
    new Header({ path: name, size: data.length, type, mode: 0o755, linkpath }).encode(block);
    blocks.push(block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function sdk(entries = []) {
  return tarBytes([
    { name: 'go/VERSION', content: 'go1.27.1\ntime 2026-09-01T00:00:00Z\n' },
    { name: 'go/bin/go', content: '#!/bin/sh\necho "go version go1.27.1 darwin/arm64"\n' },
    { name: 'go/src/fmt/print.go', content: 'package fmt\n' }, ...entries,
  ]);
}
async function fixture(t, bytes = sdk()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const row = release('1.27.1'); row.files[0].sha256 = digest(bytes); row.files[0].size = bytes.length;
  const lock = await resolveGoSource(recipe, options([row]));
  const fetcher = async (url, opts) => {
    assert.equal(url, 'https://dl.google.com/go/go1.27.1.darwin-arm64.tar.gz');
    assert.equal(opts.redirect, 'error');
    return new Response(bytes);
  };
  return { lock, directory: path.join(root, 'inputs'), fetcher, root };
}

test('verified acquisition retains source/compiler provenance in a fresh directory', async t => {
  const f = await fixture(t);
  const result = await acquireGoInputs(f.lock, f);
  assert.equal(await readFile(path.join(result.goroot, 'src/fmt/print.go'), 'utf8'), 'package fmt\n');
  assert.equal(result.sourceLock.archive.sha256, f.lock.archive.sha256);
  assert.equal(result.sourceLock.compiler.version, 'go1.27.1');
  assert.equal(result.sourceLock.compiler.sha256, digest('#!/bin/sh\necho "go version go1.27.1 darwin/arm64"\n'));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'source-lock.json'), 'utf8')), result.sourceLock);
  await assert.rejects(acquireGoInputs(f.lock, f), /exist/i);
});

test('acquisition rejects hash/byte mismatch and untrusted URLs before execution', async t => {
  const f = await fixture(t);
  for (const [i, archive] of [
    { ...f.lock.archive, sha256: 'b'.repeat(64) }, { ...f.lock.archive, bytes: f.lock.archive.bytes - 1 },
    { ...f.lock.archive, url: 'https://evil.invalid/sdk.tgz' },
  ].entries()) {
    const directory = `${f.directory}-${i}`;
    await assert.rejects(acquireGoInputs({ ...f.lock, archive }, { ...f, directory }));
    await assert.rejects(access(path.join(directory, 'source-lock.json')));
  }
});

test('tar traversal, link, duplicate/case-alias and special entries cannot become SDK inputs', async t => {
  for (const entries of [
    [{ name: '../escape', content: 'bad' }], [{ name: '/absolute', content: 'bad' }],
    [{ name: 'go/../escape', content: 'bad' }], [{ name: 'other/file', content: 'bad' }],
    [{ name: 'go/symlink', type: 'SymbolicLink', linkpath: '/tmp' }],
    [{ name: 'go/hardlink', type: 'Link', linkpath: 'go/bin/go' }],
    [{ name: 'go/fifo', type: 'FIFO' }], [{ name: 'go/VERSION', content: 'go1.27.1' }],
    [{ name: 'go/version', content: 'go1.27.1' }],
  ]) {
    const f = await fixture(t, sdk(entries));
    await assert.rejects(acquireGoInputs(f.lock, f));
    await assert.rejects(access(path.join(f.root, 'escape')));
    await assert.rejects(access(path.join(f.directory, 'source-lock.json')));
  }
});

test('extraction budgets fail closed, and mismatched compiler or VERSION is not accepted', async t => {
  for (const limits of [{ maxFiles: 2 }, { maxBytes: 10 }]) {
    const f = await fixture(t);
    await assert.rejects(acquireGoInputs(f.lock, { ...f, limits }), /limit/i);
  }
  for (const [version, binary] of [
    ['go1.26.8', 'go version go1.27.1 darwin/arm64'],
    ['go1.27.1', 'go version go1.26.8 darwin/arm64'],
    ['go1.27.1', 'go version go1.27.1 linux/amd64'],
  ]) {
    const f = await fixture(t, tarBytes([
      { name: 'go/VERSION', content: version },
      { name: 'go/bin/go', content: `#!/bin/sh\necho '${binary}'\n` },
      { name: 'go/src/fmt/print.go', content: 'package fmt' },
    ]));
    await assert.rejects(acquireGoInputs(f.lock, f), /version|platform/i);
  }
});

test('archive redirects and declared/streamed oversize cannot create a verified input lock', async t => {
  for (const response of [
    new Response('', { status: 302, headers: { location: 'https://evil.invalid/go.tar.gz' } }),
    new Response('x', { headers: { 'content-length': '999999999' } }),
    new Response('x'.repeat(4096), { headers: { 'content-length': '1' } }),
  ]) {
    const f = await fixture(t);
    await assert.rejects(acquireGoInputs(f.lock, { ...f, fetcher: async () => response }));
    await assert.rejects(access(path.join(f.directory, 'source-lock.json')));
  }
});

test('tampered renderer or archive version lock is rejected without downloading', async t => {
  const f = await fixture(t);
  for (const lock of [
    { ...f.lock, renderer: { ...f.lock.renderer, moduleSum: 'h1:bad' } },
    { ...f.lock, version: '1.27.2' },
  ]) {
    await assert.rejects(acquireGoInputs(lock, { ...f, fetcher: () => assert.fail('must not download') }));
    await assert.rejects(access(f.directory));
  }
});

test('corrupt compressed data and truncated tar fail even when transport hash matches', async t => {
  for (const bytes of [Buffer.from('not gzip'), gzipSync(Buffer.from('not a tar archive'))]) {
    const f = await fixture(t, bytes);
    await assert.rejects(acquireGoInputs(f.lock, f));
    await assert.rejects(access(path.join(f.directory, 'source-lock.json')));
  }
});
