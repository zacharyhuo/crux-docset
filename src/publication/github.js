import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { regularPath } from '../build-state.js';

export const publicationBranch = 'docset-publication';
const SHA = /^[0-9a-f]{40}$/;
const storageHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const jsonText = value => JSON.stringify(value, null, 2) + '\n';

export class GitHubPublication {
  constructor({ repository, token, fetcher = fetch }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || repository.split('/').some(s => ['.', '..'].includes(s))) throw new Error('Invalid GitHub repository');
    this.repository = repository;
    this.token = token;
    this.fetcher = fetcher;
    this.base = `https://api.github.com/repos/${repository}`;
  }

  async request(endpoint, { method = 'GET', body, missing = false } = {}) {
    const response = await this.fetcher(`${this.base}${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint} HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 12 * 1024 * 1024) throw new Error('GitHub metadata size limit exceeded');
    return text ? JSON.parse(text) : null;
  }

  async head() {
    const ref = await this.request(`/git/ref/heads/${publicationBranch}`, { missing: true });
    if (ref === null) return null;
    if (ref.ref !== `refs/heads/${publicationBranch}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha)) throw new Error('Invalid publication branch reference');
    return ref.object.sha;
  }

  async snapshot() {
    const repository = await this.request(''); // Distinguishes no branch from no repository access.
    const head = await this.head();
    if (!head) return { head, state: { schemaVersion: 1, reservations: [], records: [], catalog: null }, private: repository.private };
    const commit = await this.request(`/git/commits/${head}`);
    const tree = await this.request(`/git/trees/${commit.tree.sha}`);
    const entry = tree.tree?.find(item => item.path === 'state.json');
    if (tree.truncated || entry?.type !== 'blob' || entry.mode !== '100644' || entry.size > 8 * 1024 * 1024 || !SHA.test(entry.sha)) throw new Error('Missing or invalid durable publication state');
    const blob = await this.request(`/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64' || blob.size > 8 * 1024 * 1024) throw new Error('Invalid state blob');
    return { head, private: repository.private, state: JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')) };
  }

  async readJSON(head, name) {
    if (!SHA.test(head)) throw new Error('Invalid state commit');
    const file = await this.request(`/contents/${name}?ref=${head}`);
    if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 1024 * 1024) throw new Error('Invalid publication evidence file');
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }

  async checkMainCommit(commit) {
    if (!SHA.test(commit)) throw new Error('Publication requires a full source commit SHA');
    const comparison = await this.request(`/compare/${commit}...main`);
    if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Publication source commit must belong to main');
  }

  // A commit based on the observed head and a non-forced ref update reject a
  // competing writer. State, catalog and feeds activate in one Git commit.
  async commit(expectedHead, files, message) {
    if (await this.head() !== expectedHead) throw new Error('Publication state changed; rerun from a fresh snapshot');
    const previous = expectedHead ? await this.request(`/git/commits/${expectedHead}`) : null;
    const tree = await this.request('/git/trees', { method: 'POST', body: {
      ...(previous ? { base_tree: previous.tree.sha } : {}),
      tree: Object.entries(files).map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', content: typeof content === 'string' ? content : jsonText(content) }))
    } });
    const commit = await this.request('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: expectedHead ? [expectedHead] : [] } });
    if (!SHA.test(commit.sha)) throw new Error('Invalid publication commit');
    if (expectedHead) await this.request(`/git/refs/heads/${publicationBranch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    else await this.request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${publicationBranch}`, sha: commit.sha } });
    return commit.sha;
  }

  async release(tag, commit, title, releaseId) {
    let release = await this.request(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });
    if (!release) {
      // Draft releases are not always returned by the tag endpoint.
      for (let page = 1; page <= 10; page++) {
        const rows = await this.request(`/releases?per_page=100&page=${page}`);
        release = rows.find(row => row.tag_name === tag);
        if (release || rows.length < 100) break;
        if (page === 10) throw new Error('Release lookup limit exceeded');
      }
    }
    const body = `Crux docset release ${releaseId}`;
    if (release && (release.body !== body || release.prerelease || release.tag_name !== tag)) throw new Error('Release identity conflict');
    if (!release) release = await this.request('/releases', { method: 'POST', body: { tag_name: tag, target_commitish: commit, name: title, body, draft: true, prerelease: false } });
    if (!Number.isSafeInteger(release.id)) throw new Error('Invalid GitHub release');
    return release;
  }

  async assets(release) {
    const rows = [];
    for (let page = 1; page <= 3; page++) {
      const items = await this.request(`/releases/${release.id}/assets?per_page=100&page=${page}`);
      rows.push(...items);
      if (items.length < 100) return rows;
    }
    throw new Error('Release asset limit exceeded');
  }

  async upload(release, name, { file, data }) {
    const size = file ? (await regularPath(file)).size : data.length;
    const response = await this.fetcher(`https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-GitHub-Api-Version': '2022-11-28' },
      body: file ? createReadStream(file) : data, ...(file ? { duplex: 'half' } : {})
    });
    if (!response.ok) throw new Error(`GitHub upload ${name} HTTP ${response.status}; existing assets are never replaced`);
    return response.json();
  }

  async assetResponse(asset) {
    if (!Number.isSafeInteger(asset.id)) throw new Error('Invalid asset identity');
    const response = await this.fetcher(`${this.base}/releases/assets/${asset.id}`, {
      redirect: 'manual', signal: AbortSignal.timeout(180_000),
      headers: { Accept: 'application/octet-stream', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }
    });
    return this.followStorage(response);
  }

  async publicResponse(url) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com' || !parsed.pathname.startsWith(`/${this.repository}/releases/download/`) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Unexpected release download URL');
    return this.followStorage(await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(180_000) }));
  }

  async followStorage(response) {
    for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
      if (redirects >= 3) throw new Error('Release redirect limit exceeded');
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || !storageHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('Untrusted release storage redirect');
      await response.body?.cancel();
      // Authentication is never forwarded to the signed storage URL.
      response = await this.fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    }
    return response;
  }
}

export async function verifyResponse(response, { sha256, bytes }) {
  if (!response.ok || !response.body) throw new Error(`Asset readback HTTP ${response.status}`);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== bytes) { await response.body.cancel(); throw new Error('Asset readback size mismatch'); }
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > bytes) throw new Error('Asset readback size limit exceeded');
    hash.update(chunk);
  }
  if (count !== bytes || hash.digest('hex') !== sha256) throw new Error('Asset readback checksum or size mismatch');
}
