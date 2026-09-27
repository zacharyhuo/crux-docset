import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { prepareSpringOfflinePage } from './offline.js';
import { createSpringReferencePolicy } from './references.js';
import { createSpringLinkResolver } from './links.js';
import { readSpringReferencePage } from './reference-page.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const relative = (from, to) => path.posix.relative(path.posix.dirname(from), to);
const sourcePrefix = 'framework-docs/modules/ROOT/pages/';
const safePath = value => typeof value === 'string' && value.length <= 4096 && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[\\\u0000-\u0020\u007f:%?#]/.test(p));

// No-follow, bounded reads from immutable local inputs. Does not authenticate
// Git commits: source acquisition must verify commit and rendered provenance.
async function reader(root, totalLimit = 256 * 1024 ** 2) {
  if (!path.isAbsolute(root)) throw new Error('Spring input root must be absolute');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Spring root must be a non-symlink directory');
  const base = await realpath(root); let total = 0;
  async function inspect(file) {
    if (!safePath(file)) throw new Error('Unsafe Spring input path');
    let current = base;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Spring input must be regular/non-symlink');
    }
    return current;
  }
  async function bytes(file, limit = 16 * 1024 ** 2) {
    const absolute = await inspect(file), initial = await lstat(absolute);
    if (!initial.isFile()) throw new Error('Spring input must be regular file');
    if (initial.size > limit || total + initial.size > totalLimit) throw new Error('Spring input size limit');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== initial.ino || stat.dev !== initial.dev || stat.size !== initial.size) throw new Error('Spring input changed during read');
      const result = Buffer.alloc(initial.size + 1); let count = 0;
      while (count < result.length) { const read = await handle.read(result, count, result.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat();
      if (count !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || await realpath(absolute) !== absolute) throw new Error('Spring input changed during read');
      total += count; return result.subarray(0, count);
    } finally { await handle.close(); }
  }
  async function list(prefix = '') {
    const files = []; let count = 0;
    async function walk(dir, depth) {
      if (depth > 32) throw new Error('Spring input depth limit');
      const directory = dir ? await inspect(dir) : base;
      for (const name of await readdir(directory)) {
        if (++count > 10000) throw new Error('Spring input file count limit');
        const file = dir ? `${dir}/${name}` : name;
        const stat = await lstat(await inspect(file));
        if (stat.isDirectory()) await walk(file, depth + 1); else files.push(file);
      }
    }
    await walk(prefix.replace(/\/$/, ''), 0); return files.sort();
  }
  return { bytes, list, text: async (file, limit) => new TextDecoder('utf-8', { fatal: true }).decode(await bytes(file, limit)) };
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Unsupported Spring PNG resource');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 50000000) throw new Error('Spring PNG dimensions limit');
  // Structural completeness, not pixel decoding (visual acceptance is separate).
  let offset = 33, chunks = 0, imageBytes = 0, ended = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12 || ++chunks > 10000) throw new Error('Truncated or oversized Spring PNG resource');
    const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (size > bytes.length - offset - 12 || kind === 'IHDR') throw new Error('Invalid Spring PNG chunk');
    if (kind === 'IDAT') imageBytes += size;
    offset += size + 12;
    if (kind === 'IEND') { if (size || offset !== bytes.length) throw new Error('Invalid Spring PNG end'); ended = true; break; }
  }
  if (!ended || !imageBytes) throw new Error('Missing Spring PNG image data/end');
  return { width, height };
}

function shell(title, body, file, version) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="component" content="framework"><meta name="version" content="${escape(version)}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><link rel="stylesheet" href="${escape(relative(file, 'offline.css'))}"></head><body>${body}</body></html>`;
}

/** renderedRoot is the single framework/<version> directory, not the site root.
 * destination must not exist; no candidate promotion or network is performed.
 */
