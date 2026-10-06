import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishCandidate } from '../src/publication/publisher.js';
import { qualifyCandidate, readJSON, checkPolicy } from '../src/publication/verify.js';
import { loadRecipe, hashBuildInputs } from '../src/recipes.js';
import { getAdapter } from '../src/adapters.js';
import { fingerprint } from '../src/identity.js';
import { loadRecipeIcons } from '../src/icons.js';
import { publicationFixture } from './helpers/publication.js';

test('publisher qualifies archive bytes, reads back five assets, and activates catalog/feed atomically', async t => {
  const f = await publicationFixture(t);
  const result = await publishCandidate(f);
  assert.equal(result.status, 'published');
  assert.equal(result.publicDownloadVerified, true);
  const state = f.remote.state();
  assert.equal(state.reservations.length, 1);
  assert.equal(state.records.length, 1);
  assert.equal(state.catalog.families[0].latestReleaseId, result.releaseId);
  assert.deepEqual(JSON.parse(f.remote.files()['catalog.json']), state.catalog);
  assert.match(f.remote.files()['feeds/python.xml'], /<version>3\.14\.7<\/version><revision>1<\/revision>/);
  assert.match(f.remote.files()['feeds/python-3-14-en.xml'], /github\.com/);
  assert.equal(f.remote.uploads, 5);
  assert.ok(f.remote.files()[`qualifications/${result.releaseId}.json`]);
  assert.ok(f.remote.requests.some(r => r.url.startsWith('https://github.com/')));
  for (const request of f.remote.requests.filter(r => r.url.startsWith('https://release-assets.githubusercontent.com/'))) assert.equal(request.headers?.Authorization, undefined);
  const head = f.remote.head;
  assert.equal((await publishCandidate(f)).status, 'unchanged');
  assert.equal(f.remote.head, head);
  assert.equal(f.remote.uploads, 5);
});

test('policy pins every enabled Python recipe and artwork without pinning upstream patches', async () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname), policy = await readJSON(path.join(root, 'publication/python.json'));
  for (const variantId of Object.keys(policy.variants)) {
    const { recipe, recipeDirectory } = await loadRecipe({ root, id: 'python', variantId });
    const icons = await loadRecipeIcons(recipeDirectory);
    checkPolicy(policy, recipe, icons);
    assert.throws(() => checkPolicy(policy, { ...recipe, compliance: {} }, icons), /policy/i);
  }
});

test('reviewed default-variant policy changes invalidate Python builder identity even when upstream bytes are unchanged', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-policy-input-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tools/doc2dash'), { recursive: true });
  await mkdir(path.join(root, 'publication'));
  for (const file of ['uv.lock', 'pyproject.toml']) await writeFile(path.join(root, 'tools/doc2dash', file), 'fixed tool input');
  const policy = path.join(root, 'publication/python.json');
  await writeFile(policy, JSON.stringify({ defaultVariantId: 'python-3-14-en' }));
  const before = fingerprint(await hashBuildInputs(root, getAdapter('python-intersphinx').inputFiles));
  await writeFile(policy, JSON.stringify({ defaultVariantId: 'python-3-15-en' }));
  const after = fingerprint(await hashBuildInputs(root, getAdapter('python-intersphinx').inputFiles));
  assert.notEqual(after, before);
});

test('a tampered archive or recipe policy causes no GitHub write', async t => {
  const f = await publicationFixture(t);
  await writeFile(path.join(f.directory, 'Python.tgz'), 'corrupt');
  await assert.rejects(publishCandidate(f), /checksum|size/);
  assert.equal(f.remote.head, null);
  assert.equal(f.remote.uploads, 0);
  assert.equal(f.remote.requests.some(r => r.method !== 'GET'), false);
  await assert.rejects(qualifyCandidate({ ...f, policy: { ...f.policy, variants: {} } }), /policy/);
});

test('independent qualification ignores a valid sibling bundle when archived metadata is wrong', async t => {
  const f = await publicationFixture(t);
  const manifest = await readJSON(path.join(f.directory, 'manifest.json'));
  await writeFile(path.join(f.directory, 'manifest.json'), JSON.stringify({ ...manifest, revision: 2 }));
  await assert.rejects(qualifyCandidate(f), /metadata/);
});

test('failed asset readback preserves the durable reservation and publishes no catalog', async t => {
  const f = await publicationFixture(t);
  f.remote.corruptReadback = true;
  await assert.rejects(publishCandidate(f), /checksum/);
  assert.equal(f.remote.state().reservations.length, 1);
  assert.equal(f.remote.state().records.length, 0);
  assert.equal(f.remote.state().catalog, null);
  assert.equal(f.remote.releases[0].draft, true);
  f.remote.corruptReadback = false;
  const cold = await publicationFixture(t, f.remote);
  assert.equal((await publishCandidate(cold)).status, 'published');
  assert.equal(f.remote.state().records[0].revision, 1);
  assert.equal(f.remote.uploads, 5);
});

