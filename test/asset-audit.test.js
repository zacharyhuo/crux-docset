import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCLI } from '../src/commands.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-asset-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = path.join(root, 'Documents'), manifest = path.join(root, 'assets.json');
  await mkdir(documents);
  const content = { 'index.html': '<h1>Example</h1>', 'main.js': 'example()', 'LICENSE.txt': 'Example license text' };
  for (const [name, bytes] of Object.entries(content)) await writeFile(path.join(documents, name), bytes);
  const data = { schemaVersion: 1, components: [{ id: 'example', version: '1.0', source: 'https://example.org/source/1.0',
    reviewed: true, license: 'MIT', notices: ['LICENSE.txt'] }],
    files: Object.entries(content).map(([name, bytes]) => ({ path: name, sha256: hash(bytes), components: ['example'] })) };
  const run = async () => {
    await writeFile(manifest, JSON.stringify(data));
    const result = await runCLI(['audit-assets', '--documents', documents, '--manifest', manifest], { root });
    return { ...result, report: JSON.parse(result.output) };
  };
  return { root, documents, data, run };
}

test('offline audit matches all files and shipped notice content without a registered recipe', async t => {
  const f = await fixture(t), { exitCode, report } = await f.run();
  assert.equal(exitCode, 0); assert.equal(report.passed, true);
  assert.equal(report.fileCount, 3); assert.deepEqual(report.errors, []);
});

for (const [name, change, message] of [
  ['changed resource', f => writeFile(path.join(f.documents, 'main.js'), 'changed()'), /checksum/i],
  ['missing notice', f => rm(path.join(f.documents, 'LICENSE.txt')), /missing/i],
  ['changed notice', f => writeFile(path.join(f.documents, 'LICENSE.txt'), 'different license'), /checksum/i],
  ['unknown extension', f => writeFile(path.join(f.documents, 'data.custom'), 'new resource'), /unlisted/i],
  ['unreviewed component', f => { f.data.components[0].reviewed = false; }, /review/i],
  ['unmapped component', f => { f.data.files[0].components = ['other']; }, /component/i],
  ['no attribution', f => { f.data.components[0].notices = []; }, /notice/i],
  ['unlisted notice', f => { f.data.components[0].notices = ['absent.txt']; }, /notice/i],
  ['duplicate record', f => { f.data.files.push(f.data.files[0]); }, /duplicate/i],
  ['traversal', f => { f.data.files[0].path = '../outside'; }, /path/i],
  ['credential URL', f => { f.data.components[0].source = 'https://user:password@example.org/'; }, /source/i],
  ['symbolic file', async f => { await rm(path.join(f.documents, 'main.js')); await symlink('LICENSE.txt', path.join(f.documents, 'main.js')); }, /symlink/i],
  ['symbolic directory', async f => { await mkdir(path.join(f.root, 'outside')); await symlink(path.join(f.root, 'outside'), path.join(f.documents, 'extra')); }, /symlink/i],
]) test(`asset audit rejects ${name}`, async t => {
  const f = await fixture(t); await change(f);
  const result = await f.run();
  assert.equal(result.exitCode, 1); assert.equal(result.report.passed, false);
  assert.match(result.report.errors.join('\n'), message);
});

test('asset audit rejects build flags and requires explicit input paths', async () => {
  await assert.rejects(runCLI(['audit-assets', '--documents', '/unused'], { root: '/unused' }), /manifest/i);
  await assert.rejects(runCLI(['audit-assets', '--documents', '/unused', '--manifest', '/unused', '--base-url', 'https://example.org'], { root: '/unused' }), /only accepts/i);
});
