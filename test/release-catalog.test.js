import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertVersionLine, rejectDowngrade } from '../src/identity.js';

const api = await import('../src/release-catalog.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const fixture = JSON.parse(await readFile(new URL('./fixtures/version-catalog/v1.json', import.meta.url)));
const family = fixture.families[0];
const records = family.releases.map(release => ({ sourceId: family.sourceId, familyId: family.familyId, title: family.title, bundleName: family.bundleName, ...release, status: 'published' }));
const latest = { 'dev.crux/python': family.latestReleaseId };
function make(input = records, pointers = latest) {
  assert.equal(typeof api.makeReleaseCatalog, 'function', 'release catalog generator must be implemented');
  return api.makeReleaseCatalog(input, pointers);
}

test('catalog round-trips the shared client contract without inferring latest from order', () => {
  assert.deepEqual(make(), fixture);
  assert.deepEqual(make([...records].reverse()), fixture);
  assert.equal(typeof api.validateReleaseCatalog, 'function');
  assert.doesNotThrow(() => api.validateReleaseCatalog(fixture));
  assert.equal(make().families[0].releases[1].revision, 2);
});

test('four-component stable Java updates survive the shared catalog without truncation', async () => {
  const java = JSON.parse(await readFile(new URL('./fixtures/version-catalog/java-v1.json', import.meta.url)));
  const f = java.families[0];
  const records = f.releases.map(release => ({ sourceId: f.sourceId, familyId: f.familyId, title: f.title, bundleName: f.bundleName, ...release, status: 'published' }));
  assert.deepEqual(api.makeReleaseCatalog(records, { 'dev.crux/java': f.latestReleaseId }), java);
  assertVersionLine('25.0.4.1', { versionLine: '25' });
  assert.doesNotThrow(() => rejectDowngrade('25.0.4', '25.0.4.1'));
  assert.doesNotThrow(() => rejectDowngrade('25.0.4.1', '25.0.5'));
  assert.throws(() => rejectDowngrade('25.0.4.1', '25.0.4'), /downgrade/i);
  assert.throws(() => rejectDowngrade('25.0.4.2', '25.0.4.1'), /downgrade/i);
  for (const version of ['25.0.4.1.1', '25.0.4.01', '25.0.4.1-ea']) assert.throws(() => assertVersionLine(version, { versionLine: '25' }));
});

test('candidate and withdrawn releases never become selectable', () => {
  const selected = make([{ ...records[0], support: 'supported' }, { ...records[1], status: 'candidate' }], { 'dev.crux/python': records[0].releaseId });
  assert.deepEqual(selected.families[0].releases.map(r => r.releaseId), [records[0].releaseId]);
  assert.deepEqual(make([{ ...records[0], status: 'withdrawn' }, records[1]]).families[0].releases.map(r => r.releaseId), [records[1].releaseId]);
  assert.throws(() => make([{ ...records[0], status: 'withdrawn' }, records[1]], { 'dev.crux/python': records[0].releaseId }), /latest|published/i);
});

test('latest references must be explicit, stable, supported, and in the same family', () => {
  assert.throws(() => make(records, {}), /latest/i);
  assert.throws(() => make(records, { 'dev.crux/python': 'f'.repeat(64) }), /latest/i);
  assert.throws(() => make(records, { ...latest, 'dev.crux/java': records[1].releaseId }), /latest|family/i);
  assert.throws(() => make([records[0], { ...records[1], support: 'archived' }]), /support|latest/i);
  assert.throws(() => make([records[0], { ...records[1], channel: 'preview' }]), /stable|channel/i);
});

test('duplicate input is idempotent but conflicts and revision collisions are rejected', () => {
  assert.deepEqual(make([...records, records[0]]), fixture);
  assert.throws(() => make([...records, { ...records[0], artifact: { ...records[0].artifact, bytes: 999 } }]), /conflict|duplicate/i);
  assert.throws(() => make([...records, { ...records[0], releaseId: '3'.repeat(64) }]), /revision|duplicate/i);
});

test('catalog rejects insecure URLs, invalid checksums, sizes and ambiguous version data', () => {
  for (const change of [
    { url: 'http://example.invalid/a.tgz' }, { url: 'https://user:password@example.invalid/a.tgz' },
    { url: 'https://example.invalid/a.tgz?token=temporary' }, { url: 'https://example.invalid/a.tgz#fragment' },
    { sha256: 'invalid' }, { sha256: 'A'.repeat(64) }, { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) assert.throws(() => make([{ ...records[0], artifact: { ...records[0].artifact, ...change } }, records[1]]), /artifact|HTTPS|sha|bytes|URL/i);
  for (const change of [
    { revision: 0 }, { revision: 1.5 }, { version: '3.15.0' }, { language: 'zh' },
    { variantId: '../other' }, { releaseId: 'short' }, { publishedAt: 'yesterday' },
    { publishedAt: '2026-02-30T00:00:00.000Z' }, { identifier: 'different.python' }
  ]) assert.throws(() => make([{ ...records[0], ...change }, records[1]]));
});

test('family and installation identifiers cannot collide across sources or families', () => {
  const foreign = { ...records[0], familyId: 'other', variantId: 'other-3-13-en', releaseId: '4'.repeat(64), support: 'supported' };
  assert.throws(() => make([...records, foreign], { ...latest, 'dev.crux/other': foreign.releaseId }), /identifier|identity|collision/i);
  const otherSource = { ...records[1], sourceId: 'another.source', releaseId: '5'.repeat(64), identifier: 'another.python' };
  const result = make([...records, otherSource], { ...latest, 'another.source/python': otherSource.releaseId });
  assert.equal(result.families.length, 2);
  assert.equal(result.families[0].sourceId, 'another.source');
});

test('strict reader rejects forged latest pointers, identity mismatches and duplicate catalog rows', () => {
  make(); // Assert implementation availability before invoking the reader.
  for (const change of [
    c => { c.schemaVersion = 99; },
    c => { c.families.push(c.families[0]); },
    c => { c.families[0].releases.push(c.families[0].releases[0]); },
    c => { c.families[0].latestReleaseId = 'f'.repeat(64); },
    c => { c.families[0].defaultVariantId = 'python-3-13-en'; },
    c => { c.families[0].releases[0].identifier = 'evil.other'; },
    c => { c.families[0].releases[0].status = 'withdrawn'; }
  ]) {
    const copy = structuredClone(fixture);
    change(copy);
    assert.throws(() => api.validateReleaseCatalog(copy));
  }
});

test('catalog generation neither mutates inputs nor exposes publication bookkeeping', () => {
  const input = structuredClone(records), pointers = structuredClone(latest);
  const result = make(input, pointers);
  assert.deepEqual(input, records);
  assert.deepEqual(pointers, latest);
  for (const release of result.families[0].releases) {
    assert.equal(release.status, undefined);
    assert.equal(release.sourceId, undefined);
    assert.equal(release.familyId, undefined);
  }
  result.families[0].releases[0].artifact.bytes = 999;
  assert.equal(input[0].artifact.bytes, 12345);
});
