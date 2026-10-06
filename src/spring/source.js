import { execFile } from 'node:child_process';
import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const officialRepository = 'https://github.com/spring-projects/spring-framework.git';
const sha256 = b => createHash('sha256').update(b).digest('hex');
const decode = b => new TextDecoder('utf-8', { fatal: true }).decode(b);
const safePath = p => p.length <= 4096 && !/[\\\x00-\x1f\x7f:]/.test(p) &&
  p.split('/').every(x => x && x !== '.' && x !== '..' && x.toLowerCase() !== '.git');
function identity(version, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Exact Spring commit required');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Stable Spring version required');
}
// No inherited credentials, global config, custom protocols, hooks or filters.
// Read-only local object operations never checkout or execute repository code.
function git(cwd, args, { input, maxBuffer = 8 * 1024 ** 2, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd, encoding: 'buffer', maxBuffer, timeout,
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

/** Materialize and hash ALL committed blobs, ignoring dirty/untracked files.
 * repositoryDirectory is a trusted local object store, not an arbitrary user
 * repository. Network provenance belongs to acquireSpringSource below.
 * A new private destination is mandatory; failures never remove user data.
 */
export async function materializeSpringSource({ repositoryDirectory, destination, version, commit }) {
  identity(version, commit);
  if (!path.isAbsolute(destination) || !path.isAbsolute(repositoryDirectory)) throw new Error('Absolute source paths required');
  const repository = await realpath(repositoryDirectory);
  const resolvedDestination = path.join(await realpath(path.dirname(destination)), path.basename(destination));
  if (resolvedDestination === repository || resolvedDestination.startsWith(repository + path.sep) || repository.startsWith(resolvedDestination + path.sep)) throw new Error('Source destination overlaps repository');
  const actual = decode(await git(repository, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
  if (actual !== commit) throw new Error('Git commit identity mismatch');
  const rows = decode(await git(repository, ['ls-tree', '-rz', commit])).split('\0').filter(Boolean);
  if (!rows.length || rows.length > 30000) throw new Error('Source tree entry limit');
  const entries = [], spellings = new Map(), paths = new Set();
  for (const row of rows) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match || !safePath(match[3])) throw new Error('Unsafe source path, submodule or mode');
    const [, mode, oid, name] = match;
    if (paths.has(name)) throw new Error('Duplicate source path');
    paths.add(name);
    const pieces = name.split('/');
    if (pieces.length > 32) throw new Error('Source tree depth limit');
    for (let i = 1; i <= pieces.length; i++) {
      const prefix = pieces.slice(0, i).join('/'), key = prefix.normalize('NFC').toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) throw new Error('Source path case/Unicode alias');
      spellings.set(key, prefix);
    }
    entries.push({ path: name, mode, oid });
  }
  const output = await git(repository, ['cat-file', '--batch'], {
    input: entries.map(e => e.oid).join('\n') + '\n', maxBuffer: 256 * 1024 ** 2,
  });
  let offset = 0, bytes = 0;
  const contents = new Map();
  for (const entry of entries) {
    const end = output.indexOf(10, offset);
    const header = /^(\w{40}) blob (\d+)$/.exec(output.toString('ascii', offset, end));
    if (end < 0 || !header || header[1] !== entry.oid) throw new Error('Git blob header mismatch');
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size > 16 * 1024 ** 2 || (bytes += size) > 240 * 1024 ** 2) throw new Error('Source blob byte limit');
    const data = output.subarray(end + 1, end + 1 + size);
    if (data.length !== size || output[end + 1 + size] !== 10) throw new Error('Truncated Git blob');
    if (createHash('sha1').update(`blob ${size}\0`).update(data).digest('hex') !== entry.oid) throw new Error('Git blob content mismatch');
    entry.sha256 = sha256(data); contents.set(entry.path, data); offset = end + size + 2;
  }
  if (offset !== output.length) throw new Error('Unexpected Git batch trailing bytes');
  const properties = contents.get('gradle.properties');
  if (!properties || decode(properties).split(/\r?\n/).filter(l => l.startsWith('version=')).join('\n') !== `version=${version}`) throw new Error('Source version mismatch');
  const links = entries.filter(e => e.mode === '120000');
  for (const link of links) {
    const target = decode(contents.get(link.path));
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(link.path), target));
    if (!target || target.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(target) || !safePath(resolved) ||
        !entries.some(e => e.path === resolved || e.path.startsWith(resolved + '/')) ||
        links.some(e => resolved === e.path || resolved.startsWith(e.path + '/')) || link.path.startsWith(resolved + '/')) throw new Error(`Unsafe or cyclic source link: ${link.path}`);
    link.target = target;
  }
  await mkdir(resolvedDestination, { mode: 0o700 }); // Exclusive; never overwrite.
  for (const entry of entries.filter(e => e.mode !== '120000')) {
    const file = path.join(resolvedDestination, entry.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents.get(entry.path), { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
  for (const entry of links) {
    const file = path.join(resolvedDestination, entry.path);
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(entry.target, file);
  }
  return { schemaVersion: 1, version, commit, sourceRoot: resolvedDestination,
    files: entries.length, bytes, treeSha256: sha256(JSON.stringify(entries)), entries };
}

/** Fixed official HTTPS transport, no recipe-supplied URL or shell command. */
export async function acquireSpringSource({ directory, version, commit }) {
  identity(version, commit);
  if (!path.isAbsolute(directory)) throw new Error('Absolute acquisition directory required');
  await mkdir(directory, { mode: 0o700 });
  const objects = path.join(directory, 'objects.git');
  await git(directory, ['init', '--bare', objects]);
  await git(objects, ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'fetch.fsckObjects=true',
    'fetch', '--depth=1', '--no-tags', officialRepository, commit], { timeout: 180000 });
  const source = await materializeSpringSource({ repositoryDirectory: objects, destination: path.join(directory, 'source'), version, commit });
  await writeFile(path.join(directory, 'source-lock.json'), JSON.stringify({ ...source, repository: officialRepository }, null, 2), { flag: 'wx' });
  return source;
}
