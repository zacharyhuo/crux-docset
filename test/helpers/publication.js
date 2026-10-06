import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as plist from 'plist';
import { PNG } from 'pngjs';
import { buildCandidate } from '../../src/pipeline.js';
import { validate } from '../../src/validate.js';
import { reserveRevision } from '../../src/published-store.js';
import { policyDigest } from '../../src/publication/verify.js';
import { restorePublication } from '../../src/publication/publisher.js';
import { GitHubPublication } from '../../src/publication/github.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

// Stateful GitHub HTTP fixture: real publisher + real archive validator run
// against it. No endpoint here can address the user's repository or credentials.
export class GitHubFixture {
  repository = 'fixture/crux-docset';
  private = false;
  head = null;
  serial = 0;
  trees = new Map();
  commits = new Map();
  blobs = new Map();
  releases = [];
  assets = new Map();
  requests = [];
  failActivation = false;
  corruptReadback = false;
  failUploadNumber = 0;
  leaveStarter = false;
  uploads = 0;
  sha() { return (++this.serial).toString(16).padStart(40, '0'); }
  files() { return this.head ? this.trees.get(this.commits.get(this.head).tree.sha) : {}; }
  state() { return JSON.parse(this.files()['state.json'] ?? 'null'); }
  fetch = async (input, options = {}) => {
    const url = new URL(input), method = options.method ?? 'GET';
    this.requests.push({ url: url.href, method, headers: options.headers });
    if (url.host === 'release-assets.githubusercontent.com') {
      const bytes = this.assets.get(Number(url.pathname.slice(1))).bytes;
      return new Response(this.corruptReadback ? Buffer.alloc(bytes.length, 1) : bytes);
    }
    if (url.host === 'github.com') {
      const [, , , , , tag, name] = url.pathname.split('/');
      const release = this.releases.find(r => r.tag_name === tag && !r.draft);
      const asset = release?.assets.find(a => a.name === name);
      return asset ? this.redirect(asset.id) : response({}, 404);
    }
    if (url.host === 'uploads.github.com') {
      this.uploads++;
      const release = this.releases.find(r => r.id === Number(url.pathname.split('/').at(-2)));
      if (this.failUploadNumber === this.uploads) {
        if (this.leaveStarter) release.assets.push({ id: ++this.serial, name: url.searchParams.get('name'), size: 0, state: 'starter' });
        return response({}, this.leaveStarter ? 502 : 503);
      }
      const chunks = [];
      if (Buffer.isBuffer(options.body)) chunks.push(options.body);
      else for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks), id = ++this.serial;
      const asset = { id, name: url.searchParams.get('name'), size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}` };
      release.assets.push(asset); this.assets.set(id, { ...asset, bytes });
      return response(asset, 201);
    }
    const endpoint = url.pathname.replace(`/repos/${this.repository}`, '');
    const body = options.body ? JSON.parse(options.body) : null;
    if (!endpoint) return response({ private: this.private });
    if (endpoint.startsWith('/compare/')) return response({ status: 'identical' });
    if (endpoint === '/git/ref/heads/docset-publication') return this.head
      ? response({ ref: 'refs/heads/docset-publication', object: { type: 'commit', sha: this.head } }) : response({}, 404);
    if (endpoint === '/git/trees' && method === 'POST') {
      const tree = { ...(this.trees.get(body.base_tree) ?? {}) };
      for (const entry of body.tree) tree[entry.path] = entry.content;
      const sha = this.sha(); this.trees.set(sha, tree); return response({ sha }, 201);
    }
    if (endpoint === '/git/commits' && method === 'POST') {
      const sha = this.sha(); this.commits.set(sha, { ...body, tree: { sha: body.tree } }); return response({ sha }, 201);
    }
    if (endpoint.startsWith('/git/commits/')) return response(this.commits.get(endpoint.split('/').at(-1)));
    if (endpoint.startsWith('/git/trees/')) {
      const tree = this.trees.get(endpoint.split('/').at(-1));
      return response({ tree: Object.entries(tree).filter(([name]) => !name.includes('/')).map(([name, content]) => {
        const sha = this.sha(); this.blobs.set(sha, content);
        return { path: name, type: 'blob', mode: '100644', size: Buffer.byteLength(content), sha };
      }), truncated: false });
    }
    if (endpoint.startsWith('/git/blobs/')) {
      const content = this.blobs.get(endpoint.split('/').at(-1));
      return response({ encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
    }
    if (endpoint === '/git/refs' || endpoint === '/git/refs/heads/docset-publication') {
      const commit = this.commits.get(body.sha);
      if ((this.head && commit.parents[0] !== this.head) || (!this.head && commit.parents.length)) return response({}, 422);
      if (this.failActivation && commit.message.startsWith('Publish ')) return response({}, 503);
      this.head = body.sha; return response({}, 200);
    }
    if (endpoint.startsWith('/contents/')) {
      const name = endpoint.slice('/contents/'.length), commit = this.commits.get(url.searchParams.get('ref'));
      const content = this.trees.get(commit.tree.sha)[name];
      return content === undefined ? response({}, 404) : response({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
    }
    if (endpoint.startsWith('/releases/tags/')) {
      const release = this.releases.find(r => r.tag_name === decodeURIComponent(endpoint.split('/').at(-1)) && !r.draft);
      return release ? response(release) : response({}, 404);
    }
    if (endpoint === '/releases' && method === 'GET') return response(this.releases);
    if (endpoint === '/releases' && method === 'POST') {
      const release = { ...body, id: ++this.serial, assets: [] };
      this.releases.push(release); return response(release, 201);
    }
    if (/^\/releases\/\d+\/assets$/.test(endpoint)) return response(this.releases.find(r => r.id === Number(endpoint.split('/')[2])).assets);
    if (/^\/releases\/assets\/\d+$/.test(endpoint)) {
      const id = Number(endpoint.split('/').at(-1));
      if (method === 'DELETE') {
        for (const release of this.releases) release.assets = release.assets.filter(a => a.id !== id);
        this.assets.delete(id); return new Response(null, { status: 204 });
      }
      return this.redirect(id);
    }
    if (/^\/releases\/\d+$/.test(endpoint) && method === 'PATCH') {
      const release = this.releases.find(r => r.id === Number(endpoint.split('/').at(-1)));
      Object.assign(release, body, { published_at: '2026-10-06T00:00:00Z' }); return response(release);
    }
    throw new Error(`Unhandled fixture request: ${method} ${url.href}`);
  };
  redirect(id) { return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${id}?signed=fixture` } }); }
}

