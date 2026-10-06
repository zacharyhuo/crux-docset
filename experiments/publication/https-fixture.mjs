import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { makeFeed } from '../../src/pipeline.js';
import { validateReleaseCatalog } from '../../src/release-catalog.js';

// Shared transport fixture only: package bytes and their provenance are supplied
// by either the offline publisher experiment or the authenticated GitHub reader.
export async function serveAcceptance(work, publishedCatalog, archives) {
  validateReleaseCatalog(publishedCatalog);
  const releases = publishedCatalog.families.find(f => f.sourceId === 'dev.crux' && f.familyId === 'python')?.releases;
  const old = releases?.filter(r => r.versionLine === '3.13').sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1);
  const latest = releases?.find(r => r.releaseId === publishedCatalog.families.find(f => f.familyId === 'python').latestReleaseId);
  if (!old || latest?.versionLine !== '3.14' || releases.some(r => !archives.has(r.releaseId))) throw new Error('Acceptance requires the published default and historical Python lines');
  const tls = path.join(work, 'tls');
  await mkdir(tls, { mode: 0o700 });
  const execute = promisify(execFile);
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-keyout', path.join(tls, 'key.pem'), '-out', path.join(tls, 'cert.pem')]);
  await execute('openssl', ['x509', '-in', path.join(tls, 'cert.pem'), '-outform', 'DER', '-out', path.join(tls, 'cert.der')]);
  let base, mode = 'old';
  const requests = [];
  const catalog = () => {
    const copy = structuredClone(publishedCatalog), family = copy.families.find(f => f.familyId === 'python'), selected = mode === 'old' ? old : latest;
    family.latestReleaseId = selected.releaseId; family.defaultVariantId = selected.variantId;
    for (const release of family.releases) release.artifact.url = `${base}/download/${release.releaseId}/Python.tgz`;
    return copy;
  };
  const server = createServer({ key: await readFile(path.join(tls, 'key.pem')), cert: await readFile(path.join(tls, 'cert.pem')) }, (request, response) => {
    const route = new URL(request.url, base).pathname;
    requests.push({ route, method: request.method });
    if (['/control/old', '/control/new', '/control/broken'].includes(route)) { mode = route.slice('/control/'.length); response.end('ok'); return; }
    if (route === '/catalog.json') { response.setHeader('Content-Type', 'application/json'); response.end(mode === 'broken' ? '{invalid' : JSON.stringify(catalog())); return; }
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
  await writeFile(path.join(work, 'PythonSupplyAcceptance.json'), JSON.stringify({ catalogURL: `${base}/catalog.json`, caDER: (await readFile(path.join(tls, 'cert.der'))).toString('base64') }, null, 2));
  console.log(`READY ${work}/PythonSupplyAcceptance.json`);
  const deadline = setTimeout(stop, 20 * 60_000);
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(deadline);
    server.closeAllConnections(); server.close();
    await writeFile(path.join(work, 'https-requests.json'), JSON.stringify(requests, null, 2));
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { stop, base };
}
