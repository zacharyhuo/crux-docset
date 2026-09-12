import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverPython, fingerprint, buildCandidate, makeFeed, safeArchivePath } from '../src/pipeline.js';

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
  const recipe = { id: 'python', bundleName: 'Python' };
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
  assert.equal(JSON.parse(await readFile(path.join(work, 'current.json'))).fingerprint, first.fingerprint);
  await assert.rejects(buildCandidate({ ...opts, source: { sha256: 'older' }, build: async dir => { await build(dir); return { version: '3.14.6' }; } }), /downgrade/i);
  assert.equal(JSON.parse(await readFile(path.join(work, 'current.json'))).fingerprint, first.fingerprint);
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
  const opts = { work, recipe: { id: 'python', bundleName: 'Python' }, source: {}, builder: {}, validate: async () => ({ passed: true }), build: async () => { entered.resolve(); await finish.promise; throw new Error('controlled stop'); } };
  const running = buildCandidate(opts);
  const rejected = assert.rejects(running, /controlled stop/);
  await entered.promise;
  try { await assert.rejects(buildCandidate(opts), { code: 'ELOCKED' }); }
  finally { finish.resolve(); }
  await rejected;
});
