import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, symlink, lstat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import * as tar from 'tar';
import { sha256 as hashFile } from '../identity.js';

function bound(limit) {
  let count = 0;
  return new Transform({ transform(chunk, _, done) {
    count += chunk.length; done(count > limit ? new Error('Spring tool byte limit') : null, chunk);
  } });
}

/** Copy and verify a pinned archive before parsing/extracting. No executable is
 * started. The caller supplies a reviewed lock, never a recipe-defined command.
 */
export async function unpackSpringToolArchive({ archive, directory, sha256, root }) {
  if (!path.isAbsolute(archive) || !path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(sha256) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(root)) throw new Error('Invalid Spring tool archive lock');
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2) throw new Error('Unsafe Spring tool archive');
  await mkdir(directory, { mode: 0o700 });
  const copied = path.join(directory, 'tool.tgz'), unpacked = path.join(directory, 'tool.tar');
  await pipeline(createReadStream(archive, { flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }),
    bound(256 * 1024 ** 2), createWriteStream(copied, { flags: 'wx', mode: 0o600 }));
  if (await hashFile(copied) !== sha256) throw new Error('Spring tool archive hash mismatch');
  await pipeline(createReadStream(copied), createGunzip(), bound(540 * 1024 ** 2), createWriteStream(unpacked, { flags: 'wx', mode: 0o600 }));
  const entries = new Map(), spelling = new Map(); let bytes = 0;
  tar.t({ file: unpacked, sync: true, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, ''), parts = name.split('/');
    if (parts[0] !== root || parts.length > 32 || parts.some(p => !p || p === '.' || p === '..') ||
        name.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(name) ||
        !['File', 'Directory', 'SymbolicLink'].includes(entry.type) ||
        (entry.mode & (entry.type === 'Directory' ? 0o5000 : 0o7000))) throw new Error(`Unsafe Spring tool entry: ${name}`);
    if (entries.has(name)) throw new Error('Duplicate Spring tool entry');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 256 * 1024 ** 2 ||
        (bytes += entry.size) > 512 * 1024 ** 2 || entries.size >= 20000 ||
        (entry.type !== 'File' && entry.size !== 0)) throw new Error('Spring tool extraction limit');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.normalize('NFC').toLowerCase();
      if (spelling.has(key) && spelling.get(key) !== prefix) throw new Error('Spring tool path alias');
      spelling.set(key, prefix);
    }
    entries.set(name, { type: entry.type, target: entry.linkpath });
  } });
  if (!entries.size) throw new Error('Empty Spring tool archive');
  for (const [name, entry] of entries) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = entries.get(parts.slice(0, i).join('/'));
      if (parent && parent.type !== 'Directory') throw new Error('Unsafe Spring tool parent');
    }
    if (entry.type === 'SymbolicLink') {
      const target = entry.target;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (!target || target.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(target) ||
          !resolved.startsWith(root + '/') || entries.get(resolved)?.type !== 'File') throw new Error('Unsafe Spring tool link');
    } else if (entry.target) throw new Error('Unexpected Spring tool link');
  }
  const output = path.join(directory, 'files'); await mkdir(output);
  tar.x({ file: unpacked, cwd: output, sync: true, strict: true, preserveOwner: false, noMtime: true,
    filter: (_name, entry) => { entry.mode &= 0o777; return entry.type !== 'SymbolicLink'; } });
  // Links cannot redirect extraction: install reviewed internal links last.
  for (const [name, entry] of entries) if (entry.type === 'SymbolicLink') {
    const file = path.join(output, name); await mkdir(path.dirname(file), { recursive: true }); await symlink(entry.target, file);
  }
  return { root: path.join(output, root), files: entries.size, bytes, sha256 };
}
