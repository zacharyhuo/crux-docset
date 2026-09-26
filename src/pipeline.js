import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import * as tar from 'tar';
import lockfile from 'proper-lockfile';
import { fingerprint, sha256, recipeIdentity, assertVersionLine, rejectDowngrade } from './identity.js';
import { prepareBuildState, saveCurrent, readRelease, regularPath } from './build-state.js';

export { fingerprint, sha256 } from './identity.js';

export function discoverPython(html, base) {
  const $ = load(html);
  const href = $('a[href]').toArray().map(el => $(el).attr('href')).find(h => /python-[\d.]+-docs-html\.zip$/.test(h));
  if (!href) throw new Error('Official HTML archive not found');
  const url = new URL(href, base);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.python.org' || url.username || url.password) throw new Error('Unexpected source host');
  return url.href;
}

export function safeArchivePath(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe archive path: ${name}`);
  return name;
}

export function makeFeed(version, url, revision = 1) {
  if (new URL(url).protocol !== 'https:') throw new Error('Feed requires HTTPS');
  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<entry><version>${escape(version)}</version><revision>${revision}</revision><url>${escape(url)}</url></entry>\n`;
}

export async function json(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

// Only updates local last-known-good state. Remote promotion is a separate job.
export async function buildCandidate({ work, recipe, source, builder, build, validate, baseUrl, withSource, allocateRevision }) {
  recipeIdentity(recipe);
  await mkdir(work, { recursive: true });
  await regularPath(work, true);
  // A heartbeat lease allows recovery after SIGKILL/restart; a live competing
  // builder fails immediately. Compromised leases abort through the library.
  const release = await lockfile.lock(work, { lockfilePath: path.join(work, 'build.lock'), stale: 120_000, update: 10_000, retries: 0 });
  try {
    const state = await prepareBuildState(work, recipe, validate);
    const consume = (source, build) => buildLocked({ work, recipe, source, builder, build, validate, baseUrl, state, allocateRevision });
    return withSource ? await withSource(consume) : await consume(source, build);
  } finally {
    await release();
  }
}

async function buildLocked({ work, recipe, source, builder, build, validate, baseUrl, state, allocateRevision }) {
  const id = fingerprint({ source, recipe, builder, baseUrl });
  const { identity, previous, baseline } = state;
  const revisionFor = async (version, minimumRevision) => {
    const revision = allocateRevision ? await allocateRevision({ ...identity, version, releaseId: id }, minimumRevision) : minimumRevision;
    if (!Number.isSafeInteger(revision) || revision < minimumRevision) throw new Error('Invalid allocated publication revision');
    return revision;
  };
  if (state.orphanFingerprint && state.orphanFingerprint !== id) throw new Error('Missing current pointer; recover the original inputs or request manual review');
  if (previous?.fingerprint === id) {
    if (await revisionFor(previous.version, previous.revision) !== previous.revision) throw new Error('Immutable cached release revision conflicts with publication state');
    const dir = path.join(work, 'releases', id);
    return { status: 'unchanged', fingerprint: id, directory: dir };
  }
  const existing = path.join(work, 'releases', id);
  const recovered = await readRelease(work, id, recipe, validate);
  if (recovered) {
    if (await revisionFor(recovered.version, recovered.revision) !== recovered.revision) throw new Error('Immutable recovery release revision conflicts with publication state');
    rejectDowngrade(previous?.version, recovered.version);
    rejectRegression(baseline?.validation, recovered.validation, recipe);
    if (previous && previous.version === recovered.version && previous.revision >= recovered.revision) throw new Error('Previously released fingerprint reappeared; manual rollback review required');
    await saveCurrent(work, identity, recovered);
    return { status: 'recovered', fingerprint: id, directory: existing };
  }
  const candidate = path.join(work, 'quarantine', randomUUID());
  await mkdir(candidate, { recursive: true });
  const { version } = await build(candidate);
  assertVersionLine(version, recipe);
  rejectDowngrade(previous?.version, version);
  const bundle = path.join(candidate, `${recipe.bundleName}.docset`);
  const report = await validate(bundle, recipe);
  await json(path.join(candidate, 'validation.json'), report);
  if (!report.passed) throw new Error(`Validation failed; report: ${candidate}/validation.json`);
  rejectRegression(baseline?.validation, report, recipe);
  const revision = await revisionFor(version, previous?.version === version ? previous.revision + 1 : 1);
  // The complete bundle has now passed symlink checks. Keep the installed
  // version/revision consistent with the feed, including same-version updates.
  const metadataPath = path.join(bundle, 'meta.json');
  let metadata = {};
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await json(metadataPath, { ...metadata, ...identity, releaseId: id, version, revision });
  const file = `${recipe.bundleName}.tgz`;
  await tar.c({ gzip: true, portable: true, mtime: new Date(0), cwd: candidate, file: path.join(candidate, file) }, [`${recipe.bundleName}.docset`]);
  const artifact = { file, sha256: await sha256(path.join(candidate, file)), bytes: (await stat(path.join(candidate, file))).size };
  const manifest = { schemaVersion: 2, id: recipe.id, ...identity, releaseId: id, fingerprint: id, upstreamVersion: version, version, revision, source, builder, artifact, validation: report, builtAt: new Date().toISOString() };
  await json(path.join(candidate, 'source-lock.json'), { schemaVersion: 1, ...identity, upstreamVersion: version, source, builder });
  if (baseUrl) {
    artifact.url = `${baseUrl.replace(/\/$/, '')}/artifacts/${recipe.variantId}/${id}/${file}`;
    await mkdir(path.join(candidate, 'feeds'));
    await writeFile(path.join(candidate, 'feeds', `${recipe.variantId}.xml`), makeFeed(version, artifact.url, revision));
  }
  await json(path.join(candidate, 'manifest.json'), manifest);
  const directory = path.join(work, 'releases', id);
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(candidate, directory);
  await saveCurrent(work, identity, manifest);
  return { status: 'built', fingerprint: id, directory };
}

function rejectRegression(previous, next, recipe) {
  if (!previous) return;
  const fraction = recipe.validation?.maxDropFraction ?? 0.1;
  if (typeof fraction !== 'number' || fraction < 0 || fraction > 1) throw new Error('Invalid maxDropFraction');
  for (const key of ['pageCount', 'symbolCount']) {
    if (previous[key] > 0 && next[key] < previous[key] * (1 - fraction)) throw new Error(`Validation regression: ${key} dropped from ${previous[key]} to ${next[key]}`);
  }
}
