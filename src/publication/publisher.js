import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, regularPath } from '../build-state.js';
import { fingerprint, rejectDowngrade } from '../identity.js';
import { familyKey } from '../release-catalog.js';
import { readPublishedState, recordPublished, writePublishedCatalog } from '../published-store.js';
import { makeFeed } from '../pipeline.js';
import { qualifyCandidate, readJSON } from './verify.js';
import { publicationBranch, verifyResponse } from './github.js';

const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const digest = data => createHash('sha256').update(data).digest('hex');

export async function restorePublication(directory, github) {
  await mkdir(directory, { recursive: true });
  await regularPath(directory, true);
  if ((await readdir(directory)).length) throw new Error('Restore requires an empty publication directory');
  const snapshot = await github.snapshot();
  await atomicJSON(path.join(directory, 'state.json'), snapshot.state);
  await readPublishedState(directory); // Validate before letting the builder allocate revisions.
  await atomicJSON(path.join(directory, 'remote.json'), { repository: github.repository, head: snapshot.head });
  return { head: snapshot.head, records: snapshot.state.records.length, branch: publicationBranch };
}

const order = (a, b) => {
  const x = a.version.split('.').map(Number), y = b.version.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.revision - b.revision;
};

function catalogFiles(state) {
  const files = { 'state.json': state, 'catalog.json': state.catalog };
  for (const family of state.catalog.families) {
    const latest = family.releases.find(r => r.releaseId === family.latestReleaseId);
    files[`feeds/${family.familyId}.xml`] = makeFeed(latest.version, latest.artifact.url, latest.revision);
    for (const variant of new Set(family.releases.map(r => r.variantId))) {
      const release = family.releases.filter(r => r.variantId === variant).sort(order).at(-1);
      files[`feeds/${variant}.xml`] = makeFeed(release.version, release.artifact.url, release.revision);
    }
  }
  return files;
}

