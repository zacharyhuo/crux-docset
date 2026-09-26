import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, utimes, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as plist from 'plist';
import * as tar from 'tar';
import { discoverPython, fingerprint, buildCandidate, makeFeed, safeArchivePath, sha256 } from '../src/pipeline.js';

const pythonRecipe = { schemaVersion: 2, id: 'python', sourceId: 'dev.crux', familyId: 'python', variantId: 'python-3-14-en', versionLine: '3.14', language: 'en', identifier: 'dev.crux.python', bundleName: 'Python' };
const goodReport = { passed: true, errors: [], pageCount: 1, symbolCount: 1 };
async function options(t, overrides = {}) {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-versioned-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  return { work, recipe: pythonRecipe, source: { url: 'https://docs.python.org/3.14/archives/python-3.14.7-docs-html.zip', sha256: 'a'.repeat(64) }, builder: { digest: 'one' }, validate: async () => goodReport, build: async dir => {
    const bundle = path.join(dir, 'Python.docset');
    await mkdir(path.join(bundle, 'Contents', 'Resources', 'Documents'), { recursive: true });
    await writeFile(path.join(bundle, 'Contents', 'Info.plist'), plist.build({ CFBundleIdentifier: 'dev.crux.python' }));
    await writeFile(path.join(bundle, 'Contents', 'Resources', 'Documents', 'index.html'), '<title>Python 3.14.7 documentation</title>');
    return { version: '3.14.7' };
  }, ...overrides };
}

test('discovers official HTML zip, rejects unexpected host and missing archive', () => {
  assert.equal(discoverPython('<a href="archives/python-3.14-docs-html.zip">HTML</a>', 'https://docs.python.org/3/download.html'), 'https://docs.python.org/3/archives/python-3.14-docs-html.zip');
  assert.throws(() => discoverPython('<a href="https://evil.example/python-3.14-docs-html.zip">HTML</a>', 'https://docs.python.org/3/download.html'));
  assert.throws(() => discoverPython('<p>gone</p>', 'https://docs.python.org/3/download.html'));
});

test('fingerprint ignores object key order but changes with source, recipe and builder', () => {
  const base = fingerprint({ source: 'abc', recipe: { a: 1, b: 2 }, builder: 'one' });
  assert.equal(base, fingerprint({ builder: 'one', recipe: { b: 2, a: 1 }, source: 'abc' }));
  for (const value of [{ source: 'def', recipe: { a: 1, b: 2 }, builder: 'one' }, { source: 'abc', recipe: { a: 2, b: 2 }, builder: 'one' }, { source: 'abc', recipe: { a: 1, b: 2 }, builder: 'two' }]) assert.notEqual(base, fingerprint(value));
});

test('archive paths reject escape, absolute, windows and ambiguous components', () => {
  assert.equal(safeArchivePath('python/library/a.html'), 'python/library/a.html');
  for (const name of ['../x', '/x', 'a/../../x', 'C:/x', 'a\\x', 'a//x', './x', 'a/./x']) assert.throws(() => safeArchivePath(name));
});

test('feed has HTTPS URL and XML-escaped metadata', () => {
  assert.match(makeFeed('3.14', 'https://example.org/a.tgz?a=1&b=2'), /a=1&amp;b=2/);
  assert.throws(() => makeFeed('3.14', 'http://example.org/a.tgz'));
});

