import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { unpackCandidate } from '../src/publication/verify.js';
import { GitHubPublication } from '../src/publication/github.js';
import { GitHubFixture } from './helpers/publication.js';

for (const kind of ['symbolic link', 'duplicate path', 'unexpected root', 'expansion limit']) {
  test(`publisher archive inspection rejects ${kind} before extraction`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'crux-publication-archive-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'Python.docset'));
    await writeFile(path.join(root, 'Python.docset/page.html'), 'page');
    await writeFile(path.join(root, 'other.html'), 'other root');
    const archive = path.join(root, 'candidate.tgz'), output = path.join(root, 'extracted');
    let entries = ['Python.docset'];
    if (kind === 'symbolic link') await symlink('page.html', path.join(root, 'Python.docset/link.html'));
    if (kind === 'duplicate path') entries = ['Python.docset/page.html', 'Python.docset/page.html'];
    if (kind === 'unexpected root') entries = ['other.html'];
    await tar.c({ cwd: root, file: archive, gzip: true }, entries);
    await assert.rejects(unpackCandidate(archive, output, { bundleName: 'Python', limits: { maxFiles: 100, maxBytes: kind === 'expansion limit' ? 1 : 1000 } }), /links|duplicate|root|limit/);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  });
}

for (const destination of ['http://release-assets.githubusercontent.com/x', 'https://untrusted.invalid/x', 'https://release-assets.githubusercontent.com:8443/x']) {
  test(`release readback refuses storage redirect ${destination}`, async () => {
    const requests = [];
    const github = new GitHubPublication({ repository: 'fixture/crux-docset', token: 'fixture-token', fetcher: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 302, headers: { location: destination } });
    } });
    await assert.rejects(github.assetResponse({ id: 1 }), /Untrusted/);
    assert.equal(requests.length, 1, 'no credential or request reaches the redirect destination');
  });
}

test('state ref update uses a non-forced commit and rejects a writer racing after the initial check', async () => {
  const remote = new GitHubFixture();
  let race = false;
  const github = new GitHubPublication({ repository: remote.repository, token: 'fixture-token', fetcher: async (url, options) => {
    if (race && url.endsWith('/git/refs/heads/docset-publication') && options.method === 'PATCH') {
      assert.equal(JSON.parse(options.body).force, false);
      const sha = remote.sha();
      remote.commits.set(sha, { tree: remote.commits.get(remote.head).tree, parents: [remote.head] });
      remote.head = sha;
    }
    return remote.fetch(url, options);
  } });
  const head = await github.commit(null, { 'state.json': { fixture: 'original' } }, 'Initialize');
  race = true;
  await assert.rejects(github.commit(head, { 'state.json': { fixture: 'overwrite' } }, 'Competing commit'), /422/);
  assert.equal(remote.state().fixture, 'original');
});