export async function publicationFixture(t, remote = new GitHubFixture(), { version = '3.14.7', sourceHash = 'a'.repeat(64), symbols = 1 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-publisher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const github = new GitHubPublication({ repository: remote.repository, token: 'fixture-token', fetcher: remote.fetch });
  const publication = path.join(root, 'publication');
  await restorePublication(publication, github);
  const recipe = { schemaVersion: 2, id: 'python', familyId: 'python', variantId: 'python-3-14-en', versionLine: '3.14', language: 'en',
    sourceId: 'dev.crux', bundleName: 'Python', identifier: 'dev.crux.python', name: 'Python', homepage: 'index.html',
    builder: { adapter: 'python-intersphinx', doc2dash: '3.1.0' }, compliance: { retain: ['license.html'] },
    limits: { maxFiles: 100, maxBytes: 1024 ** 2 }, validation: { minimumPages: 2, minimumSymbols: 1, requireIcons: true, maxDropFraction: 0.1 } };
  const icons = Object.fromEntries([['icon.png', 16], ['icon@2x.png', 32]].map(([name, width]) => [name, PNG.sync.write(new PNG({ width, height: width }))]));
  const policy = { schemaVersion: 1, familyId: 'python', sourceId: 'dev.crux', defaultVariantId: recipe.variantId, variants: { [recipe.variantId]: policyDigest(recipe, icons) } };
  const builderDigest = 'b'.repeat(64), builder = { digest: builderDigest, adapter: 'python-intersphinx', releaseAuthority: 'durable-publication' };
  const result = await buildCandidate({ work: path.join(root, 'build'), recipe, source: { url: 'https://docs.python.org/3.14/archives/python-3.14-docs-html.zip', sha256: sourceHash }, builder, validate,
    allocateRevision: (seed, minimumRevision) => reserveRevision(publication, seed, { minimumRevision }),
    build: async directory => {
      const bundle = path.join(directory, 'Python.docset'), resources = path.join(bundle, 'Contents/Resources');
      await mkdir(path.join(resources, 'Documents'), { recursive: true });
      await writeFile(path.join(bundle, 'Contents/Info.plist'), plist.build({ CFBundleIdentifier: recipe.identifier, CFBundleName: recipe.name, isDashDocset: true }));
      await writeFile(path.join(resources, 'Documents/index.html'), '<h1 id="sample">sample</h1>');
      await writeFile(path.join(resources, 'Documents/license.html'), '<h1>Fixture attribution</h1>');
      for (const [name, bytes] of Object.entries(icons)) await writeFile(path.join(bundle, name), bytes);
      const db = new DatabaseSync(path.join(resources, 'docSet.dsidx'));
      try {
        db.exec('CREATE TABLE searchIndex(name TEXT, type TEXT, path TEXT)');
        for (let i = 0; i < symbols; i++) db.prepare('INSERT INTO searchIndex VALUES(?,?,?)').run(`sample-${i}`, 'Guide', 'index.html#sample');
      } finally { db.close(); }
      return { version };
    } });
  return { remote, github, root, directory: result.directory, publication, recipe, icons, policy, builderDigest, sourceCommit: 'c'.repeat(40) };
}
