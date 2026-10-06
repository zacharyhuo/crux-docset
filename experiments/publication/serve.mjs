import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GitHubFixture } from '../../test/helpers/publication.js';
import { GitHubPublication } from '../../src/publication/github.js';
import { restorePublication, publishCandidate } from '../../src/publication/publisher.js';
import { loadRecipe, hashBuildInputs } from '../../src/recipes.js';
import { loadRecipeIcons } from '../../src/icons.js';
import { fingerprint } from '../../src/identity.js';
import { getAdapter } from '../../src/adapters.js';
import { makeFeed } from '../../src/pipeline.js';

// Real official archives + real publisher, backed by an in-process GitHub fixture.
// HTTPS is an actual loopback TLS server; its one-day CA is scoped to the test
// session. No Keychain, system trust, production app or real GitHub writes.
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { work: { type: 'string' } } });
if (!values.work || !path.isAbsolute(values.work)) throw new Error('--work requires an absolute experiment parent');
await mkdir(values.work, { recursive: true });
const work = await mkdtemp(path.join(values.work, 'python-https-'));
console.log(`EXPERIMENT ${work}`);
const remote = new GitHubFixture();
const github = new GitHubPublication({ repository: remote.repository, token: 'fixture-token', fetcher: remote.fetch });
const publication = path.join(work, 'publication');
await restorePublication(publication, github);
for (const variantId of ['python-3-14-en', 'python-3-13-en']) {
  const { stdout, stderr } = await execute(process.execPath, ['src/cli.js', 'build', '--id', 'python', '--variant', variantId,
    '--work', path.join(work, variantId), '--publication-state', publication], { cwd: root, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(work, `${variantId}-build.log`), stdout + stderr);
  const result = JSON.parse(stdout);
  const { recipe, recipeDirectory } = await loadRecipe({ root, id: 'python', variantId });
  const icons = await loadRecipeIcons(recipeDirectory);
  const code = await hashBuildInputs(root, ['src', 'package-lock.json', ...getAdapter(recipe.builder.adapter).inputFiles]);
  code.recipeIcons = fingerprint(icons);
  const policy = JSON.parse(await readFile(path.join(root, 'publication/python.json')));
  const published = await publishCandidate({ directory: result.directory, publication, recipe, icons, policy, builderDigest: fingerprint(code), sourceCommit: 'c'.repeat(40), github });
  console.log(`QUALIFIED ${variantId} ${published.releaseId}`);
}
const state = remote.state();
await writeFile(path.join(work, 'fixture-github-state.json'), JSON.stringify(state, null, 2));
const tls = path.join(work, 'tls');
await mkdir(tls, { mode: 0o700 });
await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'extendedKeyUsage=serverAuth',
  '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'basicConstraints=critical,CA:FALSE',
  '-keyout', path.join(tls, 'key.pem'), '-out', path.join(tls, 'cert.pem')]);
await execute('openssl', ['x509', '-in', path.join(tls, 'cert.pem'), '-outform', 'DER', '-out', path.join(tls, 'cert.der')]);
let base, mode = 'old';
const requests = [];
const releases = state.catalog.families[0].releases;
const old = releases.find(r => r.versionLine === '3.13'), latest = releases.find(r => r.versionLine === '3.14');
const archives = new Map();
for (const release of releases) {
  const tag = new URL(release.artifact.url).pathname.split('/').at(-2);
  const entry = remote.releases.find(r => r.tag_name === tag).assets.find(a => a.name === 'Python.tgz');
  archives.set(release.releaseId, remote.assets.get(entry.id).bytes);
}
const catalog = () => {
  const copy = structuredClone(state.catalog), family = copy.families[0], selected = mode === 'old' ? old : latest;
  family.latestReleaseId = selected.releaseId; family.defaultVariantId = selected.variantId;
  for (const release of family.releases) release.artifact.url = `${base}/download/${release.releaseId}/Python.tgz`;
  return copy;
};
const server = createServer({ key: await readFile(path.join(tls, 'key.pem')), cert: await readFile(path.join(tls, 'cert.pem')) }, (request, response) => {
  const route = new URL(request.url, base).pathname;
  requests.push({ route, method: request.method });
  if (route.startsWith('/control/')) { mode = route.slice('/control/'.length); response.end('ok'); return; }
  if (route === '/catalog.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(mode === 'broken' ? '{invalid' : JSON.stringify(catalog())); return;
  }
  if (route === '/feed.xml') { response.end(makeFeed(latest.version, `${base}/download/${latest.releaseId}/Python.tgz`, latest.revision)); return; }
  const match = route.match(/^\/(download|assets|corrupt)\/([0-9a-f]{64})\/Python\.tgz$/);
  if (!match || !archives.has(match[2])) { response.writeHead(404); response.end(); return; }
  if (match[1] === 'download') { response.writeHead(302, { Location: `${base}/assets/${match[2]}/Python.tgz` }); response.end(); return; }
  let bytes = archives.get(match[2]);
  if (match[1] === 'corrupt') { bytes = Buffer.from(bytes); bytes[Math.floor(bytes.length / 2)] ^= 1; }
  response.setHeader('Content-Length', bytes.length); response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `https://127.0.0.1:${server.address().port}`;
const configuration = { catalogURL: `${base}/catalog.json`, caDER: (await readFile(path.join(tls, 'cert.der'))).toString('base64') };
await writeFile(path.join(work, 'PythonSupplyAcceptance.json'), JSON.stringify(configuration, null, 2));
console.log(`READY ${work}/PythonSupplyAcceptance.json`);
const deadline = setTimeout(() => stop(), 20 * 60_000);
async function stop() {
  clearTimeout(deadline);
  await writeFile(path.join(work, 'https-requests.json'), JSON.stringify(requests, null, 2));
  server.closeAllConnections(); server.close();
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
