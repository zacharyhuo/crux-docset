import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:https';
import { serveAcceptance } from '../experiments/publication/https-fixture.mjs';

test('acceptance transport verifies TLS, routes exact release bytes, and scopes the damaged download to its test endpoint', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-acceptance-tls-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const catalog = JSON.parse(await readFile(new URL('./fixtures/version-catalog/v1.json', import.meta.url)));
  const [old, latest] = catalog.families[0].releases;
  old.support = 'supported';
  const bytes = Buffer.from('actual-transport-bytes');
  const server = await serveAcceptance(work, catalog, new Map([[old.releaseId, bytes], [latest.releaseId, bytes]]));
  t.after(server.stop);
  const ca = await readFile(path.join(work, 'tls/cert.pem'));
  const get = route => new Promise((resolve, reject) => {
    const req = request(`${server.base}${route}`, { ca, rejectUnauthorized: true }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(JSON.parse((await get('/catalog.json')).bytes).families[0].latestReleaseId, old.releaseId);
  await get('/control/new');
  assert.equal(JSON.parse((await get('/catalog.json')).bytes).families[0].latestReleaseId, latest.releaseId);
  const redirect = await get(`/download/${latest.releaseId}/Python.tgz`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `${server.base}/assets/${latest.releaseId}/Python.tgz`);
  assert.deepEqual((await get(`/assets/${latest.releaseId}/Python.tgz`)).bytes, bytes);
  assert.notDeepEqual((await get(`/corrupt/${latest.releaseId}/Python.tgz`)).bytes, bytes);
  assert.deepEqual((await get(`/assets/${latest.releaseId}/Python.tgz`)).bytes, bytes, 'test corruption never mutates the original verified archive');
  await get('/control/broken');
  const broken = await get('/catalog.json');
  assert.equal(broken.bytes.toString(), '{invalid');
  assert.throws(() => JSON.parse(broken.bytes));
  await server.stop();
  const receipts = JSON.parse(await readFile(path.join(work, 'https-requests.json')));
  assert.ok(receipts.some(r => r.route.startsWith('/corrupt/')));
});
