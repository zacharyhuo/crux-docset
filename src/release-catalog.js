import { SHA256, fingerprint, recipeIdentity, assertVersionLine } from './identity.js';

const familyFields = ['sourceId', 'familyId', 'title', 'identifier', 'bundleName', 'defaultVariantId', 'latestReleaseId', 'releases'];
const releaseFields = ['releaseId', 'variantId', 'versionLine', 'language', 'version', 'revision', 'identifier', 'artifact', 'publishedAt', 'channel', 'support'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const familyKey = record => `${record.sourceId}/${record.familyId}`;

function text(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) throw new Error(`Invalid ${label}`);
}

function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`);
}

function validateFamily(family) {
  text(family.sourceId, 'source identity', /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
  text(family.familyId, 'family identity', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  text(family.title, 'family title');
  text(family.identifier, 'bundle identifier', /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/);
  text(family.bundleName, 'bundle name', /^[A-Za-z0-9_-]+$/);
}

function validateRelease(release, family) {
  if (!object(release)) throw new Error('Invalid release');
  const identity = { ...family, ...release, id: family.familyId, schemaVersion: 2 };
  recipeIdentity(identity);
  assertVersionLine(release.version, identity);
  if (release.identifier !== family.identifier) throw new Error('Release/family identifier mismatch');
  if (!SHA256.test(release.releaseId)) throw new Error('Invalid release identity');
  if (!Number.isSafeInteger(release.revision) || release.revision < 1) throw new Error('Invalid release revision');
  if (release.channel !== 'stable') throw new Error('Only stable channel releases are supported');
  if (!['supported', 'archived'].includes(release.support)) throw new Error('Invalid support state');
  const date = new Date(release.publishedAt);
  if (typeof release.publishedAt !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== release.publishedAt) throw new Error('Invalid publication timestamp');
  keys(release.artifact, ['url', 'sha256', 'bytes'], 'artifact');
  if (typeof release.artifact.url !== 'string' || release.artifact.url.length > 4096) throw new Error('Invalid artifact URL');
  const url = new URL(release.artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== release.artifact.url) throw new Error('Artifact URL must use canonical HTTPS without credentials, query or fragment');
  if (!SHA256.test(release.artifact.sha256)) throw new Error('Invalid artifact sha256');
  if (!Number.isSafeInteger(release.artifact.bytes) || release.artifact.bytes < 1) throw new Error('Invalid artifact bytes');
}

export function validatePublishedRecord(record) {
  if (!object(record) || record.status !== 'published') throw new Error('Expected a published record');
  validateFamily(record);
  validateRelease(record, record);
}

export function validateReleaseCatalog(catalog) {
  keys(catalog, ['schemaVersion', 'families'], 'catalog');
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.families)) throw new Error('Unsupported catalog schema');
  const families = new Set(), identifiers = new Set(), releaseIds = new Set(), revisions = new Set();
  for (const family of catalog.families) {
    keys(family, familyFields, 'family');
    validateFamily(family);
    const key = familyKey(family);
    if (families.has(key) || identifiers.has(family.identifier)) throw new Error('Duplicate family or installation identifier collision');
    families.add(key); identifiers.add(family.identifier);
    if (!Array.isArray(family.releases) || !family.releases.length) throw new Error('Family must contain published releases');
    for (const release of family.releases) {
      keys(release, releaseFields, 'release');
      validateRelease(release, family);
      if (releaseIds.has(release.releaseId)) throw new Error('Duplicate release identity');
      releaseIds.add(release.releaseId);
      const revisionKey = `${key}/${release.variantId}/${release.version}/${release.revision}`;
      if (revisions.has(revisionKey)) throw new Error('Duplicate release revision');
      revisions.add(revisionKey);
    }
    const latest = family.releases.find(release => release.releaseId === family.latestReleaseId);
    if (!latest || latest.variantId !== family.defaultVariantId || latest.support !== 'supported') throw new Error('Latest must reference a supported published release in the default variant');
  }
  return catalog;
}

export function makeReleaseCatalog(records, latestByFamily) {
  if (!Array.isArray(records) || !object(latestByFamily)) throw new Error('Invalid records or latest pointers');
  const groups = new Map(), seen = new Map();
  for (const record of records) {
    if (!object(record) || !['reserved', 'candidate', 'published', 'withdrawn'].includes(record.status)) throw new Error('Invalid publication status');
    if (record.status !== 'published') continue;
    validatePublishedRecord(record);
    const key = familyKey(record);
    const family = groups.get(key) ?? { sourceId: record.sourceId, familyId: record.familyId, title: record.title, identifier: record.identifier, bundleName: record.bundleName, releases: [] };
    if (['title', 'identifier', 'bundleName'].some(field => family[field] !== record[field])) throw new Error('Conflicting family identity or title');
    const release = Object.fromEntries(releaseFields.map(field => [field, structuredClone(record[field])]));
    const digest = fingerprint({ key, release });
    if (seen.has(release.releaseId)) {
      if (seen.get(release.releaseId) !== digest) throw new Error('Conflicting duplicate release identity');
      continue;
    }
    seen.set(release.releaseId, digest);
    family.releases.push(release);
    groups.set(key, family);
  }
  for (const key of Object.keys(latestByFamily)) if (!groups.has(key)) throw new Error(`Latest pointer has no published family: ${key}`);
  const families = [...groups.entries()].sort(([a], [b]) => ordinal(a, b)).map(([key, family]) => {
    const latestReleaseId = Object.hasOwn(latestByFamily, key) ? latestByFamily[key] : undefined;
    const latest = family.releases.find(release => release.releaseId === latestReleaseId);
    if (!latest) throw new Error(`Latest must reference an explicitly published release: ${key}`);
    const { releases, ...identity } = family;
    return { ...identity, defaultVariantId: latest.variantId, latestReleaseId, releases: releases.sort((a, b) => ordinal(a.releaseId, b.releaseId)) };
  });
  return validateReleaseCatalog({ schemaVersion: 1, families });
}
