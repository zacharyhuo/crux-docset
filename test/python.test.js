import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { load } from 'cheerio';
import * as python from '../src/python.js';
import { extractZip, download, documentVersion, builderEnvironment, withOfficialSource } from '../src/python.js';

test('Python navigation becomes a closed native disclosure without losing links or anchors', () => {
  const input = '<html><head></head><body><div class="document"><div class="documentwrapper"><div class="bodywrapper"><div class="body"><h1 id="topic">Topic</h1></div></div></div><div class="sphinxsidebar" role="navigation"><div class="sphinxsidebarwrapper"><a href="#topic">Topic</a><a href="../index.html">Home</a></div><div id="sidebarbutton">«</div></div></div></body></html>';
  assert.equal(typeof python.adaptPythonNavigation, 'function');
  const output = python.adaptPythonNavigation(input);
  const $ = load(output);
  const disclosure = $('details.crux-python-navigation');
  assert.equal(disclosure.length, 1);
  assert.equal(disclosure.attr('open'), undefined);
  assert.equal(disclosure.children().first()[0].tagName, 'summary');
  assert.equal(disclosure.find('a[href="#topic"]').length, 1);
  assert.equal(disclosure.find('a[href="../index.html"]').length, 1);
  assert.equal($('.body #topic').text(), 'Topic');
  assert.equal($('#sidebarbutton').length, 0);
  assert.equal($('script').length, 0);
  assert.equal(python.adaptPythonNavigation(output), output);
  assert.equal(python.adaptPythonNavigation('<p>No sidebar</p>'), '<p>No sidebar</p>');
  assert.throws(() => python.adaptPythonNavigation('<div class="sphinxsidebar">Changed upstream layout</div>'), /layout/i);
});

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

test('a Python archive from another minor is rejected before invoking doc2dash', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-python-line-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'python-html'));
  await writeFile(path.join(root, 'python-html', 'index.html'), '<title>Python 3.15.0 documentation</title>');
  execFileSync('zip', ['-qr', path.join(root, 'source.zip'), 'python-html'], { cwd: root });
  const candidate = path.join(root, 'candidate');
  await mkdir(candidate);
  await assert.rejects(python.buildPython(candidate, { versionLine: '3.14', builder: { doc2dash: 'deliberately invalid' } }, path.join(root, 'source.zip'), {}), /version line/i);
});

test('source discovery cannot follow a cross-minor download on a fixed version line', async t => {
  const { pythonAdapter } = await import('../src/adapters/python.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'crux-python-resolve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const urls = [];
  await assert.rejects(pythonAdapter.resolve({ versionLine: '3.14', source: { discoveryUrl: 'https://docs.python.org/3.14/download.html' } }, { directory, fetcher: async url => { urls.push(url); return new Response('<a href="https://docs.python.org/3.15/archives/python-3.15-docs-html.zip">HTML</a>'); } }), /version line/);
  assert.deepEqual(urls, ['https://docs.python.org/3.14/download.html']);
});