test('unchanged candidate skips build; failed candidate preserves previous state', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-pipeline-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const recipe = pythonRecipe;
  let builds = 0;
  const build = async (dir) => { builds++; await mkdir(path.join(dir, 'Python.docset')); await writeFile(path.join(dir, 'Python.docset', 'page.html'), 'hello'); return { version: '3.14.7' }; };
  const validate = async () => ({ passed: true, errors: [], pageCount: 1, symbolCount: 1 });
  const opts = { work, recipe, source: { sha256: 'one' }, builder: 'v1', build, validate };
  const first = await buildCandidate(opts);
  assert.equal(first.status, 'built');
  const state = await readFile(path.join(work, 'current.json'), 'utf8');
  assert.equal((await buildCandidate(opts)).status, 'unchanged');
  assert.equal(builds, 1);
  await assert.rejects(buildCandidate({ ...opts, source: { sha256: 'two' }, validate: async () => ({ passed: false, errors: ['missing page'] }) }), /validation/i);
  assert.equal(await readFile(path.join(work, 'current.json'), 'utf8'), state);
  const manifest = JSON.parse(await readFile(path.join(first.directory, 'manifest.json')));
  const metadata = JSON.parse(await readFile(path.join(first.directory, 'Python.docset', 'meta.json')));
  assert.equal(metadata.version, '3.14.7');
  assert.equal(metadata.revision, manifest.revision);
  assert.match(manifest.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.artifact.bytes > 0);
  // Simulates interruption after a release directory was moved but before state commit.
  await unlink(path.join(work, 'current.json'));
  assert.equal((await buildCandidate(opts)).status, 'recovered');
  assert.equal(builds, 2); // Only initial success and rejected candidate were built.
  assert.equal(JSON.parse(await readFile(path.join(work, 'current.json'))).release.fingerprint, first.fingerprint);
  await assert.rejects(buildCandidate({ ...opts, source: { sha256: 'older' }, build: async dir => { await build(dir); return { version: '3.14.6' }; } }), /downgrade/i);
  assert.equal(JSON.parse(await readFile(path.join(work, 'current.json'))).release.fingerprint, first.fingerprint);
  await assert.rejects(buildCandidate({ ...opts, source: { sha256: 'shrunken' }, validate: async () => ({ passed: true, errors: [], pageCount: 0, symbolCount: 0 }) }), /regression/i);
  await mkdir(path.join(work, 'build.lock'));
  const old = new Date(Date.now() - 300_000);
  await utimes(path.join(work, 'build.lock'), old, old);
  assert.equal((await buildCandidate(opts)).status, 'unchanged');
});

test('a concurrent builder cannot replace the active build lease', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-lock-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const opts = { work, recipe: pythonRecipe, source: {}, builder: {}, validate: async () => ({ passed: true }), build: async () => { entered.resolve(); await finish.promise; throw new Error('controlled stop'); } };
  const running = buildCandidate(opts);
  const rejected = assert.rejects(running, /controlled stop/);
  await entered.promise;
  try { await assert.rejects(buildCandidate(opts), { code: 'ELOCKED' }); }
  finally { finish.resolve(); }
  await rejected;
});

test('state, metadata, manifest and variant feed agree on immutable release identity', async t => {
  const opts = await options(t, { baseUrl: 'https://example.invalid/docsets' });
  const result = await buildCandidate(opts);
  const manifest = JSON.parse(await readFile(path.join(result.directory, 'manifest.json')));
  const metadata = JSON.parse(await readFile(path.join(result.directory, 'Python.docset', 'meta.json')));
  const owner = JSON.parse(await readFile(path.join(opts.work, 'owner.json')));
  const state = JSON.parse(await readFile(path.join(opts.work, 'current.json')));
  for (const record of [manifest, metadata, owner, state]) {
    assert.equal(record.familyId, 'python');
    assert.equal(record.variantId, 'python-3-14-en');
    assert.equal(record.identifier, 'dev.crux.python');
  }
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(metadata.releaseId, result.fingerprint);
  assert.equal(manifest.releaseId, result.fingerprint);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.fingerprint, undefined, 'old CLI must reject migrated state rather than overwrite it');
  assert.equal(state.release.fingerprint, result.fingerprint);
  assert.equal(manifest.artifact.url, `https://example.invalid/docsets/artifacts/python-3-14-en/${result.fingerprint}/Python.tgz`);
  assert.match(await readFile(path.join(result.directory, 'feeds', 'python-3-14-en.xml'), 'utf8'), /artifacts\/python-3-14-en\//);
  const lock = JSON.parse(await readFile(path.join(result.directory, 'source-lock.json')));
  assert.equal(lock.variantId, manifest.variantId);
  assert.equal(lock.upstreamVersion, '3.14.7');
  assert.equal(lock.source.sha256, opts.source.sha256);
});

test('another variant cannot claim an owned directory, including after a failed first build', async t => {
  const opts = await options(t);
  await assert.rejects(buildCandidate({ ...opts, build: async () => { throw new Error('controlled stop'); } }), /controlled stop/);
  const before = await readFile(path.join(opts.work, 'owner.json'), 'utf8');
  await assert.rejects(buildCandidate({ ...opts, recipe: { ...pythonRecipe, variantId: 'python-3-13-en', versionLine: '3.13' }, build: async () => assert.fail('must not start foreign builder') }), /owner|identity/i);
  assert.equal(await readFile(path.join(opts.work, 'owner.json'), 'utf8'), before);
});