test('partial draft upload resumes after a cold rebuild without replacing existing assets', async t => {
  const f = await publicationFixture(t);
  f.remote.failUploadNumber = 3;
  await assert.rejects(publishCandidate(f), /503/);
  const ids = f.remote.releases[0].assets.map(a => a.id);
  const cold = await publicationFixture(t, f.remote);
  await publishCandidate(cold);
  assert.deepEqual(f.remote.releases[0].assets.slice(0, 2).map(a => a.id), ids);
  assert.equal(f.remote.releases.length, 1);
  assert.equal(f.remote.state().records.length, 1);
});

test('publish-only rerun reconciles the original promotion snapshot and removes only empty draft upload residue', async t => {
  const f = await publicationFixture(t);
  const original = await readFile(path.join(f.publication, 'remote.json'));
  f.remote.failUploadNumber = 3;
  f.remote.leaveStarter = true;
  await assert.rejects(publishCandidate(f), /502/);
  const assets = f.remote.releases[0].assets;
  const uploadedIDs = assets.filter(a => a.state === 'uploaded').map(a => a.id);
  const starter = assets.find(a => a.state === 'starter');
  assert.ok(starter);
  await writeFile(path.join(f.publication, 'remote.json'), original);
  assert.equal((await publishCandidate(f)).status, 'published');
  assert.deepEqual(f.remote.releases[0].assets.slice(0, 2).map(a => a.id), uploadedIDs);
  assert.deepEqual(f.remote.requests.filter(r => r.method === 'DELETE').map(r => r.url), [`https://api.github.com/repos/${f.remote.repository}/releases/assets/${starter.id}`]);
});

test('rerunning original promotion inputs after a completed activation preserves newer durable state', async t => {
  const f = await publicationFixture(t);
  const files = await Promise.all(['state.json', 'remote.json'].map(name => readFile(path.join(f.publication, name))));
  await publishCandidate(f);
  const head = f.remote.head;
  for (const [i, name] of ['state.json', 'remote.json'].entries()) await writeFile(path.join(f.publication, name), files[i]);
  assert.equal((await publishCandidate(f)).status, 'unchanged');
  assert.equal(f.remote.head, head);
  assert.equal(f.remote.uploads, 5);
});

test('catalog activation failure preserves the previous catalog and is recoverable on a fresh runner', async t => {
  const first = await publicationFixture(t);
  await publishCandidate(first);
  const old = first.remote.files()['catalog.json'];
  const next = await publicationFixture(t, first.remote, { version: '3.14.8', sourceHash: 'd'.repeat(64) });
  first.remote.failActivation = true;
  await assert.rejects(publishCandidate(next), /503/);
  assert.equal(first.remote.files()['catalog.json'], old);
  assert.equal(first.remote.state().records.length, 1);
  assert.equal(first.remote.releases.length, 2);
  first.remote.failActivation = false;
  const cold = await publicationFixture(t, first.remote, { version: '3.14.8', sourceHash: 'd'.repeat(64) });
  await publishCandidate(cold);
  assert.equal(first.remote.state().records.length, 2);
  assert.notEqual(first.remote.files()['catalog.json'], old);
});

test('cache loss still allocates same-version revisions from durable history and rejects downgrades', async t => {
  const first = await publicationFixture(t);
  await publishCandidate(first);
  const next = await publicationFixture(t, first.remote, { sourceHash: 'd'.repeat(64) });
  await publishCandidate(next);
  assert.deepEqual(first.remote.state().records.map(r => r.revision), [1, 2]);
  const old = await publicationFixture(t, first.remote, { version: '3.14.6', sourceHash: 'e'.repeat(64) });
  const head = first.remote.head;
  await assert.rejects(publishCandidate(old), /downgrade/);
  assert.equal(first.remote.head, head);
});

test('a competing publication writer is rejected before uploading', async t => {
  const f = await publicationFixture(t);
  const competitor = await publicationFixture(t, f.remote, { sourceHash: 'd'.repeat(64) });
  await publishCandidate(competitor);
  const uploads = f.remote.uploads;
  await assert.rejects(publishCandidate(f), /state changed/);
  assert.equal(f.remote.uploads, uploads);
});

test('a cold runner rejects count regressions using the published report rather than its cache', async t => {
  const first = await publicationFixture(t, undefined, { symbols: 2 });
  await publishCandidate(first);
  const next = await publicationFixture(t, first.remote, { version: '3.14.8', sourceHash: 'd'.repeat(64) });
  const head = first.remote.head;
  await assert.rejects(publishCandidate(next), /regression: symbolCount/);
  assert.equal(first.remote.head, head);
});

test('private development verifies authenticated API bytes without adding credentials to catalog URLs', async t => {
  const f = await publicationFixture(t);
  f.remote.private = true;
  const result = await publishCandidate(f);
  assert.equal(result.publicDownloadVerified, false);
  assert.equal(f.remote.requests.some(r => r.url.startsWith('https://github.com/')), false);
  assert.doesNotMatch(f.remote.files()['catalog.json'], /fixture-token|signed=/);
  assert.equal((await readFile(path.join(f.publication, 'remote.json'), 'utf8')).includes('fixture-token'), false);
});
