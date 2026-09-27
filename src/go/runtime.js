import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '../identity.js';
import { GO_CONTEXTS } from './inventory.js';

const execute = promisify(execFile);
const sandbox = fileURLToPath(new URL('./loopback-only.sb', import.meta.url));

async function boundedCommand(command, args, { cwd, env, timeoutMs }) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', fatal, force;
  const stop = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const fail = error => {
    if (fatal) return;
    fatal = error; stop('SIGTERM'); force = setTimeout(() => stop('SIGKILL'), 2000);
  };
  child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 4 * 1024 ** 2) fail(new Error('Go command output limit')); });
  child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 4 * 1024 ** 2) fail(new Error('Go command output limit')); });
  const timer = setTimeout(() => fail(new Error('Go build timeout')), timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (fatal) throw fatal;
    if (code !== 0) throw new Error(`Go command failed (${code}): ${stderr}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); clearTimeout(force); }
}

export async function buildPkgsite(inputs, { work, timeoutMs = 600000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000 || !path.isAbsolute(work)) throw new Error('Invalid Go build budget/directory');
  const compiler = path.join(inputs.goroot, 'bin/go');
  if (!(await lstat(compiler)).isFile() || await sha256(compiler) !== inputs.sourceLock.compiler.sha256) throw new Error('Go compiler hash mismatch');
  await mkdir(work, { mode: 0o700 });
  for (const dir of ['home', 'tmp', 'bin', 'build-cache', 'gopath']) await mkdir(path.join(work, dir));
  const env = goEnvironment(inputs.goroot, work, { downloads: true }), start = performance.now();
  const remaining = () => {
    const ms = Math.floor(timeoutMs - (performance.now() - start));
    if (ms <= 0) throw new Error('Go build timeout');
    return ms;
  };
  const renderer = inputs.sourceLock.renderer;
  const fetched = await boundedCommand(compiler, ['mod', 'download', '-json', `${renderer.module}@${renderer.version}`], { cwd: work, env, timeoutMs: remaining() });
  const module = JSON.parse(fetched.stdout);
  if (module.Error || module.Path !== renderer.module || module.Version !== renderer.version || module.Sum !== renderer.moduleSum ||
      module.GoModSum !== renderer.goModSum || module.Origin?.Hash !== renderer.commit) throw new Error('Downloaded renderer module lock mismatch');
  await writeFile(path.join(work, 'module.json'), fetched.stdout, { flag: 'wx' });
  const built = await boundedCommand(compiler, ['install', '-p=2', `${renderer.module}/cmd/pkgsite@${renderer.version}`], { cwd: work, env, timeoutMs: remaining() });
  await writeFile(path.join(work, 'build.log'), built.stdout + built.stderr, { flag: 'wx' });
  const binary = path.join(work, 'bin/pkgsite');
  const metadata = await boundedCommand(compiler, ['version', '-m', binary], { cwd: work, env: goEnvironment(inputs.goroot, work), timeoutMs: remaining() });
  const evidence = verifyPkgsiteBuildInfo(metadata.stdout, inputs.sourceLock);
  const pkgsite = { binary, sha256: await sha256(binary), ...evidence };
  await writeFile(path.join(work, 'renderer-lock.json'), JSON.stringify(pkgsite, null, 2), { flag: 'wx' });
  return { ...inputs, pkgsite };
}

export function goEnvironment(goroot, work, { downloads = false } = {}) {
  return { PATH: `${goroot}/bin:/usr/bin:/bin`, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
    LANG: 'C', GOROOT: goroot, GOPATH: path.join(work, 'gopath'), GOCACHE: path.join(work, 'build-cache'),
    GOBIN: path.join(work, 'bin'), GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOMAXPROCS: '2',
    GOPROXY: downloads ? 'https://proxy.golang.org' : 'off', GOSUMDB: downloads ? 'sum.golang.org' : 'off',
    GOVCS: '*:off', ...(downloads ? {} : { GOPRIVATE: '*', GONOPROXY: 'none' }) };
}

export function verifyPkgsiteBuildInfo(text, lock) {
  const lines = text.trimEnd().split('\n');
  if (!lines.shift()?.endsWith(`: go${lock.version}`)) throw new Error('pkgsite compiler version mismatch');
  const deps = [], mods = [], paths = [];
  for (const line of lines) {
    const [kind, ...values] = line.trim().split('\t');
    if (kind === '=>') throw new Error('pkgsite local dependency replacement forbidden');
    if (kind === 'path') paths.push(values[0]);
    if (kind === 'mod') mods.push(values);
    if (kind === 'dep') deps.push({ module: values[0], version: values[1], moduleSum: values[2] });
  }
  const expected = lock.renderer;
  if (JSON.stringify(paths) !== JSON.stringify([`${expected.module}/cmd/pkgsite`]) ||
      JSON.stringify(mods) !== JSON.stringify([[expected.module, expected.version, expected.moduleSum]])) throw new Error('pkgsite module lock mismatch');
  const order = values => [...values].sort((a, b) => a.module.localeCompare(b.module));
  if (JSON.stringify(order(deps)) !== JSON.stringify(order(expected.dependencies))) throw new Error('pkgsite dependency lock mismatch');
  return { compiler: `go${lock.version}`, dependencies: order(deps) };
}

export async function verifyLoopbackSandbox() {
  if (process.platform !== 'darwin') throw new Error('Verified network sandbox unavailable on this platform');
  const code = `const net=require('node:net'),http=require('node:http');
const server=http.createServer((req,res)=>res.end('loopback-proof'));
server.listen(0,'127.0.0.1',async()=>{
 try {
  const response=await fetch('http://127.0.0.1:'+server.address().port);
  if(await response.text()!=='loopback-proof')throw new Error('loopback failed');
  server.closeAllConnections();server.close();
  const external=net.connect(443,'1.1.1.1');
  external.on('connect',()=>{console.error('external socket allowed');process.exit(2)});
  external.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(3);console.log(JSON.stringify({loopback:true,external:e.code}))});
 } catch(e) { console.error(e);process.exit(4) }
});`;
  const { stdout } = await execute('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, '-e', code], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000, maxBuffer: 4096,
  });
  return JSON.parse(stdout);
}

async function allocatePort(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port');
  const reservation = createServer();
  reservation.listen(port, '127.0.0.1');
  await once(reservation, 'listening');
  const selected = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return selected;
}

function checkRoute(route, version) {
  if (typeof route !== 'string' || route.length > 4096 || !route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x20#]/.test(route)) throw new Error('Invalid local pkgsite route');
  const url = new URL(route, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1' || `${url.pathname}${url.search}` !== route || /%|\/\.\.?\//.test(url.pathname)) throw new Error('Noncanonical pkgsite route');
  for (const key of url.searchParams.keys()) if (!['GOOS', 'GOARCH'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Unknown pkgsite route query');
  if (url.search && !GO_CONTEXTS.includes(`${url.searchParams.get('GOOS')}/${url.searchParams.get('GOARCH')}`)) throw new Error('Unknown Go context');
  if (url.pathname.includes('@') && !url.pathname.endsWith(`@go${version}`)) throw new Error('Wrong Go route version');
}

export async function withPkgsite(inputs, options, consume) {
  const { work, startupTimeoutMs = 120000, requestTimeoutMs = 60000, timeoutMs = 1200000,
    maxPageBytes = 16 * 1024 ** 2, maxTotalBytes = 1024 ** 3 } = options;
  for (const [value, maximum] of [[startupTimeoutMs, 120000], [requestTimeoutMs, 60000], [timeoutMs, 1200000], [maxPageBytes, 16 * 1024 ** 2], [maxTotalBytes, 1024 ** 3]]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('Invalid pkgsite runtime limit');
  }
  if (!path.isAbsolute(work) || !path.isAbsolute(inputs.goroot) || !path.isAbsolute(inputs.pkgsite.binary) || !/^1\.\d+\.\d+$/.test(inputs.sourceLock.version)) throw new Error('Invalid pkgsite inputs');
  if (!(await lstat(inputs.pkgsite.binary)).isFile() || await sha256(inputs.pkgsite.binary) !== inputs.pkgsite.sha256) throw new Error('pkgsite binary hash mismatch');
  await verifyLoopbackSandbox();
  const port = await allocatePort(options.port), baseURL = `http://127.0.0.1:${port}`;
  await mkdir(work, { mode: 0o700 });
  for (const dir of ['home', 'tmp', 'fixture', 'build-cache']) await mkdir(path.join(work, dir));
  await writeFile(path.join(work, 'fixture/go.mod'), 'module crux.invalid/offline-fixture\n\ngo 1.26.0\n', { flag: 'wx' });
  const child = spawn('/usr/bin/sandbox-exec', ['-f', sandbox, inputs.pkgsite.binary,
    `-http=127.0.0.1:${port}`, `-gorepo=${inputs.goroot}`, '-list=false', '-proxy=false', '-cache=false', '-open=false', '-dev=false', path.join(work, 'fixture')],
  { cwd: work, env: goEnvironment(inputs.goroot, work), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let exited = false, terminating = false, fatal, logs = '', active = 0, total = 0;
  const controller = new AbortController();
  const completion = new Promise(resolve => {
    child.on('error', error => { fatal = error; exited = true; resolve(); });
    child.on('close', () => { exited = true; resolve(); });
  });
  const stop = signal => {
    if (exited || (signal === 'SIGTERM' && terminating)) return;
    if (signal === 'SIGTERM') terminating = true;
    if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const record = chunk => {
    if (Buffer.byteLength(logs) + chunk.length > 1024 ** 2) { fatal = new Error('pkgsite log limit exceeded'); stop('SIGTERM'); return; }
    logs += chunk.toString();
    if (logs.includes('loading packages from stdlib:')) { fatal = new Error('Local stdlib failed; remote fallback forbidden'); stop('SIGTERM'); }
  };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const deadline = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  // Attach a handler immediately; consumer/startup may still be pending on expiration.
  deadline.catch(() => {});
  const timer = setTimeout(() => { controller.abort(new Error('pkgsite runtime deadline exceeded')); stop('SIGTERM'); }, timeoutMs);
  const pending = new Set();
  const readPage = route => {
    const job = (async () => {
      checkRoute(route, inputs.sourceLock.version);
      if (fatal || exited || controller.signal.aborted) throw fatal ?? new Error('pkgsite session is closed');
      if (active >= 2) throw new Error('pkgsite request concurrency limit exceeded');
      active++;
      try {
        // Curl runs under the same network restriction as the server; no proxy,
        // redirect following, cookie jar, user config or external subresource fetch.
        const { stdout } = await execute('/usr/bin/sandbox-exec', ['-f', sandbox, '/usr/bin/curl', '-q',
          '--noproxy', '*', '--proto', '=http', '--silent', '--show-error', '--fail',
          '--max-time', String(requestTimeoutMs / 1000), '--max-filesize', String(maxPageBytes),
          '--write-out', '\n%{http_code}', `${baseURL}${route}`], {
          env: goEnvironment(inputs.goroot, work), cwd: work, encoding: 'buffer', maxBuffer: maxPageBytes + 4,
          timeout: requestTimeoutMs + 1000, signal: controller.signal,
        });
        const body = stdout.subarray(0, -4);
        if (stdout.subarray(-4).toString() !== '\n200') throw new Error('pkgsite HTTP response is not 200');
        total += body.length;
        if (body.length > maxPageBytes || total > maxTotalBytes) throw new Error('pkgsite response size limit exceeded');
        if (fatal || exited) throw fatal ?? new Error('pkgsite exited during request');
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
      } finally { active--; }
    })();
    pending.add(job); job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  };
  try {
    const start = performance.now();
    while (!logs.includes(`Listening on addr ${baseURL}`)) {
      if (fatal || exited) throw fatal ?? new Error('pkgsite exited before readiness');
      if (performance.now() - start >= startupTimeoutMs || controller.signal.aborted) throw new Error('pkgsite startup timeout');
      await delay(25);
    }
    if (fatal || exited) throw fatal ?? new Error('pkgsite exited before readiness');
    return await Promise.race([consume({ baseURL, version: inputs.sourceLock.version, contexts: GO_CONTEXTS, readPage }), deadline]);
  } finally {
    clearTimeout(timer); controller.abort(new Error('pkgsite session closed')); stop('SIGTERM');
    const force = setTimeout(() => stop('SIGKILL'), 2000);
    await completion; clearTimeout(force);
    await Promise.allSettled([...pending]);
    await writeFile(path.join(work, 'server.log'), logs, { flag: 'wx' });
  }
}
