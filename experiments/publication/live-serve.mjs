import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { validateReleaseCatalog } from '../../src/release-catalog.js';
import { sha256 } from '../../src/identity.js';
import { serveAcceptance } from './https-fixture.mjs';

// Uses gh's normal authentication only for repository-scoped reads/downloads.
// No auth token is read, returned, copied to the app, or stored in experiment files.
const { values } = parseArgs({ options: { repository: { type: 'string' }, work: { type: 'string' } } });
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository ?? '') || values.repository.split('/').some(s => ['.', '..'].includes(s))
    || !values.work || !path.isAbsolute(values.work)) throw new Error('--repository OWNER/REPO and absolute --work are required');
const execute = promisify(execFile);
const gh = async args => (await execute('gh', args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
await mkdir(values.work, { recursive: true });
const work = await mkdtemp(path.join(values.work, 'github-beta-'));
console.log(`EXPERIMENT ${work}`);
const prefix = `repos/${values.repository}`;
const head = (await gh(['api', `${prefix}/git/ref/heads/docset-publication`, '--jq', '.object.sha'])).trim();
if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Invalid publication head');
const response = JSON.parse(await gh(['api', `${prefix}/contents/catalog.json?ref=${head}`]));
if (response.type !== 'file' || response.encoding !== 'base64' || response.size > 1024 * 1024) throw new Error('Invalid published catalog response');
const catalog = validateReleaseCatalog(JSON.parse(Buffer.from(response.content, 'base64').toString('utf8')));
const family = catalog.families.find(f => f.sourceId === 'dev.crux' && f.familyId === 'python');
if (!family || family.releases.length > 16 || !family.releases.some(r => r.versionLine === '3.13')) throw new Error('Publish both reviewed Python lines before live Beta acceptance');
await writeFile(path.join(work, 'github-catalog.json'), JSON.stringify(catalog, null, 2));
const archives = new Map(), receipts = [];
for (const release of family.releases) {
  if (release.artifact.bytes > 64 * 1024 * 1024) throw new Error('Live Python experiment archive size limit exceeded');
  const tag = `docset-${release.variantId}-${release.version}-r${release.revision}-${release.releaseId}`;
  if (release.artifact.url !== `https://github.com/${values.repository}/releases/download/${tag}/Python.tgz`) throw new Error('Untrusted publication archive URL');
  const directory = path.join(work, release.releaseId);
  await mkdir(directory);
  await gh(['release', 'download', tag, '--repo', values.repository, '--pattern', 'Python.tgz', '--dir', directory]);
  const file = path.join(directory, 'Python.tgz'), bytes = await readFile(file);
  if (bytes.length !== release.artifact.bytes || await sha256(file) !== release.artifact.sha256) throw new Error('GitHub downloaded archive differs from published SHA-256/bytes');
  archives.set(release.releaseId, bytes);
  receipts.push({ releaseId: release.releaseId, version: release.version, revision: release.revision, url: release.artifact.url, sha256: release.artifact.sha256, bytes: bytes.length });
  console.log(`GITHUB_VERIFIED ${release.variantId} ${release.releaseId}`);
}
await writeFile(path.join(work, 'github-receipts.json'), JSON.stringify({ repository: values.repository, publicationHead: head, transport: 'authenticated-gh-download-to-local-TLS', releases: receipts }, null, 2));
await serveAcceptance(work, catalog, archives);
