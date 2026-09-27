import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, readdir, lstat, realpath, open, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build as buildPlist } from 'plist';
import { recipeIdentity, assertVersionLine } from '../identity.js';
import { regularPath } from '../build-state.js';
import { validate } from '../validate.js';

const sections = ['api/javadoc-api/', 'api/kdoc-api/', 'reference/'];
const types = new Set('Module Package Annotation Enum Interface Struct Class Constant Field Constructor Property Method Function Guide Section'.split(' '));
const safePart = part => /^[A-Za-z0-9_$.-]+$/.test(part) && part !== '.' && part !== '..';
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** Package an immutable, already assembled export into a NEW local candidate.
 * This is a structural packaging gate, not source/runtime/license qualification.
 * The adapter must authenticate/qualify its inputs; the common pipeline owns
 * icons, full recipe validation and promotion. No input is moved or deleted.
 */
export async function writeSpringBundle(recipe, exported, { candidate, version, commit }) {
  // Own the data used after the first await; caller mutation must not bypass
  // validation or make the generated metadata disagree with the search index.
  recipe = structuredClone(recipe);
  exported = structuredClone(exported);
  const identity = recipeIdentity(recipe);
  assertVersionLine(version, recipe);
  if (recipe.familyId !== 'spring-framework' || recipe.identifier !== 'dev.crux.spring-framework' || recipe.bundleName !== 'Spring_Framework' ||
      recipe.name !== 'Spring Framework' || recipe.homepage !== 'index.html' || !/^\d+\.\d+$/.test(recipe.versionLine) ||
      recipe.variantId !== `spring-framework-${recipe.versionLine.replace('.', '-')}-en`) throw new Error('Invalid Spring bundle identity');
  if (!/^[a-f0-9]{40}$/.test(commit) || exported.evidence?.commit !== commit || exported.evidence?.version !== version) throw new Error('Spring source commit/version mismatch');
  if (!Array.isArray(exported.symbols) || !exported.symbols.length || exported.symbols.length > 200000) throw new Error('Spring symbol count limit');
  const seen = new Set(), coverage = new Set();
  for (const symbol of exported.symbols) {
    if (typeof symbol.name !== 'string' || !symbol.name.trim() || !symbol.name.isWellFormed() || Buffer.byteLength(symbol.name) > 8192 || /[\x00-\x1f\x7f]/.test(symbol.name) ||
        !types.has(symbol.type) || typeof symbol.path !== 'string' || symbol.path.length > 8192) throw new Error('Invalid Spring index symbol');
    const hash = symbol.path.indexOf('#'), file = hash < 0 ? symbol.path : symbol.path.slice(0, hash);
    let fragment;
    try { fragment = hash < 0 ? '' : decodeURIComponent(symbol.path.slice(hash + 1)); } catch { throw new Error('Invalid Spring symbol fragment'); }
    const section = sections.find(prefix => file.startsWith(prefix));
    if (!section || !file.endsWith('.html') || !file.split('/').every(safePart) || /[\x00-\x1f\x7f]/.test(fragment)) throw new Error('Invalid Spring symbol path');
    const key = JSON.stringify([symbol.name, symbol.type, symbol.path]);
    if (seen.has(key)) throw new Error('Duplicate Spring index symbol');
    seen.add(key); coverage.add(section);
  }
  if (coverage.size !== sections.length) throw new Error('Spring symbols must cover Java, Kotlin and reference');
  if (!path.isAbsolute(candidate) || !path.isAbsolute(exported.documentsRoot)) throw new Error('Spring bundle paths must be absolute');
  await regularPath(candidate, true); await regularPath(exported.documentsRoot, true);
  const source = await realpath(exported.documentsRoot), destination = await realpath(candidate);
  if (overlaps(source, destination)) throw new Error('Spring export and candidate must be separate');
  const files = []; let total = 0, entries = 0;
  async function inventory(relative = '') {
    if (relative.split('/').length > 32) throw new Error('Spring tree depth limit');
    for (const name of await readdir(path.join(source, relative))) {
      if (++entries > 30000 || !safePart(name)) throw new Error('Spring tree path/count limit');
      const file = relative ? `${relative}/${name}` : name, stat = await lstat(path.join(source, file));
      if (stat.isSymbolicLink()) throw new Error('Spring export symlink rejected');
      if (stat.isDirectory()) { await inventory(file); continue; }
      if (!stat.isFile()) throw new Error('Spring export must contain regular files');
      if (stat.size > 16 * 1024 ** 2 || (total += stat.size) > 512 * 1024 ** 2) throw new Error('Spring export byte limit');
      if (file === 'index.html') throw new Error('Spring bundle homepage already exists in export');
      files.push({ file, stat });
    }
  }
  await inventory();
  const paths = new Set(files.map(x => x.file));
  for (const section of sections) if (!paths.has(section + 'index.html')) throw new Error(`Missing Spring section homepage: ${section}`);
  const bundle = path.join(destination, 'Spring_Framework.docset'), resources = path.join(bundle, 'Contents/Resources');
  await mkdir(bundle); // Exclusive: never reuse or overwrite an existing candidate.
  await mkdir(path.join(resources, 'Documents'), { recursive: true });
  for (const { file, stat } of files) {
    const input = path.join(source, file), output = path.join(resources, 'Documents', file);
    const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || await realpath(input) !== input) throw new Error('Spring export changed during packaging');
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat();
      if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Spring export changed during packaging');
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes.subarray(0, count), { flag: 'wx' });
    } finally { await handle.close(); }
  }
  await writeFile(path.join(resources, 'Documents/index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Spring Framework ${version}</title></head><body><main><h1>Spring Framework ${version}</h1><ul><li><a href="api/javadoc-api/index.html">Java API</a></li><li><a href="api/kdoc-api/index.html">Kotlin API</a></li><li><a href="reference/index.html">Reference manual</a></li></ul></main></body></html>`, { flag: 'wx' });
  const db = new DatabaseSync(path.join(resources, 'docSet.dsidx'));
  try {
    db.exec('CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, path TEXT NOT NULL); CREATE UNIQUE INDEX anchor ON searchIndex(name,type,path); BEGIN');
    const insert = db.prepare('INSERT INTO searchIndex(name,type,path) VALUES(?,?,?)');
    for (const symbol of exported.symbols) insert.run(symbol.name, symbol.type, symbol.path);
    db.exec('COMMIT');
  } finally { db.close(); }
  await writeFile(path.join(bundle, 'Contents/Info.plist'), buildPlist({ CFBundleIdentifier: recipe.identifier, CFBundleName: recipe.name,
    CFBundleVersion: version, DocSetPlatformFamily: 'spring', DashDocSetFamily: 'spring', isDashDocset: true,
    dashIndexFilePath: recipe.homepage, isJavaScriptEnabled: true }), { flag: 'wx' });
  await writeFile(path.join(bundle, 'meta.json'), JSON.stringify({ name: recipe.name, ...identity, version,
    extra: { indexFilePath: recipe.homepage, isJavaScriptEnabled: true, sourceCommit: commit } }, null, 2), { flag: 'wx' });
  // Icons are installed by the common pipeline after adapter build. This check
  // proves only the bundle structure/search targets, never release eligibility.
  const report = await validate(bundle, { ...recipe, validation: { minimumPages: 4, minimumSymbols: exported.symbols.length } });
  if (!report.passed) throw new Error(`Spring bundle structural validation failed: ${report.errors.join('; ')}`);
  return { version, bundle };
}
