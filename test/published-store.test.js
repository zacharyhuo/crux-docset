import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const api = await import('../src/published-store.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const payload = Buffer.from('verified artifact');
const sha256 = createHash('sha256').update(payload).digest('hex');
const base = { sourceId: 'dev.crux', familyId: 'python', title: 'Python', variantId: 'python-3-14-en', versionLine: '3.14', language: 'en', identifier: 'dev.crux.python', bundleName: 'Python', releaseId: 'a'.repeat(64), version: '3.14.7', revision: 1, artifact: { url: 'https://example.invalid/a.tgz', sha256, bytes: payload.length }, publishedAt: '2026-09-27T00:00:00.000Z', channel: 'stable', support: 'supported', status: 'published' };
const fetcher = async () => new Response(payload);
async function fixture(t) {
  assert.equal(typeof api.reserveRevision, 'function', 'durable revision reservation must be implemented');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-published-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function publish(root, record = base) {
  const revision = await api.reserveRevision(root, record);
  const published = { ...record, revision };
  await api.recordPublished(root, published, { fetcher });
  return published;
}

test('revision reservation survives restarts, deduplicates inputs and scopes numbering per variant/version', async t => {
  const root = await fixture(t);
  assert.equal(await api.reserveRevision(root, base), 1);
  assert.equal(await api.reserveRevision(root, base), 1);
  assert.equal(await api.reserveRevision(root, { ...base, releaseId: 'b'.repeat(64) }), 2);
  assert.equal(await api.reserveRevision(root, { ...base, releaseId: 'c'.repeat(64), version: '3.14.8' }), 1);
  assert.equal(await api.reserveRevision(root, { ...base, releaseId: 'd'.repeat(64), variantId: 'python-3-13-en', versionLine: '3.13', version: '3.13.9' }), 1);
  const state = await api.readPublishedState(root);
  assert.equal(state.reservations.length, 4);
  assert.equal(state.records.length, 0, 'reservations are never publications');
});

test('concurrent reservations do not allocate the same revision to different inputs', async t => {
  const root = await fixture(t);
  const numbers = await Promise.all(['a', 'b', 'c'].map(char => api.reserveRevision(root, { ...base, releaseId: char.repeat(64) })));
  assert.deepEqual(numbers.sort(), [1, 2, 3]);
  assert.equal((await api.readPublishedState(root)).reservations.length, 3);
});

test('publication requires a reservation and successful HTTPS checksum/size readback', async t => {
  const root = await fixture(t);
  await assert.rejects(api.recordPublished(root, base, { fetcher }), /reservation/i);
  await api.reserveRevision(root, base);
  for (const bad of [async () => new Response('bad'), async () => new Response(Buffer.alloc(payload.length)), async () => new Response(payload, { status: 404 }), async () => new Response(Buffer.concat([payload, payload]))]) {
    await assert.rejects(api.recordPublished(root, base, { fetcher: bad }), /checksum|size|HTTP|bytes/i);
    assert.equal((await api.readPublishedState(root)).records.length, 0);
  }
  let policy;
  await api.recordPublished(root, base, { fetcher: async (url, options) => { assert.equal(url, base.artifact.url); policy = options.redirect; return new Response(payload); } });
  assert.equal(policy, 'error');
  assert.equal((await api.readPublishedState(root)).records.length, 1);
  await assert.rejects(readFile(path.join(root, 'catalog.json')), { code: 'ENOENT' });
});

test('revision reservations honor an existing local baseline without reassigning previous inputs', async t => {
  const root = await fixture(t);
  assert.equal(await api.reserveRevision(root, base, { minimumRevision: 5 }), 5);
  assert.equal(await api.reserveRevision(root, base, { minimumRevision: 10 }), 5);
  assert.equal(await api.reserveRevision(root, { ...base, releaseId: 'b'.repeat(64) }), 6);
  await assert.rejects(api.reserveRevision(root, { ...base, releaseId: 'c'.repeat(64) }, { minimumRevision: -1 }), /revision/i);
});

test('published identity and reserved revision cannot be overwritten by a cache-reset build', async t => {
  const root = await fixture(t);
  await publish(root);
  assert.equal((await api.recordPublished(root, base, { fetcher })).status, 'unchanged');
  await assert.rejects(api.recordPublished(root, { ...base, artifact: { ...base.artifact, bytes: 999 } }, { fetcher }), /immutable|conflict/i);
  const next = { ...base, releaseId: 'b'.repeat(64) };
  assert.equal(await api.reserveRevision(root, next), 2);
  await assert.rejects(api.recordPublished(root, { ...next, revision: 1 }, { fetcher }), /reservation|revision/i);
  assert.equal((await api.readPublishedState(root)).records.length, 1);
});

test('catalog activation is explicit and recoverable after its final file write was interrupted', async t => {
  const root = await fixture(t);
  await publish(root);
  const latest = { 'dev.crux/python': base.releaseId };
  const expected = await api.writePublishedCatalog(root, latest);
  const before = await readFile(path.join(root, 'catalog.json'), 'utf8');
  await assert.rejects(api.writePublishedCatalog(root, { 'dev.crux/python': 'f'.repeat(64) }), /latest/i);
  assert.equal(await readFile(path.join(root, 'catalog.json'), 'utf8'), before);
  // Durable state committed, but final catalog file still contains the previous snapshot.
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify({ schemaVersion: 1, families: [] }));
  await api.recoverPublishedCatalog(root);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'catalog.json'))), expected);
});

test('withdrawal requires a consistent explicit latest policy and cannot resurrect the same release', async t => {
  const root = await fixture(t);
  await publish(root);
  await api.writePublishedCatalog(root, { 'dev.crux/python': base.releaseId });
  await assert.rejects(api.withdrawPublishedRelease(root, base.releaseId, { 'dev.crux/python': base.releaseId }), /latest|published/i);
  assert.equal((await api.readPublishedState(root)).records[0].status, 'published');
  await api.withdrawPublishedRelease(root, base.releaseId, {});
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'catalog.json'))), { schemaVersion: 1, families: [] });
  assert.equal((await api.readPublishedState(root)).records[0].status, 'withdrawn');
  await assert.rejects(api.recordPublished(root, base, { fetcher }), /immutable|withdrawn|conflict/i);
});

test('store refuses unrelated directories, symlink state and unknown schemas without modifying them', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'unrelated'), 'user data');
  await assert.rejects(api.reserveRevision(root, base), /unowned|nonempty/i);
  assert.equal(await readFile(path.join(root, 'unrelated'), 'utf8'), 'user data');
  const other = await fixture(t);
  await symlink(path.join(root, 'unrelated'), path.join(other, 'state.json'));
  await assert.rejects(api.reserveRevision(other, base), /symlink|regular/i);
  const unknown = await fixture(t);
  await writeFile(path.join(unknown, 'state.json'), JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(api.reserveRevision(unknown, base), /schema/i);
});
