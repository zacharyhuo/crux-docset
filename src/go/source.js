import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import * as tar from 'tar';
import { sha256, SHA256 } from '../identity.js';
import renderer from '../../tools/pkgsite/toolchain-lock.json' with { type: 'json' };

const execute = promisify(execFile);
const metadataURL = 'https://go.dev/dl/?mode=json&include=all';
const archiveLimit = 256 * 1024 ** 2;
const extractionLimit = 2 * 1024 ** 3;
const fileLimit = 100000;
const stable = /^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function executionPlatform(platform, arch) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Unverified Go execution platform; only darwin/arm64 is enabled');
}

function officialURL(value, kind) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      (kind === 'metadata' ? value !== metadataURL :
        url.hostname !== 'dl.google.com' || url.search || !/^\/go\/go1\.\d+\.\d+\.darwin-arm64\.tar\.gz$/.test(url.pathname))) {
    throw new Error('Go source must use an approved official HTTPS URL');
  }
}

async function responseFor(url, kind, maxBytes, fetcher) {
  officialURL(url, kind);
  // No redirect, including same-host redirects: source identity is the requested URL.
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok || response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
    await response.body?.cancel();
    throw new Error(`Go source HTTP/redirect rejected: ${response.status}`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error('Go download size limit exceeded');
  }
  if (!response.body) throw new Error('Go source response has no body');
  return response;
}

export async function resolveGoSource(recipe, { platform = process.platform, arch = process.arch, fetcher = fetch } = {}) {
  if (recipe?.familyId !== 'go' || !/^1\.(0|[1-9]\d*)$/.test(recipe.versionLine)) throw new Error('Invalid Go recipe/version line');
  executionPlatform(platform, arch);
  const response = await responseFor(metadataURL, 'metadata', 8 * 1024 ** 2, fetcher);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    if ((bytes += chunk.length) > 8 * 1024 ** 2) throw new Error('Go metadata size limit exceeded');
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!Array.isArray(data)) throw new Error('Invalid Go release metadata');
  const candidates = data.filter(row => row?.stable === true && typeof row.version === 'string' &&
    row.version.startsWith('go') && stable.test(row.version.slice(2)) && row.version.slice(2).startsWith(`${recipe.versionLine}.`));
  const versions = new Set();
  for (const row of candidates) {
    if (versions.has(row.version) || !row.version.slice(2).split('.').every(n => Number.isSafeInteger(Number(n)))) throw new Error('Ambiguous Go release metadata');
    versions.add(row.version);
  }
  candidates.sort((a, b) => Number(b.version.split('.')[2]) - Number(a.version.split('.')[2]));
  const selected = candidates[0];
  if (!selected) throw new Error(`No stable Go release in version line ${recipe.versionLine}`);
  const files = selected.files?.filter(f => f.os === platform && f.arch === arch && f.kind === 'archive');
  if (files?.length !== 1) throw new Error('Missing or ambiguous Go SDK archive');
  const file = files[0];
  if (file.version !== selected.version || file.filename !== `${selected.version}.${platform}-${arch}.tar.gz` ||
      !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > archiveLimit) {
    throw new Error('Invalid Go SDK archive metadata');
  }
  return {
    schemaVersion: 1, version: selected.version.slice(2), versionLine: recipe.versionLine, platform, arch,
    archive: { url: `https://dl.google.com/go/${file.filename}`, sha256: file.sha256, bytes: file.size },
    renderer: structuredClone(renderer),
  };
}

function bound(maximum) {
  let bytes = 0;
  return new Transform({ transform(chunk, _, callback) {
    bytes += chunk.length;
    callback(bytes > maximum ? new Error('Go input size limit exceeded') : null, chunk);
  } });
}

function validateLock(lock) {
  executionPlatform(lock.platform, lock.arch);
  if (lock.schemaVersion !== 1 || !stable.test(lock.version) || lock.version.split('.').slice(0, 2).join('.') !== lock.versionLine ||
      !SHA256.test(lock.archive?.sha256) || !Number.isSafeInteger(lock.archive?.bytes) || lock.archive.bytes <= 0 || lock.archive.bytes > archiveLimit ||
      JSON.stringify(lock.renderer) !== JSON.stringify(renderer)) throw new Error('Invalid Go source lock');
  officialURL(lock.archive.url, 'archive');
  if (lock.archive.url !== `https://dl.google.com/go/go${lock.version}.${lock.platform}-${lock.arch}.tar.gz`) throw new Error('Go archive version/platform mismatch');
}

