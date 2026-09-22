import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, rm, mkdtemp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import * as plist from 'plist';
import { load } from 'cheerio';
import { safeArchivePath, discoverPython } from './pipeline.js';

const execute = promisify(execFile);

// Native disclosure works even when the docset's JavaScript opt-out is respected.
export function adaptPythonNavigation(html) {
  const $ = load(html);
  if ($('details.crux-python-navigation').length || !$('.sphinxsidebar').length) return html;
  const sidebar = $('.sphinxsidebar');
  const body = $('.bodywrapper');
  if (sidebar.length !== 1 || body.length !== 1 || !sidebar.find('.sphinxsidebarwrapper').length) {
    throw new Error('Unsupported Python sidebar layout');
  }
  sidebar.find('#sidebarbutton').remove();
  const disclosure = $('<details class="crux-python-navigation"><summary>Documentation navigation</summary></details>');
  disclosure.append(sidebar);
  body.prepend(disclosure);
  $('head').append(`<style id="crux-python-navigation-style">
div.document .bodywrapper { margin-left: 0; }
details.crux-python-navigation { margin: 0 0 1em; padding: .5em .75em; }
details.crux-python-navigation > summary { cursor: pointer; width: fit-content; }
details.crux-python-navigation > summary:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
details.crux-python-navigation > div.sphinxsidebar {
  display: block; position: static; float: none; width: 100%;
  margin: .5em 0 0; max-height: none;
}
details.crux-python-navigation .sphinxsidebarwrapper { height: auto; max-height: 50vh; overflow: auto; }
</style>`);
  return $.html();
}
export async function withOfficialSource(recipe, work, consume, fetcher = fetch) {
  const directory = await mkdtemp(path.join(work, 'download-'));
  try {
    const discovery = path.join(directory, 'discovery.html');
    await download(recipe.source.discoveryUrl, discovery, { maxBytes: 2 * 1024 * 1024, fetcher });
    const url = discoverPython(await readFile(discovery, 'utf8'), recipe.source.discoveryUrl);
    const archive = path.join(directory, 'source.zip');
    await download(url, archive, { fetcher });
    return await consume(archive, url);
  } finally {
    // This exact directory was allocated by this invocation, never user input.
    await rm(directory, { recursive: true, force: true });
  }
}
export function builderEnvironment(env = process.env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR'];
  return { ...Object.fromEntries(allowed.filter(key => env[key]).map(key => [key, env[key]])), UV_NO_CONFIG: '1', PYTHONNOUSERSITE: '1', LANG: 'C.UTF-8' };
}

export function documentVersion(html) {
  const version = load(html)('title').text().match(/^(?:Python )?(\d+\.\d+\.\d+) documentation$/i);
  if (!version) throw new Error('Cannot establish document version from archive');
  return version[1];
}

export async function download(url, destination, { maxBytes = 128 * 1024 * 1024, fetcher = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.python.org' || parsed.port || parsed.username || parsed.password) throw new Error('Source must use official HTTPS host');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Download size limit exceeded');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  let bytes = 0;
  try {
    await pipeline(response.body, new Transform({ transform(chunk, _, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('Download size limit exceeded') : null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return { bytes };
}

export async function extractZip(file, destination, { maxBytes = 1024 ** 3, maxFiles = 30000 } = {}) {
  // Always a fresh directory: an existing symlink must never redirect extraction.
  await mkdir(destination, { recursive: false });
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
  let bytes = 0, files = 0;
  const seen = new Set();
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          const name = safeArchivePath(entry.fileName);
          if (++files > maxFiles || (bytes += entry.uncompressedSize) > maxBytes) throw new Error('Extraction limit exceeded');
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000) throw new Error(`Unsupported ZIP entry: ${name}`);
          const key = name.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) throw new Error(`Duplicate ZIP path: ${name}`);
          seen.add(key);
          const target = path.join(destination, name);
          if (name.endsWith('/')) await mkdir(target, { recursive: true });
          else {
            await mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
            await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export async function buildPython(candidate, recipe, archive, icons) {
  const source = path.join(candidate, 'source');
  await extractZip(archive, source, recipe.limits);
  const directories = await readdir(source, { withFileTypes: true });
  if (directories.length !== 1 || !directories[0].isDirectory()) throw new Error('Unexpected Python archive layout');
  const htmlRoot = path.join(source, directories[0].name);
  const version = documentVersion(await readFile(path.join(htmlRoot, 'index.html'), 'utf8'));
  const builderProject = fileURLToPath(new URL('../tools/doc2dash/', import.meta.url));
  if (recipe.builder.doc2dash !== '3.1.0') throw new Error('Recipe builder must match locked doc2dash 3.1.0');
  const { stdout, stderr } = await execute('uv', ['run', '--project', builderProject, '--frozen', 'doc2dash', '-n', recipe.bundleName, '-d', candidate, '-I', recipe.homepage, htmlRoot], { env: builderEnvironment(), timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(candidate, 'builder.log'), stdout + stderr);
  const bundle = path.join(candidate, `${recipe.bundleName}.docset`);
  for (const name of ['icon.png', 'icon@2x.png']) await writeFile(path.join(bundle, name), icons[name]);
  const documents = path.join(bundle, 'Contents', 'Resources', 'Documents');
  for (const entry of await readdir(documents, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const original = await readFile(file, 'utf8');
    const adapted = adaptPythonNavigation(original);
    if (adapted !== original) await writeFile(file, adapted);
  }
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const info = plist.parse(await readFile(plistPath, 'utf8'));
  info.CFBundleIdentifier = recipe.identifier;
  info.CFBundleName = recipe.name;
  info.DashDocSetFamily = recipe.id;
  info.isJavaScriptEnabled = false;
  await writeFile(plistPath, plist.build(info));
  await writeFile(path.join(bundle, 'meta.json'), JSON.stringify({ name: recipe.name, version, extra: { indexFilePath: recipe.homepage, isJavaScriptEnabled: false } }, null, 2));
  return { version };
}
