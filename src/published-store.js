import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicJSON, regularPath } from './build-state.js';
import { SHA256, fingerprint, recipeIdentity, assertVersionLine } from './identity.js';
import { familyKey, makeReleaseCatalog, validatePublishedRecord, validateReleaseCatalog } from './release-catalog.js';

const seedFields = ['sourceId', 'familyId', 'variantId', 'versionLine', 'language', 'identifier', 'bundleName', 'version', 'releaseId'];
const recordFields = [...seedFields, 'title', 'revision', 'artifact', 'publishedAt', 'channel', 'support', 'status'];
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, structuredClone(value[key])]));
const emptyState = () => ({ schemaVersion: 1, reservations: [], records: [], catalog: null });

function seed(input) {
  const value = pick(input, seedFields);
  recipeIdentity({ ...value, schemaVersion: 2, id: value.familyId });
  assertVersionLine(value.version, value);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.sourceId) || !SHA256.test(value.releaseId)) throw new Error('Invalid publication reservation identity');
  return value;
}

function sameReservation(record, reservation) {
  return fingerprint(seed(record)) === fingerprint(seed(reservation)) && record.revision === reservation.revision;
}

async function readState(directory) {
  await regularPath(directory, true);
  const file = path.join(directory, 'state.json');
  let state;
  try {
    if ((await regularPath(file)).size > 8 * 1024 * 1024) throw new Error('Publication state exceeds size limit');
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(directory)).some(name => name !== 'publication.lock')) throw new Error('Cannot adopt nonempty unowned publication directory');
    return emptyState();
  }
  if (state?.schemaVersion !== 1 || !Array.isArray(state.reservations) || !Array.isArray(state.records)) throw new Error('Unsupported publication state schema');
  const ids = new Set(), revisions = new Set();
  for (const reservation of state.reservations) {
    seed(reservation);
    if (!Number.isSafeInteger(reservation.revision) || reservation.revision < 1) throw new Error('Invalid reserved revision');
    const key = `${familyKey(reservation)}/${reservation.variantId}/${reservation.version}/${reservation.revision}`;
    if (ids.has(reservation.releaseId) || revisions.has(key)) throw new Error('Duplicate publication reservation');
    ids.add(reservation.releaseId); revisions.add(key);
  }
  const publishedIds = new Set();
  for (const record of state.records) {
    if (!['published', 'withdrawn'].includes(record.status)) throw new Error('Invalid stored publication status');
    validatePublishedRecord({ ...record, status: 'published' });
    const reservation = state.reservations.find(r => r.releaseId === record.releaseId);
    if (!reservation || !sameReservation(record, reservation) || publishedIds.has(record.releaseId)) throw new Error('Invalid stored reservation or duplicate record');
    publishedIds.add(record.releaseId);
  }
  if (state.catalog !== null) {
    validateReleaseCatalog(state.catalog);
    for (const family of state.catalog.families) for (const release of family.releases) {
      const record = state.records.find(r => r.releaseId === release.releaseId);
      const comparable = ['title', 'artifact', 'publishedAt', 'channel', 'support'];
      const catalogRecord = { ...family, ...release };
      if (!record || record.status !== 'published' || !sameReservation(catalogRecord, record) || fingerprint(pick(catalogRecord, comparable)) !== fingerprint(pick(record, comparable))) throw new Error('Stored catalog does not match published records');
    }
  }
  return state;
}

async function withStore(directory, operation) {
  await mkdir(directory, { recursive: true });
  await regularPath(directory, true);
  const release = await lockfile.lock(directory, { lockfilePath: path.join(directory, 'publication.lock'), stale: 120_000, update: 10_000, retries: { retries: 8, minTimeout: 10, maxTimeout: 100 } });
  try { return await operation(await readState(directory)); }
  finally { await release(); }
}

// Keep this directory on durable publisher storage, not an Actions cache. The store
// serializes one writer; it is not a distributed lock across independent copies.
export async function reserveRevision(directory, input, { minimumRevision = 1 } = {}) {
  const identity = seed(input);
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1) throw new Error('Invalid minimum revision');
  return withStore(directory, async state => {
    const existing = state.reservations.find(r => r.releaseId === identity.releaseId);
    if (existing) {
      if (fingerprint(seed(existing)) !== fingerprint(identity)) throw new Error('Immutable reservation identity conflict');
      return existing.revision;
    }
    const sameVersion = state.reservations.filter(r => familyKey(r) === familyKey(identity) && r.variantId === identity.variantId && r.version === identity.version);
    const revision = Math.max(minimumRevision, sameVersion.reduce((max, record) => Math.max(max, record.revision), 0) + 1);
    if (!Number.isSafeInteger(revision)) throw new Error('Revision space exhausted');
    state.reservations.push({ ...identity, revision });
    await atomicJSON(path.join(directory, 'state.json'), state);
    return revision;
  });
}

async function verifyArtifact(artifact, fetcher) {
  if (artifact.bytes > 2 * 1024 ** 3) throw new Error('Artifact exceeds publisher readback size limit');
  const response = await fetcher(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Artifact readback HTTP ${response.status}`);
  if (!response.body) throw new Error('Artifact readback has no bytes');
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== artifact.bytes) throw new Error('Artifact readback size mismatch');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > artifact.bytes) throw new Error('Artifact readback size limit exceeded');
    hash.update(chunk);
  }
  if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error('Artifact readback checksum or size mismatch');
}

// Call only after independent bundle validation and immutable upload. This function
// verifies the uploaded bytes; it neither uploads nor infers publication from a URL.
export async function recordPublished(directory, input, { fetcher = fetch } = {}) {
  validatePublishedRecord(input);
  const record = pick(input, recordFields);
  return withStore(directory, async state => {
    const existing = state.records.find(r => r.releaseId === record.releaseId);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(record)) throw new Error('Immutable published record conflict (including withdrawn releases)');
      return { status: 'unchanged', record: structuredClone(existing) };
    }
    const reservation = state.reservations.find(r => r.releaseId === record.releaseId);
    if (!reservation || !sameReservation(record, reservation)) throw new Error('Published release does not match its durable revision reservation');
    await verifyArtifact(record.artifact, fetcher);
    state.records.push(record);
    await atomicJSON(path.join(directory, 'state.json'), state);
    return { status: 'published', record: structuredClone(record) };
  });
}

async function saveCatalog(directory, state, catalog) {
  // State contains the intended complete catalog. If interrupted between the two
  // renames, recoverPublishedCatalog repeats only the final materialization.
  state.catalog = catalog;
  await atomicJSON(path.join(directory, 'state.json'), state);
  await atomicJSON(path.join(directory, 'catalog.json'), catalog);
  return catalog;
}

export async function writePublishedCatalog(directory, latestByFamily) {
  return withStore(directory, async state => saveCatalog(directory, state, makeReleaseCatalog(state.records, latestByFamily)));
}

export async function withdrawPublishedRelease(directory, releaseId, latestByFamily) {
  return withStore(directory, async state => {
    const record = state.records.find(r => r.releaseId === releaseId);
    if (!record) throw new Error('Unknown published release');
    record.status = 'withdrawn';
    return saveCatalog(directory, state, makeReleaseCatalog(state.records, latestByFamily));
  });
}

export async function recoverPublishedCatalog(directory) {
  return withStore(directory, async state => {
    if (state.catalog) await atomicJSON(path.join(directory, 'catalog.json'), state.catalog);
    return state.catalog;
  });
}

export async function readPublishedState(directory) {
  return structuredClone(await readState(directory));
}
