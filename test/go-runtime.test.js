import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/identity.js';
import { buildPkgsite, goEnvironment, withPkgsite, verifyPkgsiteBuildInfo, verifyLoopbackSandbox } from '../src/go/runtime.js';
import renderer from '../tools/pkgsite/toolchain-lock.json' with { type: 'json' };

test('Go environment never inherits host credentials, proxy or version-changing options', () => {
  const old = process.env.GOFLAGS; process.env.GOFLAGS = '-tags=anything';
  try {
    const env = goEnvironment('/verified/go', '/private/work', { downloads: false });
    assert.equal(env.GOTOOLCHAIN, 'local'); assert.equal(env.GOPROXY, 'off');
    assert.equal(env.GOFLAGS, undefined); assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.HOME, '/private/work/home'); assert.equal(env.GOROOT, '/verified/go');
    assert.equal(env.PATH, '/verified/go/bin:/usr/bin:/bin');
    assert.equal(goEnvironment('/verified/go', '/private/work', { downloads: true }).GOSUMDB, 'sum.golang.org');
  } finally { if (old === undefined) delete process.env.GOFLAGS; else process.env.GOFLAGS = old; }
});

function buildInfo() {
  return `bin/pkgsite: go1.27.1\n\tpath\tgolang.org/x/pkgsite/cmd/pkgsite\n\tmod\t${renderer.module}\t${renderer.version}\t${renderer.moduleSum}\n` +
    renderer.dependencies.map(d => `\tdep\t${d.module}\t${d.version}\t${d.moduleSum}\n`).join('');
}
test('renderer build metadata must match compiler and complete locked dependency set', () => {
  assert.equal(verifyPkgsiteBuildInfo(buildInfo(), { version: '1.27.1', renderer }).dependencies.length, 8);
  for (const changed of [buildInfo().replace('go1.27.1', 'go1.26.8'), buildInfo().replace(renderer.moduleSum, 'h1:bad'),
    buildInfo().replace(/\tdep\t[^\n]+\n/, ''), buildInfo() + '\tdep\tevil.invalid/module\tv1.0.0\th1:bad\n',
    buildInfo() + '\t=>\t/tmp/override\n']) {
    assert.throws(() => verifyPkgsiteBuildInfo(changed, { version: '1.27.1', renderer }));
  }
});

async function fixture(t, mode = 'ok') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'pkgsite');
  // Protocol fixture is an actual child server. It uses the same flags/log boundary
  // as pkgsite, allowing real cleanup, conflicts and sandbox behavior assertions.
  const code = `#!${process.execPath}
import http from 'node:http';
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(path.join(root, 'pid'))}, String(process.pid));
const mode=${JSON.stringify(mode)};
if(mode==='startup-exit') process.exit(2);
if(mode==='startup-stall') { setInterval(()=>{},1000); }
else {
 const address=process.argv.find(a=>a.startsWith('-http=')).slice(6);
 const server=http.createServer((req,res)=>{
   if(req.url==='/slow') return;
   if(req.url==='/redirect') {res.writeHead(302,{Location:'http://1.1.1.1/'});res.end();return;}
   if(req.url==='/oversize') {res.end('x'.repeat(2048));return;}
   res.end('<main>local fixture</main>');
 });
 server.on('error',()=>process.exit(3));
 server.listen(Number(address.split(':')[1]),'127.0.0.1',()=>{
  if(mode==='fallback') console.error('loading packages from stdlib: fixture failure');
  console.error('Listening on addr http://'+address);
 });
}
`;
  // .mjs dependency-free executable; package.json selects ESM for extensionless entry.
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(binary, code, { mode: 0o755 });
  const goroot = path.join(root, 'sdk'); await mkdir(goroot);
  return { root, inputs: { goroot, sourceLock: { version: '1.27.1', renderer }, pkgsite: { binary, sha256: await sha256(binary) } },
    options: { work: path.join(root, 'runtime'), startupTimeoutMs: 1500, requestTimeoutMs: 500, timeoutMs: 5000 } };
}
async function assertGone(root) {
  const pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('macOS runtime sandbox permits loopback and denies external sockets', { skip: process.platform !== 'darwin' }, async () => {
  assert.deepEqual(await verifyLoopbackSandbox(), { loopback: true, external: 'EPERM' });
});

test('owned service and isolated collector work then exit after consume throws', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  await assert.rejects(withPkgsite(f.inputs, f.options, async session => {
    assert.equal(await session.readPage('/fmt@go1.27.1?GOOS=linux&GOARCH=amd64'), '<main>local fixture</main>');
    await assert.rejects(session.readPage('http://evil.invalid/'));
    await assert.rejects(session.readPage('//evil.invalid/'));
    await assert.rejects(session.readPage('/fmt@go1.27.1?GOOS=linux&GOARCH=arm64'));
    throw new Error('consumer failed');
  }), /consumer failed/);
  await assertGone(f.root);
});

test('startup failure, timeout and local-stdlib fallback terminate owned service', { skip: process.platform !== 'darwin' }, async t => {
  for (const mode of ['startup-exit', 'startup-stall', 'fallback']) {
    const f = await fixture(t, mode);
    await assert.rejects(withPkgsite(f.inputs, { ...f.options, startupTimeoutMs: 350 }, () => assert.fail('not ready')));
    await assertGone(f.root);
  }
});

test('port conflict does not fetch from an unrelated service', { skip: process.platform !== 'darwin' }, async t => {
  let requests = 0;
  const other = createServer((_, res) => { requests++; res.end('not ours'); });
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  const f = await fixture(t);
  await assert.rejects(withPkgsite(f.inputs, { ...f.options, port: other.address().port }, () => assert.fail('must not consume')));
  assert.equal(requests, 0);
});

test('request size, timeout and redirect gates reject before returning a page', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  await withPkgsite(f.inputs, { ...f.options, maxPageBytes: 1024 }, async session => {
    for (const route of ['/oversize', '/slow', '/redirect']) await assert.rejects(session.readPage(route));
  });
  await assertGone(f.root);
});

test('renderer build rejects changed compiler and wrong downloaded module before install', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  const binary = path.join(root, 'bin/go');
  await writeFile(binary, `#!${process.execPath}\nif(process.argv[2]!=='mod')throw new Error('must not install');console.log(JSON.stringify({Path:'golang.org/x/pkgsite',Version:'wrong',Sum:'h1:bad'}));`, { mode: 0o755 });
  const inputs = { goroot: root, sourceLock: { version: '1.27.1', renderer, compiler: { sha256: '0'.repeat(64) } } };
  await assert.rejects(buildPkgsite(inputs, { work: path.join(root, 'bad-hash') }), /compiler.*hash/i);
  inputs.sourceLock.compiler.sha256 = await sha256(binary);
  await assert.rejects(buildPkgsite(inputs, { work: path.join(root, 'bad-module') }), /module.*lock/i);
});

test('overall deadline terminates even a consumer that never returns', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  await assert.rejects(withPkgsite(f.inputs, { ...f.options, timeoutMs: 500 }, () => new Promise(() => {})), /deadline/);
  await assertGone(f.root);
});

test('timed-out renderer build waits for its owned compiler to exit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crux-go-build-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  const binary = path.join(root, 'bin/go');
  await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'pid'))},String(process.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  const inputs = { goroot: root, sourceLock: { version: '1.27.1', renderer, compiler: { sha256: await sha256(binary) } } };
  await assert.rejects(buildPkgsite(inputs, { work: path.join(root, 'build'), timeoutMs: 500 }), /timeout/);
  await assertGone(root);
});
