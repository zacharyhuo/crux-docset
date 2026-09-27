import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { build as buildPlist } from 'plist';
import { recipeIdentity, assertVersionLine } from '../identity.js';
import { regularPath } from '../build-state.js';
import { verifyGoOfflineTree } from './export.js';
import { GO_CONTEXTS } from './inventory.js';

const types = new Set(['Package', 'Function', 'Method', 'Struct', 'Interface', 'Type', 'Field', 'Constant', 'Variable']);

// Exported Documents is owned scratch: move it only into a fresh candidate.
// Common pipeline validation remains the promotion authority after packaging.
export async function writeGoBundle(recipe, exported, { candidate, version }) {
  const identity = recipeIdentity(recipe);
  assertVersionLine(version, recipe);
  if (recipe.familyId !== 'go' || recipe.identifier !== 'dev.crux.go' || recipe.bundleName !== 'Go' || recipe.homepage !== 'index.html') throw new Error('Invalid Go bundle identity');
  if (exported.evidence.version !== version) throw new Error('Go export version mismatch');
  if (!Array.isArray(exported.symbols) || !exported.symbols.length || exported.symbols.length > 100000) throw new Error('Invalid Go symbol count');
  const seen = new Set();
  for (const symbol of exported.symbols) {
    if (typeof symbol.name !== 'string' || !symbol.name.trim() || symbol.name.length > 2048 || /[\x00-\x1f]/.test(symbol.name) || !types.has(symbol.type) ||
        typeof symbol.path !== 'string' || symbol.path.length > 4096 || !/^platforms\/(?:linux-amd64|windows-amd64|darwin-amd64|js-wasm)\/(?:[A-Za-z0-9_]+\/)+index\.html(?:#[A-Za-z0-9_.%~-]+)?$/.test(symbol.path)) throw new Error('Invalid Go index symbol');
    const key = JSON.stringify([symbol.name, symbol.type, symbol.path]);
    if (seen.has(key)) throw new Error('Duplicate Go index symbol'); seen.add(key);
  }
  if (!path.isAbsolute(candidate) || !path.isAbsolute(exported.documentsRoot)) throw new Error('Go bundle paths must be absolute');
  await regularPath(candidate, true); await regularPath(exported.documentsRoot, true);
  await verifyGoOfflineTree(exported.documentsRoot);
  const bundle = path.join(candidate, 'Go.docset'), resources = path.join(bundle, 'Contents/Resources');
  await mkdir(bundle); await mkdir(resources, { recursive: true });
  await rename(exported.documentsRoot, path.join(resources, 'Documents'));
  const db = new DatabaseSync(path.join(resources, 'docSet.dsidx'));
  try {
    db.exec('CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, path TEXT NOT NULL); CREATE UNIQUE INDEX anchor ON searchIndex(name,type,path); BEGIN');
    const insert = db.prepare('INSERT INTO searchIndex(name,type,path) VALUES(?,?,?)');
    for (const symbol of exported.symbols) insert.run(symbol.name, symbol.type, symbol.path);
    db.exec('COMMIT');
  } finally { db.close(); }
  await writeFile(path.join(bundle, 'Contents/Info.plist'), buildPlist({ CFBundleIdentifier: recipe.identifier,
    CFBundleName: recipe.name, CFBundleVersion: version, DocSetPlatformFamily: 'go', DashDocSetFamily: 'go',
    isDashDocset: true, dashIndexFilePath: recipe.homepage, isJavaScriptEnabled: false }), { flag: 'wx' });
  await writeFile(path.join(bundle, 'meta.json'), JSON.stringify({ name: recipe.name, ...identity, version,
    extra: { indexFilePath: recipe.homepage, isJavaScriptEnabled: false, platforms: GO_CONTEXTS,
      coverage: 'Public standard-library packages in the listed contexts only; not all Go target platforms.',
      examples: 'Source and supplied output only; execution is unavailable offline.' } }, null, 2), { flag: 'wx' });
  return { version, bundle };
}