test('workspace ownership is checked before source resolution or network activity', async t => {
  const opts = await options(t);
  const result = await buildCandidate({ ...opts, source: undefined, build: undefined, withSource: async consume => consume(opts.source, opts.build) });
  assert.equal(result.status, 'built');
  let resolutions = 0;
  await assert.rejects(buildCandidate({ ...opts, recipe: { ...pythonRecipe, variantId: 'python-3-13-en', versionLine: '3.13' }, withSource: async () => { resolutions++; } }), /identity|owner/i);
  assert.equal(resolutions, 0);
});

test('competing variants cannot both take ownership of an initially empty directory', async t => {
  const opts = await options(t);
  const results = await Promise.allSettled([buildCandidate(opts), buildCandidate({ ...opts, recipe: { ...pythonRecipe, variantId: 'python-3-13-en', versionLine: '3.13' }, build: async dir => { await opts.build(dir); return { version: '3.13.9' }; } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const state = JSON.parse(await readFile(path.join(opts.work, 'current.json')));
  const owner = JSON.parse(await readFile(path.join(opts.work, 'owner.json')));
  assert.equal(state.variantId, owner.variantId);
});

test('variants use isolated baselines and distinct artifacts with stable bundle identity', async t => {
  const a = await options(t);
  const b = await options(t, { recipe: { ...pythonRecipe, variantId: 'python-3-13-en', versionLine: '3.13' }, build: async dir => { await a.build(dir); return { version: '3.13.9' }; } });
  const [first, second] = await Promise.all([buildCandidate(a), buildCandidate(b)]);
  assert.notEqual(first.fingerprint, second.fingerprint);
  const stateB = await readFile(path.join(b.work, 'current.json'), 'utf8');
  await assert.rejects(buildCandidate({ ...a, builder: 'changed', validate: async () => ({ passed: false }) }), /validation/i);
  assert.equal(await readFile(path.join(b.work, 'current.json'), 'utf8'), stateB);
  const manifestA = JSON.parse(await readFile(path.join(first.directory, 'manifest.json')));
  const manifestB = JSON.parse(await readFile(path.join(second.directory, 'manifest.json')));
  assert.equal(manifestA.identifier, 'dev.crux.python');
  assert.equal(manifestB.identifier, manifestA.identifier);
});

test('cross-line versions are rejected before validation or current promotion', async t => {
  const opts = await options(t);
  let validations = 0;
  await assert.rejects(buildCandidate({ ...opts, build: async dir => { await opts.build(dir); return { version: '3.15.0' }; }, validate: async () => { validations++; return goodReport; } }), /version line/i);
  assert.equal(validations, 0);
  await assert.rejects(readFile(path.join(opts.work, 'current.json')), { code: 'ENOENT' });
});

test('same-version rebuilds increase revision without altering previous artifacts', async t => {
  const opts = await options(t);
  const first = await buildCandidate(opts);
  const original = await readFile(path.join(first.directory, 'manifest.json'), 'utf8');
  const second = await buildCandidate({ ...opts, builder: { digest: 'two' } });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(JSON.parse(await readFile(path.join(second.directory, 'manifest.json'))).revision, 2);
  assert.equal(await readFile(path.join(first.directory, 'manifest.json'), 'utf8'), original);
  await assert.rejects(buildCandidate(opts), /rollback/i);
});

test('a lost current pointer cannot reset revisions or silently recover an older release', async t => {
  const opts = await options(t);
  await buildCandidate(opts);
  await buildCandidate({ ...opts, builder: 'revision-two' });
  await unlink(path.join(opts.work, 'current.json'));
  await assert.rejects(buildCandidate(opts), /missing current|review/i);
  await assert.rejects(buildCandidate({ ...opts, builder: 'revision-three' }), /missing current|review/i);
});

test('stable patch updates reset the revision while leaving the previous version immutable', async t => {
  const opts = await options(t);
  const initial = await buildCandidate(opts);
  const before = await readFile(path.join(initial.directory, 'manifest.json'), 'utf8');
  await buildCandidate({ ...opts, builder: 'rebuild' });
  const next = await buildCandidate({ ...opts, source: { ...opts.source, sha256: 'c'.repeat(64) }, build: async dir => { await opts.build(dir); return { version: '3.14.8' }; } });
  const manifest = JSON.parse(await readFile(path.join(next.directory, 'manifest.json')));
  assert.equal(manifest.version, '3.14.8');
  assert.equal(manifest.revision, 1);
  assert.equal(await readFile(path.join(initial.directory, 'manifest.json'), 'utf8'), before);
});

test('unowned nonempty workspaces and symlink state paths are not adopted', async t => {
  const opts = await options(t);
  await writeFile(path.join(opts.work, 'unrelated'), 'user data');
  await assert.rejects(buildCandidate(opts), /unowned|ownership/i);
  assert.deepEqual(await readdir(opts.work), ['unrelated']);
  const other = await options(t);
  await symlink(opts.work, path.join(other.work, 'releases'));
  await assert.rejects(buildCandidate(other), /symlink|unowned/i);
});

async function legacyFixture(t, { version = '3.14.7', identifier = 'dev.crux.python' } = {}) {
  const opts = await options(t);
  const id = 'b'.repeat(64), dir = path.join(opts.work, 'releases', id);
  await mkdir(dir, { recursive: true });
  await opts.build(dir);
  await writeFile(path.join(dir, 'Python.docset', 'Contents', 'Info.plist'), plist.build({ CFBundleIdentifier: identifier }));
  await writeFile(path.join(dir, 'Python.docset', 'Contents', 'Resources', 'Documents', 'index.html'), `<title>Python ${version} documentation</title>`);
  await tar.c({ gzip: true, cwd: dir, file: path.join(dir, 'Python.tgz') }, ['Python.docset']);
  const bytes = (await readFile(path.join(dir, 'Python.tgz'))).length;
  const manifest = { schemaVersion: 1, id: 'python', fingerprint: id, version, revision: 3, source: { ...opts.source, url: 'https://docs.python.org/3/archives/python-3.14-docs-html.zip' }, artifact: { file: 'Python.tgz', sha256: await sha256(path.join(dir, 'Python.tgz')), bytes }, validation: goodReport };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const state = JSON.stringify({ schemaVersion: 1, fingerprint: id, version, revision: 3 });
  await writeFile(path.join(opts.work, 'current.json'), state);
  return { ...opts, legacy: { state, dir } };
}

test('known Python schema-1 state is verified, backed up and migrated without mutating old release', async t => {
  const opts = await legacyFixture(t);
  const before = await readFile(path.join(opts.legacy.dir, 'manifest.json'), 'utf8');
  const result = await buildCandidate(opts);
  assert.equal(await readFile(path.join(opts.work, 'legacy-current.v1.json'), 'utf8'), opts.legacy.state);
  assert.equal(await readFile(path.join(opts.legacy.dir, 'manifest.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(path.join(result.directory, 'manifest.json'))).revision, 4);
  assert.equal(JSON.parse(await readFile(path.join(opts.work, 'current.json'))).variantId, 'python-3-14-en');
});

test('legacy state with mismatched version line or actual bundle identity is left untouched', async t => {
  for (const mismatch of [{ version: '3.15.0' }, { identifier: 'foreign.python' }]) {
    const opts = await legacyFixture(t, mismatch);
    await assert.rejects(buildCandidate(opts), /version line|identity|identifier/i);
    assert.equal(await readFile(path.join(opts.work, 'current.json'), 'utf8'), opts.legacy.state);
    await assert.rejects(readFile(path.join(opts.work, 'owner.json')), { code: 'ENOENT' });
  }
});

test('unknown state schema and foreign manifests cannot be used as baselines', async t => {
  const opts = await options(t);
  const result = await buildCandidate(opts);
  const statePath = path.join(opts.work, 'current.json');
  const state = JSON.parse(await readFile(statePath));
  await writeFile(statePath, JSON.stringify({ ...state, schemaVersion: 99 }));
  await assert.rejects(buildCandidate(opts), /schema/i);
  await writeFile(statePath, JSON.stringify(state));
  const manifestPath = path.join(result.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, variantId: 'python-3-13-en' }));
  await assert.rejects(buildCandidate(opts), /identity/i);
});
