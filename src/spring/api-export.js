import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, readdir, lstat, realpath, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { regularPath } from '../build-state.js';
import { readSpringJavaMembers } from './java-members.js';
import { createSpringApiLinkResolver } from './api-links.js';
import { rewriteSpringApiPage } from './api-page.js';
import { createSpringJavaReferencePolicy } from './java-reference-policy.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
async function bytes(file, limit = 16 * 1024 ** 2) {
  const initial = await regularPath(file);
  if (initial.size > limit || await realpath(file) !== file) throw new Error('API input byte limit or symlink');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== initial.ino || stat.dev !== initial.dev || stat.size !== initial.size) throw new Error('API input changed');
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await handle.stat();
    if (count !== stat.size || after.mtimeMs !== initial.mtimeMs || after.size !== stat.size) throw new Error('API input changed');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

/** Assemble generated Java/Kotlin APIs without touching either input tree.
 * Caller owns source authentication and renderer/resource qualification. This
 * stage records all input hashes and fails on unknown internal link targets.
 */
export async function exportSpringApi({ javaRoot, kotlinRoot, sourceRoot, destination, version, commit }) {
  for (const root of [javaRoot, kotlinRoot, sourceRoot, destination]) if (!path.isAbsolute(root)) throw new Error('Absolute API paths required');
  for (const root of [javaRoot, kotlinRoot, sourceRoot]) await regularPath(root, true);
  [javaRoot, kotlinRoot, sourceRoot] = await Promise.all([javaRoot, kotlinRoot, sourceRoot].map(root => realpath(root)));
  destination = path.join(await realpath(path.dirname(destination)), path.basename(destination));
  for (const root of [javaRoot, kotlinRoot, sourceRoot]) if (overlaps(root, destination)) throw new Error('API overlapping paths');
  try { await lstat(destination); throw new Error('API destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sources = new Map(), sourcePrefix = 'spring-webmvc/src/main/java/org/springframework/web/servlet/mvc/';
  for (const file of ['gradle.properties', sourcePrefix + 'Controller.java', sourcePrefix + 'AbstractController.java']) sources.set(file, text(await bytes(path.join(sourceRoot, file), 1024 ** 2)));
  const javaReferencePolicy = createSpringJavaReferencePolicy({ version, commit, sources });
  const files = [], pages = new Map(), resources = new Set(), members = new Map();
  let total = 0, entries = 0;
  async function walk(root, prefix, relative = '') {
    if (relative.split('/').length > 32) throw new Error('API tree depth limit');
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (++entries > 30000 || !/^[A-Za-z0-9_$.-]+$/.test(name) || name === '.' || name === '..') throw new Error('API path/count limit');
      const local = relative ? `${relative}/${name}` : name, physical = path.join(root, local), stat = await lstat(physical);
      if (stat.isSymbolicLink()) throw new Error('API symlink rejected');
      if (stat.isDirectory()) { await walk(root, prefix, local); continue; }
      if (!stat.isFile() || (total += stat.size) > 512 * 1024 ** 2) throw new Error('API file type/size limit');
      const input = await bytes(physical), file = `${prefix}/${local}`;
      files.push({ file, physical, sha256: sha(input) });
      if (!file.endsWith('.html')) { resources.add(file); continue; }
      const html = text(input), $ = load(html), ids = new Set();
      for (const node of $('[id],a[name]')) for (const id of new Set([node.attribs.id, node.name === 'a' ? node.attribs.name : undefined])) {
        if (id === undefined) continue;
        if (ids.has(id)) throw new Error('Duplicate API anchor');
        ids.add(id);
      }
      pages.set(file, ids);
      if (prefix === 'api/javadoc-api' && $('main section.detail[id],main .inherited-list code a[href]').length) members.set(local, readSpringJavaMembers(html, { page: local }));
    }
  }
  await walk(javaRoot, 'api/javadoc-api'); await walk(kotlinRoot, 'api/kdoc-api');
  for (const prefix of ['api/javadoc-api', 'api/kdoc-api']) if (!pages.has(`${prefix}/index.html`)) throw new Error('Missing API homepage');
  const resolve = createSpringApiLinkResolver({ version, pages, resources, javaMembers: members, javaReferencePolicy });
  await mkdir(destination); const documentsRoot = path.join(destination, 'Documents'); await mkdir(documentsRoot);
  const warnings = [];
  for (const entry of files) {
    const input = await bytes(entry.physical);
    if (sha(input) !== entry.sha256) throw new Error('API input changed between inventory and export');
    let output = input;
    if (pages.has(entry.file)) {
      const result = rewriteSpringApiPage(text(input), { from: entry.file, resolve });
      output = result.html; warnings.push(...result.warnings);
    }
    const target = path.join(documentsRoot, entry.file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, output, { flag: 'wx' });
  }
  return { documentsRoot, pages: pages.size, resources: resources.size, warnings,
    version, commit, inputs: files.map(({ physical: _physical, ...entry }) => entry), sourceEvidence: javaReferencePolicy.evidence };
}