function validateTar(file, { maxBytes, maxFiles }) {
  const seen = new Set(), spelling = new Map();
  let bytes = 0, files = 0;
  tar.t({ file, sync: true, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, '');
    const parts = name.split('/');
    if (!['File', 'Directory'].includes(entry.type) || entry.linkpath || (entry.mode & 0o7000) ||
        parts[0] !== 'go' || parts.some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f\x7f]/.test(name) || name.length > 4096) {
      throw new Error(`Unsafe Go archive entry: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || ++files > maxFiles || (bytes += entry.size) > maxBytes) throw new Error('Go extraction limit exceeded');
    if (entry.type === 'Directory' && entry.size !== 0) throw new Error('Invalid Go directory entry');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate Go archive entry: ${name}`);
    seen.add(key);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), lower = prefix.toLowerCase();
      if (spelling.has(lower) && spelling.get(lower) !== prefix) throw new Error('Go archive case-alias path');
      spelling.set(lower, prefix);
    }
  } });
  return { files, bytes };
}

export async function acquireGoInputs(lock, { directory, fetcher = fetch, limits = {} }) {
  validateLock(lock);
  const maxBytes = limits.maxBytes ?? extractionLimit, maxFiles = limits.maxFiles ?? fileLimit;
  if (![maxBytes, maxFiles].every(n => Number.isSafeInteger(n) && n > 0) || maxBytes > extractionLimit || maxFiles > fileLimit) throw new Error('Invalid Go extraction limit');
  if (!path.isAbsolute(directory)) throw new Error('Go input directory must be absolute');
  // No reuse, overwrite or cleanup of caller-owned directories. A failed new directory
  // remains diagnostic evidence and never receives a successful source-lock.json.
  await mkdir(directory, { mode: 0o700 });
  const archive = path.join(directory, 'sdk.tar.gz'), unpacked = path.join(directory, 'sdk.tar');
  const response = await responseFor(lock.archive.url, 'archive', lock.archive.bytes, fetcher);
  await pipeline(response.body, bound(lock.archive.bytes), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  if ((await lstat(archive)).size !== lock.archive.bytes || await sha256(archive) !== lock.archive.sha256) throw new Error('Go archive hash/size mismatch');
  // Bound decompression including headers/PAX metadata before tar interprets anything.
  await pipeline(createReadStream(archive), createGunzip(), bound(maxBytes + maxFiles * 1024 + 1024 ** 2), createWriteStream(unpacked, { flags: 'wx', mode: 0o600 }));
  const extraction = validateTar(unpacked, { maxBytes, maxFiles });
  const sdkRoot = path.join(directory, 'sdk');
  await mkdir(sdkRoot, { mode: 0o700 });
  tar.x({ file: unpacked, cwd: sdkRoot, sync: true, strict: true, preserveOwner: false, noMtime: true });
  const goroot = path.join(sdkRoot, 'go'), versionFile = path.join(goroot, 'VERSION'), binary = path.join(goroot, 'bin/go');
  const versionStat = await lstat(versionFile);
  if (!versionStat.isFile() || versionStat.size > 4096 || (await readFile(versionFile, 'utf8')).split('\n')[0] !== `go${lock.version}`) throw new Error('Go VERSION mismatch');
  if (!(await lstat(binary)).isFile() || !(await lstat(path.join(goroot, 'src'))).isDirectory()) throw new Error('Incomplete Go SDK layout');
  await chmod(binary, 0o755);
  const home = path.join(directory, 'home'), temporary = path.join(directory, 'tmp');
  await mkdir(home); await mkdir(temporary);
  const { stdout } = await execute(binary, ['version'], {
    cwd: directory, timeout: 30000, maxBuffer: 16384,
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temporary, LANG: 'C', GOROOT: goroot,
      GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off' },
  });
  if (stdout.trim() !== `go version go${lock.version} ${lock.platform}/${lock.arch}`) throw new Error('Go compiler version/platform mismatch');
  const sourceLock = { ...structuredClone(lock), extraction, compiler: { version: `go${lock.version}`, sha256: await sha256(binary) } };
  await writeFile(path.join(directory, 'source-lock.json'), `${JSON.stringify(sourceLock, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { goroot, sourceLock };
}