export async function publishCandidate({ directory, publication, recipe, icons, policy, builderDigest, sourceCommit, github }) {
  const remote = await readJSON(path.join(publication, 'remote.json'));
  if (remote.repository !== github.repository) throw new Error('Publication snapshot belongs to another repository');
  const snapshot = await github.snapshot();
  let state = await readPublishedState(publication);
  const qualified = await qualifyCandidate({ directory, recipe, icons, policy, builderDigest });
  const { manifest: m, archive, qualification, report } = qualified;
  const reservation = state.reservations.find(r => r.releaseId === m.releaseId);
  if (!reservation || reservation.revision !== m.revision) throw new Error('Candidate has no matching durable revision reservation');
  const expectedSeed = { sourceId: m.sourceId, familyId: m.familyId, variantId: m.variantId, versionLine: m.versionLine,
    language: m.language, identifier: m.identifier, bundleName: m.bundleName, version: m.version, releaseId: m.releaseId, revision: m.revision };
  if (fingerprint(reservation) !== fingerprint(expectedSeed)) throw new Error('Reservation identity mismatch');
  if (snapshot.head !== remote.head) {
    // A publish-only job rerun downloads the original promotion artifact. It
    // may predate our own durable reservation or completed catalog commit.
    // Reconcile only an exact reservation for these independently verified bytes;
    // an unrelated branch advance still requires a fresh build snapshot.
    const durable = snapshot.state.reservations.find(r => r.releaseId === m.releaseId);
    if (!durable || fingerprint(durable) !== fingerprint(expectedSeed)) throw new Error('Publication state changed; rerun from a fresh snapshot');
    await atomicJSON(path.join(publication, 'state.json'), snapshot.state);
    state = await readPublishedState(publication);
    await atomicJSON(path.join(publication, 'remote.json'), { repository: github.repository, head: snapshot.head });
  }
  if (fingerprint(state.records) !== fingerprint(snapshot.state.records) || fingerprint(state.catalog) !== fingerprint(snapshot.state.catalog)) throw new Error('Local publication records differ from durable state');
  const existing = state.records.find(r => r.releaseId === m.releaseId);
  if (existing?.status === 'withdrawn') throw new Error('A withdrawn release cannot be republished');
  const originalReservation = snapshot.state.reservations.find(r => r.releaseId === m.releaseId);
  const expectedReservations = originalReservation ? snapshot.state.reservations : [...snapshot.state.reservations, reservation];
  if (fingerprint(state.reservations) !== fingerprint(expectedReservations)) throw new Error('Unrelated reservation changes cannot be published');
  if (!originalReservation) {
    const sameVersion = snapshot.state.reservations.filter(r => familyKey(r) === familyKey(m) && r.variantId === m.variantId && r.version === m.version);
    if (m.revision !== Math.max(0, ...sameVersion.map(r => r.revision)) + 1) throw new Error('Revision does not follow durable reservation history');
  }
  const previous = state.records.filter(r => familyKey(r) === familyKey(m) && r.variantId === m.variantId).sort(order).at(-1);
  if (m.variantId !== policy.defaultVariantId && !state.catalog?.families.some(f => familyKey(f) === familyKey(m))) throw new Error('Publish the reviewed default variant before historical variants');
  if (!existing && previous) {
    rejectDowngrade(previous.version, m.version);
    if (previous.version === m.version && previous.revision >= m.revision) throw new Error('Automatic revision rollback rejected');
    const evidence = await github.readJSON(snapshot.head, `qualifications/${previous.releaseId}.json`);
    if (evidence.releaseId !== previous.releaseId || evidence.artifact.sha256 !== previous.artifact.sha256 || evidence.passed !== true
        || evidence.validationDigest !== fingerprint(evidence.report)) throw new Error('Invalid durable baseline evidence');
    for (const field of ['pageCount', 'symbolCount']) if (report[field] < evidence.report[field] * (1 - (recipe.validation.maxDropFraction ?? 0.1))) throw new Error(`Publication validation regression: ${field}`);
  }
  await github.checkMainCommit(sourceCommit);

  let head = snapshot.head;
  const saveRemote = async () => atomicJSON(path.join(publication, 'remote.json'), { repository: github.repository, head });
  if (!originalReservation) {
    // Persist allocation before any upload. A failure consumes a revision but
    // never creates a duplicate or discards the last published catalog.
    head = await github.commit(head, { 'state.json': state }, `Reserve ${m.variantId} ${m.version} r${m.revision}`);
    await saveRemote();
  }
  const tag = `docset-${m.variantId}-${m.version}-r${m.revision}-${m.releaseId}`;
  let release = await github.release(tag, sourceCommit, `${recipe.name} ${m.version} r${m.revision}`, m.releaseId);
  const url = `https://github.com/${github.repository}/releases/download/${tag}/${m.artifact.file}`;
  const artifacts = [
    { name: m.artifact.file, file: archive, sha256: m.artifact.sha256, bytes: m.artifact.bytes },
    // Build time is intentionally omitted from immutable evidence so a cold
    // rebuild can recover a partial upload of the same deterministic archive.
    ...Object.entries({ 'manifest.json': { ...m, builtAt: undefined }, 'validation.json': report,
      'source-lock.json': await readJSON(path.join(directory, 'source-lock.json')), 'qualification.json': { ...qualification, report } })
      .map(([name, value]) => { const data = encode(value); return { name, data, bytes: data.length, sha256: digest(data) }; })
  ];
  const assets = await github.assets(release);
  let archiveAsset;
  for (const artifact of artifacts) {
    const matches = assets.filter(a => a.name === artifact.name);
    if (matches.length > 1) throw new Error('Duplicate release assets');
    let asset = matches[0];
    if (asset && release.draft && asset.state === 'starter' && asset.size === 0 && Number.isSafeInteger(asset.id)) {
      // GitHub's failed-upload residue contains no uploaded bytes. Only remove
      // this exact empty placeholder in our matching draft, never a real asset.
      await github.request(`/releases/assets/${asset.id}`, { method: 'DELETE' });
      asset = undefined;
    }
    if (!asset) {
      if (!release.draft) throw new Error('Published release is incomplete; never modify its assets');
      asset = await github.upload(release, artifact.name, artifact);
    }
    if (asset.state !== 'uploaded' || asset.size !== artifact.bytes || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)) throw new Error('Immutable release asset conflict');
    await verifyResponse(await github.assetResponse(asset), artifact);
    if (artifact.file) archiveAsset = asset;
  }
  if (release.draft) release = await github.request(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } });
  // Public repositories also prove that a credential-free client can fetch the
  // advertised URL. Private development still verifies the uploaded API bytes.
  if (!snapshot.private) await verifyResponse(await github.publicResponse(url), m.artifact);
  const record = { ...expectedSeed, title: recipe.name, artifact: { url, sha256: m.artifact.sha256, bytes: m.artifact.bytes },
    publishedAt: new Date(release.published_at).toISOString(), channel: 'stable', support: 'supported', status: 'published' };
  await recordPublished(publication, record, { fetcher: () => github.assetResponse(archiveAsset) });
  if (existing) return { status: 'unchanged', releaseId: m.releaseId, url, branch: publicationBranch };
  const latest = Object.fromEntries((state.catalog?.families ?? []).map(f => [familyKey(f), f.latestReleaseId]));
  if (m.variantId === policy.defaultVariantId) latest[familyKey(m)] = m.releaseId;
  if (!latest[familyKey(m)]) throw new Error('Publish the reviewed default variant before historical variants');
  await writePublishedCatalog(publication, latest);
  const activated = await readPublishedState(publication);
  const files = { ...catalogFiles(activated), [`qualifications/${m.releaseId}.json`]: { ...qualification, report } };
  head = await github.commit(head, files, `Publish ${m.variantId} ${m.version} r${m.revision}`);
  await saveRemote();
  return { status: 'published', releaseId: m.releaseId, url, branch: publicationBranch, commit: head,
    catalogURL: `https://raw.githubusercontent.com/${github.repository}/${publicationBranch}/catalog.json`,
    publicDownloadVerified: !snapshot.private };
}
