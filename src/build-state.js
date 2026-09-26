import { lstat, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as plist from 'plist';
import { load } from 'cheerio';
import { SHA256, sha256, recipeIdentity, assertIdentity, assertVersionLine } from './identity.js';

export async function regularPath(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw new Error(`Unsafe state path (symlink or nonregular): ${file}`);
  return info;
}

async function optionalJSON(file) {
  try {
    const info = await regularPath(file);
    if (info.size > 4 * 1024 * 1024) throw new Error(`State file too large: ${file}`);
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid state object: ${file}`);
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, file);
}

export async function saveCurrent(work, identity, manifest) {
  // Deliberately no top-level fingerprint/revision: the schema-1 CLI refuses it.
  await atomicJSON(path.join(work, 'current.json'), {
    schemaVersion: 2, ...identity,
    release: { fingerprint: manifest.fingerprint, version: manifest.version, revision: manifest.revision }
  });
}

function legacyPython(identity) {
  return identity.sourceId === 'dev.crux' && identity.familyId === 'python' && identity.variantId === 'python-3-14-en' && identity.versionLine === '3.14' && identity.language === 'en' && identity.identifier === 'dev.crux.python' && identity.bundleName === 'Python';
}

export async function readRelease(work, id, recipe, validate) {
  if (!SHA256.test(id)) throw new Error('Invalid local release fingerprint');
  const releases = path.join(work, 'releases');
  try { await regularPath(releases, true); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const directory = path.join(releases, id);
  try { await regularPath(directory, true); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const manifest = await optionalJSON(path.join(directory, 'manifest.json'));
  if (!manifest) throw new Error('Incomplete release directory requires manual review');
  const identity = recipeIdentity(recipe);
  if (manifest.schemaVersion === 2) {
    assertIdentity(manifest, identity);
    if (manifest.releaseId !== id) throw new Error('Release identity mismatch');
  } else if (manifest.schemaVersion !== 1 || !legacyPython(identity) || manifest.id !== 'python') {
    throw new Error('Unsupported manifest schema or legacy identity');
  }
  assertVersionLine(manifest.version, recipe);
  if (manifest.fingerprint !== id || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 || manifest.artifact?.file !== `${recipe.bundleName}.tgz` || !SHA256.test(manifest.artifact.sha256) || !Number.isSafeInteger(manifest.artifact.bytes) || manifest.artifact.bytes < 1 || manifest.validation?.passed !== true) throw new Error('Invalid release manifest');
  const archive = path.join(directory, manifest.artifact.file);
  if ((await regularPath(archive)).size !== manifest.artifact.bytes || await sha256(archive) !== manifest.artifact.sha256) throw new Error('Cached artifact checksum or size mismatch');
  if (manifest.schemaVersion === 1) {
    // Do not derive ownership from id=python alone, or trust unvalidated old files.
    const bundle = path.join(directory, 'Python.docset');
    if (!(await validate(bundle, recipe)).passed) throw new Error('Legacy bundle validation failed');
    const info = plist.parse(await readFile(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'));
    if (info.CFBundleIdentifier !== identity.identifier) throw new Error('Legacy bundle identifier mismatch');
    const title = load(await readFile(path.join(bundle, 'Contents', 'Resources', 'Documents', 'index.html'), 'utf8'))('title').text();
    if (!new RegExp(`^(?:Python )?${manifest.version.replaceAll('.', '\\.')} documentation$`, 'i').test(title)) throw new Error('Legacy document version identity mismatch');
    const source = new URL(manifest.source?.url);
    const archiveVersion = source.pathname.match(/\/python-([\d.]+)-docs-html\.zip$/)?.[1];
    if (source.protocol !== 'https:' || source.hostname !== 'docs.python.org' || source.port || source.username || source.password || ![manifest.version, identity.versionLine].includes(archiveVersion) || !SHA256.test(manifest.source.sha256)) throw new Error('Cannot verify legacy source identity; manual review required');
  }
  return manifest;
}

// Called only while holding build.lock, including first adoption of an empty directory.
export async function prepareBuildState(work, recipe, validate) {
  const identity = recipeIdentity(recipe);
  for (const name of ['releases', 'quarantine']) {
    try { await regularPath(path.join(work, name), true); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const owner = await optionalJSON(path.join(work, 'owner.json'));
  if (owner) {
    if (owner.schemaVersion !== 2) throw new Error('Unsupported owner schema');
    assertIdentity(owner, identity);
  }
  const statePath = path.join(work, 'current.json');
  const state = await optionalJSON(statePath);
  let previous, baseline, orphanFingerprint;
  if (state) {
    if (state.schemaVersion === 1) {
      if (!legacyPython(identity)) throw new Error('Unverified legacy owner identity');
      previous = state;
    } else if (state.schemaVersion === 2 && owner) {
      assertIdentity(state, identity);
      previous = state.release;
    } else throw new Error('Unsupported local state schema or missing owner');
    if (!previous || !SHA256.test(previous.fingerprint) || !Number.isSafeInteger(previous.revision) || previous.revision < 1) throw new Error('Invalid local state');
    baseline = await readRelease(work, previous.fingerprint, recipe, validate);
    if (!baseline || baseline.version !== previous.version || baseline.revision !== previous.revision || (state.schemaVersion === 1 && baseline.schemaVersion !== 1)) throw new Error('State/manifest identity mismatch');
  } else if (!owner && (await readdir(work)).some(name => name !== 'build.lock')) {
    throw new Error('Cannot adopt nonempty unowned workspace');
  } else if (owner) {
    let releases = [];
    try { releases = await readdir(path.join(work, 'releases')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (releases.length > 1 || releases.some(id => !SHA256.test(id))) throw new Error('Missing current pointer with ambiguous release history; manual review required');
    orphanFingerprint = releases[0];
  }
  if (state?.schemaVersion === 1) {
    const backup = path.join(work, 'legacy-current.v1.json');
    const original = await readFile(statePath, 'utf8');
    try { await writeFile(backup, original, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== original) throw error; }
  }
  if (!owner) await atomicJSON(path.join(work, 'owner.json'), { schemaVersion: 2, ...identity });
  if (state?.schemaVersion === 1) await saveCurrent(work, identity, baseline);
  return { identity, previous, baseline, orphanFingerprint };
}
