import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import * as tar from 'tar';
import lockfile from 'proper-lockfile';

export function discoverPython(html, base) {
  const $ = load(html);
  const href = $('a[href]').toArray().map(el => $(el).attr('href')).find(h => /python-[\d.]+-docs-html\.zip$/.test(h));
  if (!href) throw new Error('Official HTML archive not found');
  const url = new URL(href, base);
  if (url.protocol !== 'https:' || url.hostname !== 'docs.python.org' || url.username || url.password) throw new Error('Unexpected source host');
  return url.href;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function fingerprint(input) {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
export async function buildCandidate({ work, recipe, source, builder, build, validate, baseUrl }) {
  if (!/^[a-z0-9-]+$/.test(recipe.id) || !/^[A-Za-z0-9_-]+$/.test(recipe.bundleName)) throw new Error('Invalid recipe identifiers');
  await mkdir(work, { recursive: true });
  // A heartbeat lease allows recovery after SIGKILL/restart; a live competing
  // builder fails immediately. Compromised leases abort through the library.
  const release = await lockfile.lock(work, { lockfilePath: path.join(work, 'build.lock'), stale: 120_000, update: 10_000, retries: 0 });
  try {
    return await buildLocked({ work, recipe, source, builder, build, validate, baseUrl });
  } finally {
    await release();
  }
}

async function buildLocked({ work, recipe, source, builder, build, validate, baseUrl }) {
  const id = fingerprint({ source, recipe, builder, baseUrl });
  const statePath = path.join(work, 'current.json');
  let previous;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let baseline;
  if (previous) {
    if (!/^[0-9a-f]{64}$/.test(previous.fingerprint) || !Number.isSafeInteger(previous.revision) || previous.revision < 1) throw new Error('Invalid local state');
    baseline = JSON.parse(await readFile(path.join(work, 'releases', previous.fingerprint, 'manifest.json'), 'utf8'));
  }
  if (previous?.fingerprint === id) {
    const dir = path.join(work, 'releases', id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (await sha256(path.join(dir, manifest.artifact.file)) !== manifest.artifact.sha256) throw new Error('Cached artifact checksum mismatch');
    return { status: 'unchanged', fingerprint: id, directory: dir };
  }
  const existing = path.join(work, 'releases', id);
  let recovered;
  try { recovered = JSON.parse(await readFile(path.join(existing, 'manifest.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (recovered) {
    rejectDowngrade(previous?.version, recovered.version);
    rejectRegression(baseline?.validation, recovered.validation, recipe);
    if (recovered.fingerprint !== id || recovered.artifact.file !== `${recipe.bundleName}.tgz` || !recovered.validation.passed || await sha256(path.join(existing, recovered.artifact.file)) !== recovered.artifact.sha256) throw new Error('Invalid recovery candidate');
    if (previous && previous.version === recovered.version && previous.revision >= recovered.revision) throw new Error('Previously released fingerprint reappeared; manual rollback review required');
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await json(temporary, { schemaVersion: 1, fingerprint: id, version: recovered.version, revision: recovered.revision });
    await rename(temporary, statePath);
    return { status: 'recovered', fingerprint: id, directory: existing };
  }
  const candidate = path.join(work, 'quarantine', randomUUID());
  await mkdir(candidate, { recursive: true });
  const { version } = await build(candidate);
  if (!/^\d+\.\d+\.\d+(?:[a-z0-9.-]+)?$/.test(version)) throw new Error('Invalid document version');
  rejectDowngrade(previous?.version, version);
  const bundle = path.join(candidate, `${recipe.bundleName}.docset`);
  const report = await validate(bundle, recipe);
  await json(path.join(candidate, 'validation.json'), report);
  if (!report.passed) throw new Error(`Validation failed; report: ${candidate}/validation.json`);
  rejectRegression(baseline?.validation, report, recipe);
  const revision = previous?.version === version ? previous.revision + 1 : 1;
  // The complete bundle has now passed symlink checks. Keep the installed
  // version/revision consistent with the feed, including same-version updates.
  const metadataPath = path.join(bundle, 'meta.json');
  let metadata = {};
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await json(metadataPath, { ...metadata, version, revision });
  const file = `${recipe.bundleName}.tgz`;
  await tar.c({ gzip: true, portable: true, mtime: new Date(0), cwd: candidate, file: path.join(candidate, file) }, [`${recipe.bundleName}.docset`]);
  const artifact = { file, sha256: await sha256(path.join(candidate, file)), bytes: (await stat(path.join(candidate, file))).size };
  const manifest = { schemaVersion: 1, id: recipe.id, fingerprint: id, version, revision, source, builder, artifact, validation: report, builtAt: new Date().toISOString() };
  if (baseUrl) {
    artifact.url = `${baseUrl.replace(/\/$/, '')}/${recipe.id}-${id}/${file}`;
    await writeFile(path.join(candidate, `${recipe.id}.xml`), makeFeed(version, artifact.url, revision));
  }
  await json(path.join(candidate, 'manifest.json'), manifest);
  const directory = path.join(work, 'releases', id);
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(candidate, directory);
  const temporaryState = `${statePath}.${randomUUID()}.tmp`;
  await json(temporaryState, { schemaVersion: 1, fingerprint: id, version, revision });
  await rename(temporaryState, statePath);
  return { status: 'built', fingerprint: id, directory };
}

function rejectDowngrade(previous, next) {
  if (!/^\d+\.\d+\.\d+$/.test(next) || (previous && !/^\d+\.\d+\.\d+$/.test(previous))) throw new Error('Only stable numeric document versions are supported');
  if (!previous) return;
  const a = previous.split('.').map(Number), b = next.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] < a[i]) throw new Error(`Automatic downgrade rejected: ${previous} -> ${next}`);
    if (b[i] > a[i]) return;
  }
}

function rejectRegression(previous, next, recipe) {
  if (!previous) return;
  const fraction = recipe.validation?.maxDropFraction ?? 0.1;
  if (typeof fraction !== 'number' || fraction < 0 || fraction > 1) throw new Error('Invalid maxDropFraction');
  for (const key of ['pageCount', 'symbolCount']) {
    if (previous[key] > 0 && next[key] < previous[key] * (1 - fraction)) throw new Error(`Validation regression: ${key} dropped from ${previous[key]} to ${next[key]}`);
  }
}
