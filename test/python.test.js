import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extractZip, download, documentVersion, builderEnvironment, withOfficialSource } from '../src/python.js';

test('builder subprocesses do not inherit credentials or arbitrary interpreter hooks', () => {
  const env = builderEnvironment({ PATH: '/bin', HOME: '/home/test', GH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', PYTHONPATH: '/bad', NODE_OPTIONS: '--require=bad' });
  assert.equal(env.PATH, '/bin');
  for (const key of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PYTHONPATH', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
});

test('document version comes from archive HTML rather than mutable discovery page', () => {
  assert.equal(documentVersion('<title>Python 3.14.7 documentation</title>'), '3.14.7');
  assert.equal(documentVersion('<title>3.14.7 Documentation</title>'), '3.14.7');
  assert.throws(() => documentVersion('<title>Unknown</title>'));
});

test('download bounds actual streamed bytes, rejects non-HTTPS and failures', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-download-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const target = path.join(work, 'file');
  const fetcher = async () => new Response('123456');
  await assert.rejects(download('https://docs.python.org/x', target, { maxBytes: 5, fetcher }), /limit/i);
  await download('https://docs.python.org/x', target, { maxBytes: 6, fetcher });
  assert.equal(await readFile(target, 'utf8'), '123456');
  await assert.rejects(download('http://docs.python.org/x', target, { fetcher }), /HTTPS/i);
  await assert.rejects(download('https://docs.python.org/x', target, { fetcher: async () => new Response('', { status: 500 }) }), /500/);
});

test('ZIP extraction enforces file count and byte limits on real archives', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-zip-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(path.join(work, 'input'));
  await writeFile(path.join(work, 'input', 'index.html'), 'abcdef');
  execFileSync('zip', ['-q', path.join(work, 'source.zip'), 'index.html'], { cwd: path.join(work, 'input') });
  await extractZip(path.join(work, 'source.zip'), path.join(work, 'good'), { maxBytes: 6, maxFiles: 1 });
  assert.equal(await readFile(path.join(work, 'good', 'index.html'), 'utf8'), 'abcdef');
  await assert.rejects(extractZip(path.join(work, 'source.zip'), path.join(work, 'bad'), { maxBytes: 5, maxFiles: 1 }), /limit/i);
  await assert.rejects(extractZip(path.join(work, 'source.zip'), path.join(work, 'count'), { maxBytes: 6, maxFiles: 0 }), /limit/i);
});

test('invocation downloads are removed even when the consuming build fails', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'crux-source-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fetcher = async url => new Response(url.endsWith('.html') ? '<a href="archives/python-3.14-docs-html.zip">HTML</a>' : 'archive');
  await assert.rejects(withOfficialSource({ source: { discoveryUrl: 'https://docs.python.org/3/download.html' } }, work, async archive => {
    assert.equal(await readFile(archive, 'utf8'), 'archive');
    throw new Error('builder failed');
  }, fetcher), /builder failed/);
  assert.deepEqual(await readdir(work), []);
});