export async function exportSpringReference({ sourceRoot, renderedRoot, destination, version, commit }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('Spring destination must be absolute');
  try { await lstat(destination); throw new Error('Spring destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = await reader(sourceRoot, 40 * 1024 ** 2), rendered = await reader(renderedRoot);
  const sources = new Map([['gradle.properties', await source.text('gradle.properties', 4 * 1024 ** 2)]]);
  for (const file of await source.list(sourcePrefix)) {
    if (!file.endsWith('.adoc')) throw new Error('Unsupported Spring source page file');
    sources.set(file.slice(sourcePrefix.length), await source.text(file, 4 * 1024 ** 2));
  }
  const policy = createSpringReferencePolicy({ version, commit, sources });
  const license = await source.text('LICENSE.txt', 1024 ** 2);
  if (!license.trim()) throw new Error('Missing Spring source license');
  const pages = new Map(), prepared = new Map(), redirects = new Map(), resources = new Set(), inputs = [], omitted = [], footerNotices = new Map();
  for (const file of await rendered.list()) {
    if (file.endsWith('.png')) { resources.add(file); continue; }
    if (/^_images\/[A-Za-z0-9_.-]+\.(svg|graffle)$/.test(file)) {
      // Known diagram authoring formats are not an offline content fallback.
      // Any HTML reference to one still fails the resolver below.
      omitted.push({ file, reason: 'unreferenced-diagram-source', sha256: sha(await rendered.bytes(file)) }); continue;
    }
    if (!file.endsWith('.html')) throw new Error(`Unsupported Spring rendered resource: ${file}`);
    const html = await rendered.text(file); inputs.push({ file, sha256: sha(html) });
    if (prepared.size >= 2000) throw new Error('Spring page count limit');
    const $ = load(html), refresh = $('meta[http-equiv]').filter((_, n) => $(n).attr('http-equiv').toLowerCase() === 'refresh');
    const footer = $('body > footer').clone();
    footer.find('script').replaceWith('[dynamic website text omitted; script not executed]');
    footer.find('style,svg,img').remove();
    footer.find('a[href]').each((_, node) => { $(node).append($('<span></span>').text(` (${node.attribs.href})`)); });
    const notice = footer.text().replace(/\s+/gu, ' ').trim();
    if (notice) {
      if (Buffer.byteLength(notice) > 32768 || (!footerNotices.has(notice) && footerNotices.size >= 16)) throw new Error('Spring footer notice size limit');
      if (!footerNotices.has(notice)) footerNotices.set(notice, file);
    }
    if (refresh.length) {
      const match = refresh.attr('content')?.match(/^0; url=([^\s]+)$/);
      if (refresh.length !== 1 || !match || $('article.doc').length || redirects.size >= 100) throw new Error('Unsupported Spring redirect');
      redirects.set(file, match[1]); continue;
    }
    if (file === 'page-layout.html') {
      const body = $('article.doc').clone(); body.find('nav,.breadcrumbs-container').remove();
      if (sources.get('page-layout.adoc') !== ':tabsize: 4\n:docinfo1:\n' || body.length !== 1 || body.text().trim() || body.find('img,pre,table').length) throw new Error('Unverified Spring layout helper');
      omitted.push({ file, sourceSha256: sha(sources.get('page-layout.adoc')) }); continue;
    }
    const body = prepareSpringOfflinePage(html, { version, outputPath: `reference/${file}` });
    if (!sources.has(file.replace(/\.html$/, '.adoc'))) throw new Error('Missing Spring source page');
    prepared.set(file, body); pages.set(file, body.contentAnchors);
  }
  if (!prepared.has('index.html')) throw new Error('Missing Spring reference homepage');
  const resolve = createSpringLinkResolver({ version, pages, resources, redirects, policy });
  // Validate even unreferenced aliases so a bad redirect is not silently skipped.
  for (const file of redirects.keys()) resolve(file, 'index.html');
  const output = new Map(), usedImages = new Set(), warnings = [], corrections = [], symbols = [];
  const counts = { local: 0, online: 0, unavailable: 0 };
  for (const [file, preparedPage] of prepared) {
    const $ = load(preparedPage.bodyHTML, null, false);
    for (const node of $('a[href],img[src]')) {
      const e = $(node), attribute = node.name === 'img' ? 'src' : 'href', original = e.attr(attribute), result = resolve(original, file);
      counts[result.kind]++;
      if (node.name === 'img') {
        if (result.kind !== 'local') throw new Error('Unsupported Spring remote image');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), result.href));
        usedImages.add(target); e.attr(attribute, result.href); continue;
      }
      if (result.kind === 'unavailable') {
        e.removeAttr('href').addClass('Crux-upstreamWarning');
        e.append($('<span class="Crux-linkNote"></span>').text(' [Section missing in this upstream version; '));
        // Sibling link avoids invalid nested anchors and preserves original text.
        const note = $('<span class="Crux-linkNote"></span>');
        note.append($('<a data-crux-online="source-evidence" rel="noreferrer noopener"></a>').attr('href', result.evidence).text('source evidence [Online]')).append(']'); e.after(note);
        warnings.push({ file, href: original, ...result });
      } else {
        e.attr('href', result.href);
        if (result.kind === 'online') e.attr('data-crux-online', 'external').attr('rel', 'noreferrer noopener').append($('<span class="Crux-linkNote"></span>').text(' [Online]'));
        if (result.ruleId) corrections.push({ file, original, href: result.href, ruleId: result.ruleId });
      }
    }
    const outputFile = `reference/${file}`;
    const nav = `<nav aria-label="Offline reference"><details><summary>Spring Framework ${escape(version)} — Contents</summary><ul>${[...prepared].map(([target, p]) => `<li><a href="${escape(relative(file, target))}">${escape(p.title)}</a></li>`).join('')}</ul></details></nav>`;
    const footer = `<footer><a href="${escape(relative(outputFile, 'NOTICES.txt'))}">Sources, license and adaptations</a></footer>`;
    output.set(outputFile, shell(preparedPage.title, `${nav}<main>${$.html()}</main>${footer}`, outputFile, version));
    symbols.push(...preparedPage.symbols);
  }
  const images = new Map();
  for (const file of usedImages) {
    const bytes = await rendered.bytes(file); const dimensions = pngDimensions(bytes);
    images.set(`reference/${file}`, bytes); inputs.push({ file, sha256: sha(bytes), ...dimensions });
  }
  // No source/UI JS, webfonts or upstream styles are shipped.
  const stylesheet = await readFile(new URL('./offline.css', import.meta.url), 'utf8');
  await mkdir(destination); const documentsRoot = path.join(destination, 'Documents'); await mkdir(documentsRoot);
  async function save(file, data) { const target = path.join(documentsRoot, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx' }); }
  for (const [file, html] of output) await save(file, html);
  for (const [file, bytes] of images) await save(file, bytes);
  await save('offline.css', stylesheet); await save('licenses/SPRING-LICENSE.txt', license);
  await save('licenses/UPSTREAM-NOTICES.txt', footerNotices.size ? [...footerNotices].map(([text, file]) => `Upstream rendered footer (${file}):\n${text}\n`).join('\n') : 'No upstream footer text was present in rendered inputs.\n');
  await save('NOTICES.txt', `Spring Framework ${version}, source commit ${commit}.\nSource license: licenses/SPRING-LICENSE.txt. Rendered footer copyright/trademark notices and legal URLs: licenses/UPSTREAM-NOTICES.txt.\nCrux adaptations: reference-only offline layout, native collapsible contents and language examples, textual admonitions, source-backed link corrections and explicit missing-section warnings. Online links are marked. Code is not executed. Upstream scripts, website navigation, styles and fonts are not included. Dynamic footer text (such as runtime year) is explicitly marked rather than executing website code.\nSource acquisition must authenticate the source commit and rendered inputs before calling this exporter; the exporter validates local structure and content, not Git provenance or redistribution eligibility.\n`);
  const closure = await verifySpringOfflineTree(documentsRoot);
  const evidence = { version, commit, pages: prepared.size, images: images.size, tabPanels: [...prepared.values()].reduce((n, p) => n + p.tabPanels, 0),
    links: counts, warnings, corrections, omitted, redirects: [...redirects], inputs, referenceRules: policy.evidence, closure };
  await writeFile(path.join(destination, 'export-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return { documentsRoot, symbols, evidence };
}

/** Verify final files afresh, independent of preparation or correction policy. */
export async function verifySpringOfflineTree(root) {
  const input = await reader(root), files = new Set(await input.list()), pages = new Map();
  if (!files.has('reference/index.html') || !files.has('offline.css') || !files.has('licenses/SPRING-LICENSE.txt') || !files.has('licenses/UPSTREAM-NOTICES.txt') || !files.has('NOTICES.txt')) throw new Error('Missing Spring offline root files');
  const css = await readFile(new URL('./offline.css', import.meta.url), 'utf8');
  let totalBytes = 0, localLinks = 0, onlineLinks = 0, version;
  const tags = new Set('html head meta title link body main footer details summary article div nav ul li a h1 p h2 code table caption colgroup col thead tr th tbody td em span pre i h3 b dl dt dd img h4 strong ol blockquote sup h5 h6 br hr'.split(' '));
  const attributes = new Set('class aria-label id title href style aria-labelledby data-lang data-value src alt width name open lang charset content http-equiv rel data-crux-online'.split(' '));
  for (const file of files) {
    const bytes = await input.bytes(file); totalBytes += bytes.length;
    if (file.endsWith('.png')) { pngDimensions(bytes); continue; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (file === 'offline.css') { if (text !== css) throw new Error('Unsupported Spring CSS stylesheet'); continue; }
    if (['NOTICES.txt', 'licenses/SPRING-LICENSE.txt', 'licenses/UPSTREAM-NOTICES.txt'].includes(file)) { if (!text.trim()) throw new Error('Missing Spring notices/license'); continue; }
    if (!file.startsWith('reference/') || !file.endsWith('.html')) throw new Error('Unsupported Spring offline resource');
    const $ = load(text), ids = new Set();
    const actualVersion = $('meta[name="version"]').attr('content'); version ??= actualVersion;
    readSpringReferencePage(text, { version, outputPath: file });
    for (const node of $('*')) {
      if (!tags.has(node.name)) throw new Error(`Unsupported Spring output component: ${node.name}`);
      for (const attr of Object.keys(node.attribs)) if (!attributes.has(attr)) throw new Error(`Unsupported Spring output attribute/resource: ${attr}`);
      if (node.attribs.style !== undefined && (node.name !== 'col' || !/^width: (?:100|\d{1,2}(?:\.\d{1,4})?)%;$/.test(node.attribs.style))) throw new Error('Unsupported Spring output CSS/resource');
      if (node.attribs['http-equiv'] && (node.name !== 'meta' || node.attribs['http-equiv'].toLowerCase() !== 'content-security-policy')) throw new Error('Unsupported Spring output meta action');
      for (const id of new Set([node.attribs.id, node.name === 'a' ? node.attribs.name : undefined].filter(v => v !== undefined))) {
        if (!id || ids.has(id)) throw new Error('Unsupported duplicate Spring offline anchor'); ids.add(id);
      }
    }
    pages.set(file, { ids, refs: $('[href],[src]').toArray().map(n => ({ tag: n.name, ...n.attribs })) });
  }
  for (const [from, page] of pages) for (const ref of page.refs) {
    if (ref.src !== undefined && ref.tag !== 'img' || ref.href !== undefined && !['a', 'link'].includes(ref.tag)) throw new Error('Unsupported Spring resource attribute owner');
    const href = ref.href ?? ref.src;
    if (ref.tag === 'a' && /^https?:\/\//.test(href)) {
      const url = new URL(href);
      if (!ref['data-crux-online'] || url.username || url.password || /[\\\u0000-\u0020\u007f]/.test(href)) throw new Error('Unsafe or unmarked Spring online link');
      onlineLinks++; continue;
    }
    if (typeof href !== 'string' || href.length > 8192 || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href) || /[?\\\u0000-\u0020\u007f]/.test(href)) throw new Error('Unsafe Spring offline resource/link');
    const hash = href.indexOf('#'), rawPath = hash < 0 ? href : href.slice(0, hash);
    if (/%(?:2f|5c)/i.test(rawPath)) throw new Error('Unsafe Spring encoded path separator');
    const decoded = decodeURIComponent(rawPath), fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
    if (decoded.startsWith('/') || /[%?#:\\\u0000-\u0020\u007f]/.test(decoded)) throw new Error('Unsafe Spring decoded path');
    const target = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)) : from;
    if (!safePath(target) || !files.has(target) || (fragment && !pages.get(target)?.ids.has(fragment))) throw new Error(`Missing Spring offline target ${target}#${fragment}`);
    if (ref.tag === 'img' ? (!ref.src || ref.href || !target.endsWith('.png')) : ref.tag === 'link' ? (ref.rel !== 'stylesheet' || target !== 'offline.css' || ref.src) : ref.tag !== 'a' || ref.src) throw new Error('Unsupported Spring output resource component');
    localLinks++;
  }
  return { files: files.size, pages: pages.size, bytes: totalBytes, localLinks, onlineLinks, brokenLinks: 0 };
}
