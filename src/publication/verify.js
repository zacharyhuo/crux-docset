import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { regularPath } from '../build-state.js';
import { assertIdentity, assertVersionLine, fingerprint, recipeIdentity, sha256, SHA256 } from '../identity.js';
import { safeArchivePath } from '../pipeline.js';
import { validate } from '../validate.js';

export async function readJSON(file, maximum = 4 * 1024 * 1024) {
  if ((await regularPath(file)).size > maximum) throw new Error('Publication JSON size limit exceeded');
  return JSON.parse(await readFile(file, 'utf8'));
}

// Pins the effective recipe and its artwork, not a mutable upstream patch version.
// Updating source/build/validation/attribution rules requires reviewing this pin.
export const policyDigest = (recipe, icons) => fingerprint({ recipe, icons });

export function checkPolicy(policy, recipe, icons) {
  if (policy?.schemaVersion !== 1 || policy.familyId !== recipe.familyId || policy.sourceId !== recipe.sourceId
      || !Object.hasOwn(policy.variants ?? {}, policy.defaultVariantId)
      || policy.variants?.[recipe.variantId] !== policyDigest(recipe, icons)) {
    throw new Error('Recipe or icon publication policy changed; review the policy pin');
  }
}

export async function unpackCandidate(archive, destination, recipe) {
  const seen = new Set();
  let files = 0, bytes = 0, invalid;
  // Complete inspection before extraction: no links, duplicate names, extra roots,
  // device entries or oversized expansion. Extraction uses a freshly allocated tree.
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    try {
      const name = safeArchivePath(entry.path).replace(/\/$/, '');
      if (name !== `${recipe.bundleName}.docset` && !name.startsWith(`${recipe.bundleName}.docset/`)) throw new Error('Unexpected archive root');
      if (!['File', 'Directory'].includes(entry.type)) throw new Error('Archive links or special entries rejected');
      if (name.split('/').length > 128 || seen.has(name.toLowerCase())) throw new Error('Archive duplicate path or depth limit exceeded');
      seen.add(name.toLowerCase());
      if (++files > (recipe.limits?.maxFiles ?? 100_000) || (bytes += entry.size) > (recipe.limits?.maxBytes ?? 1024 ** 3)) throw new Error('Archive expansion limit exceeded');
    } catch (error) { invalid ??= error; }
  } });
  if (invalid) throw invalid;
  if (!seen.size) throw new Error('Empty candidate archive');
  await mkdir(destination);
  await tar.x({ file: archive, cwd: destination, strict: true, noChmod: true });
  return path.join(destination, `${recipe.bundleName}.docset`);
}

// Validate the bytes inside the archive, never a sibling bundle or a cached "passed" flag.
export async function qualifyCandidate({ directory, recipe, icons, policy, builderDigest }) {
  await regularPath(directory, true);
  checkPolicy(policy, recipe, icons);
  const manifest = await readJSON(path.join(directory, 'manifest.json'));
  const sourceLock = await readJSON(path.join(directory, 'source-lock.json'));
  const savedReport = await readJSON(path.join(directory, 'validation.json'));
  const identity = recipeIdentity(recipe);
  assertIdentity(manifest, identity);
  assertIdentity(sourceLock, identity);
  assertVersionLine(manifest.version, recipe);
  const id = fingerprint({ source: manifest.source, recipe, builder: manifest.builder });
  if (manifest.schemaVersion !== 2 || manifest.id !== recipe.id || !SHA256.test(manifest.releaseId)
      || manifest.releaseId !== id || manifest.fingerprint !== id || manifest.upstreamVersion !== manifest.version
      || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1
      || manifest.builder?.digest !== builderDigest || manifest.builder?.releaseAuthority !== 'durable-publication'
      || sourceLock.schemaVersion !== 1 || sourceLock.upstreamVersion !== manifest.version
      || fingerprint(sourceLock.source) !== fingerprint(manifest.source) || fingerprint(sourceLock.builder) !== fingerprint(manifest.builder)
      || fingerprint(manifest.validation) !== fingerprint(savedReport) || savedReport.passed !== true) {
    throw new Error('Candidate identity, build inputs or validation binding mismatch');
  }
  // This first publisher is deliberately bounded to official Python HTML archives.
  const source = new URL(manifest.source?.url);
  if (recipe.builder.adapter !== 'python-intersphinx' || source.protocol !== 'https:' || source.hostname !== 'docs.python.org'
      || source.port || source.username || source.password || source.search || source.hash
      || ![manifest.version, recipe.versionLine].some(version => source.pathname.endsWith(`/python-${version}-docs-html.zip`))
      || !SHA256.test(manifest.source.sha256)) throw new Error('Unapproved publication source');
  const artifact = manifest.artifact;
  if (artifact?.file !== `${recipe.bundleName}.tgz` || !SHA256.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 2 * 1024 ** 3 || artifact.url !== undefined) {
    throw new Error('Invalid candidate archive metadata');
  }
  const archive = path.join(directory, artifact.file);
  if ((await regularPath(archive)).size !== artifact.bytes || await sha256(archive) !== artifact.sha256) throw new Error('Candidate archive checksum or size mismatch');
  const scratch = await mkdtemp(path.join(tmpdir(), 'crux-publication-'));
  try {
    const bundle = await unpackCandidate(archive, path.join(scratch, 'unpacked'), recipe);
    const metadata = await readJSON(path.join(bundle, 'meta.json'));
    assertIdentity(metadata, identity);
    if (metadata.releaseId !== id || metadata.version !== manifest.version || metadata.revision !== manifest.revision) throw new Error('Archive metadata does not match candidate manifest');
    for (const [name, bytes] of Object.entries(icons)) {
      await regularPath(path.join(bundle, name));
      if (!(await readFile(path.join(bundle, name))).equals(bytes)) throw new Error('Archive artwork differs from reviewed recipe');
    }
    for (const name of recipe.compliance?.retain ?? []) {
      safeArchivePath(name);
      await regularPath(path.join(bundle, 'Contents/Resources/Documents', name));
    }
    const report = await validate(bundle, recipe);
    if (!report.passed || fingerprint(report) !== fingerprint(savedReport)) throw new Error('Independent archive validation failed or differs from candidate report');
    return { manifest, archive, report, qualification: {
      schemaVersion: 1, releaseId: id, version: manifest.version, revision: manifest.revision,
      artifact: { sha256: artifact.sha256, bytes: artifact.bytes },
      recipePolicy: policyDigest(recipe, icons), builderDigest,
      validationDigest: fingerprint(report), sourceLockDigest: fingerprint(sourceLock), passed: true
    } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
