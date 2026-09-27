import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { load } from 'cheerio';
import { createGoLinkResolver } from './links.js';
import { prepareGoOfflinePage, adaptGoOfflinePage } from './offline.js';
import { selectGoSymbols } from './page.js';

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const relative = (from, to) => path.posix.relative(path.posix.dirname(from), to);
const styles = new Set(['padding-left: 20px; list-style: initial;', 'margin: 6px 0 6px 0;']);
function shell(title, body, file) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escape(title)}</title><link rel="stylesheet" href="${escape(relative(file, 'offline.css'))}"></head><body>${body}</body></html>`;
}
function packageLinks(inventory, file) {
  const first = new Map();
  for (const entry of inventory.pages) if (!first.has(entry.packagePath)) first.set(entry.packagePath, entry);
  return [...first].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => `<li><a href="${escape(relative(file, entry.outputPath))}">${escape(name)}</a></li>`).join('');
}

/** Only call with the verified SDK/license inputs and finite runtime inventory. */
export async function exportGoDocs(session, inventory, { destination, sourceLock, goroot, licenses }) {
  if (!sourceLock || !/^1\.\d+\.\d+$/.test(sourceLock.version) || session.version !== sourceLock.version) throw new Error('Go export session/source version mismatch');
  if (!Array.isArray(inventory.pages) || !inventory.pages.length || inventory.pages.length > 10000) throw new Error('Invalid Go export inventory size');
  if (!path.isAbsolute(destination) || !licenses || ['go', 'pkgsite'].some(key => typeof licenses[key] !== 'string' || !licenses[key].trim() || Buffer.byteLength(licenses[key]) > 1024 ** 2)) throw new Error('Go export requires destination and licenses');
  const anchors = new Map(inventory.pages.map(p => [p.outputPath, new Set()]));
  // Validate all output paths and duplicates before any filesystem mutation.
  createGoLinkResolver(inventory, { version: sourceLock.version, goroot, anchors });
  await mkdir(destination);
  const documentsRoot = path.join(destination, 'Documents'), staging = path.join(destination, 'prepared');
  await mkdir(documentsRoot); await mkdir(staging);
  const indexed = [], warnings = [], links = { local: 0, online: 0, literal: 0 };
  let bytes = 0, removedControls = 0;
  for (const [i, entry] of inventory.pages.entries()) {
    const html = await session.readPage(entry.route);
    bytes += Buffer.byteLength(html);
    if (bytes > 1024 ** 3) throw new Error('Go export total page size limit');
    const prepared = prepareGoOfflinePage(html, { ...entry, version: sourceLock.version });
    anchors.set(entry.outputPath, prepared.anchors);
    indexed.push({ context: entry.context, symbols: prepared.symbols });
    removedControls += prepared.removedControls;
    await writeFile(path.join(staging, `${i}.html`), prepared.bodyHTML, { flag: 'wx' });
  }
  const resolve = createGoLinkResolver(inventory, { version: sourceLock.version, goroot, anchors });
  for (const [i, entry] of inventory.pages.entries()) {
    const adapted = adaptGoOfflinePage({ bodyHTML: await readFile(path.join(staging, `${i}.html`), 'utf8') }, entry, resolve);
    warnings.push(...adapted.warnings.map(w => ({ page: entry.outputPath, ...w })));
    for (const kind of Object.keys(links)) links[kind] += adapted.links[kind];
    const platforms = inventory.pages.filter(p => p.packagePath === entry.packagePath).map(p =>
      `<a href="${escape(relative(entry.outputPath, p.outputPath))}"${p.context === entry.context ? ' aria-current="page"' : ''}>${escape(p.context)}</a>`).join(' · ');
    const nav = `<nav aria-label="Offline documentation"><a href="${escape(relative(entry.outputPath, 'index.html'))}">Go ${escape(sourceLock.version)}</a>
      <details><summary>Packages</summary><ul>${packageLinks(inventory, entry.outputPath)}</ul></details><p>Platform: ${platforms}</p></nav>`;
    const output = shell(`${entry.packagePath} — Go ${sourceLock.version} (${entry.context})`, `${nav}<main><h1>${escape(entry.packagePath)}</h1>${adapted.bodyHTML}</main>`, entry.outputPath);
    if (output.includes(goroot)) throw new Error('Go export retained local SDK path');
    const file = path.join(documentsRoot, entry.outputPath);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, output, { flag: 'wx' });
  }
  const namespaces = new Set();
  for (const entry of inventory.pages) {
    const parts = entry.packagePath.split('/');
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i).join('/'));
  }
  const groups = [...namespaces].sort().map(name => `<section id="package-group-${escape(name.replaceAll('/', '-'))}"><h2>${escape(name)}</h2><ul>${packageLinks({ pages: inventory.pages.filter(p => p.packagePath.startsWith(`${name}/`)) }, 'index.html')}</ul></section>`).join('');
  await writeFile(path.join(documentsRoot, 'index.html'), shell(`Go ${sourceLock.version}`, `<main><h1>Go ${sourceLock.version}</h1><p>Offline standard library documentation. <a href="NOTICES.txt">Notices and adaptations</a></p><ul>${packageLinks(inventory, 'index.html')}</ul>${groups}</main>`, 'index.html'), { flag: 'wx' });
  await writeFile(path.join(documentsRoot, 'offline.css'), await readFile(new URL('./offline.css', import.meta.url)), { flag: 'wx' });
  await mkdir(path.join(documentsRoot, 'licenses'));
  for (const [key, filename] of [['go', 'GO-LICENSE.txt'], ['pkgsite', 'PKGSITE-LICENSE.txt']]) await writeFile(path.join(documentsRoot, 'licenses', filename), licenses[key], { flag: 'wx' });
  await writeFile(path.join(documentsRoot, 'NOTICES.txt'), `Go ${sourceLock.version} standard library documentation, rendered with golang.org/x/pkgsite.
Copyright and license texts: licenses/GO-LICENSE.txt and licenses/PKGSITE-LICENSE.txt.
Crux adaptations: local package/context links, collapsible package navigation, system-font stylesheet, explicit online link labels, reviewed upstream broken-reference labels.
Examples are shown as source and are not executed offline. Supplied outputs are preserved. Run, Share and Format server actions are removed. No upstream scripts or site chrome are included.
Documentation body has no required images/fonts in this verified renderer version. Unknown body resources or dynamic components fail the build instead of being omitted.
Online references preserve upstream destinations (including original HTTP references); they are not required to read the offline documentation.
`, { flag: 'wx' });
  const closure = await verifyGoOfflineTree(documentsRoot);
  const symbols = selectGoSymbols(indexed);
  const evidence = { version: sourceLock.version, pages: inventory.pages.length, inputBytes: bytes, removedControls, links, warnings, closure };
  await writeFile(path.join(destination, 'export-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return { documentsRoot, symbols, evidence };
}

/** Re-read final artifacts; no renderer, network or input DOM is consulted. */
export async function verifyGoOfflineTree(root) {
  const files = new Set(), pages = new Map();
  const stylesheet = await readFile(new URL('./offline.css', import.meta.url), 'utf8');
  let bytes = 0, localLinks = 0, onlineLinks = 0;
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name), stat = await lstat(filename);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Unsupported Go offline filesystem entry');
      if (stat.isDirectory()) { await walk(filename); continue; }
      bytes += stat.size;
      if (bytes > 1024 ** 3 || files.size >= 20000) throw new Error('Go offline tree size limit');
      const relativePath = path.relative(root, filename).split(path.sep).join('/');
      if (!/\.(html|css|txt)$/.test(relativePath)) throw new Error('Unsupported Go offline resource');
      const text = await readFile(filename, 'utf8'); files.add(relativePath);
      if (relativePath.endsWith('.css') && (relativePath !== 'offline.css' || text !== stylesheet)) throw new Error('Unsupported CSS stylesheet/resource');
      if (!relativePath.endsWith('.html')) continue;
      const $ = load(text), ids = new Set();
      if ($('script,iframe,object,embed,base,form,svg,[src],[srcset]').length) throw new Error('Unsupported script or resource in Go output');
      for (const node of $('*')) {
        for (const key of Object.keys(node.attribs)) if (/^on/i.test(key)) throw new Error('Unsupported Go executable attribute');
        if (node.attribs.style !== undefined && !styles.has(node.attribs.style)) throw new Error('Unsupported Go style resource');
        for (const id of new Set([node.attribs.id, node.name === 'a' ? node.attribs.name : undefined].filter(Boolean))) {
          if (ids.has(id)) throw new Error('Duplicate Go offline anchor'); ids.add(id);
        }
      }
      for (const node of $('meta[http-equiv]')) if ($(node).attr('http-equiv').toLowerCase() !== 'content-security-policy') throw new Error('Unsupported offline meta action');
      pages.set(relativePath, { ids, references: [...$('[href]')].map(node => ({ tag: node.name, href: node.attribs.href, rel: node.attribs.rel, online: node.attribs['data-crux-online'] })) });
    }
  }
  await walk(root);
  if (!pages.has('index.html') || !files.has('offline.css')) throw new Error('Missing offline homepage/stylesheet or empty tree');
  function target(href, from) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || /[\\\x00-\x20\x7f]/.test(href)) throw new Error('Unsupported offline resource/link URL');
    const url = new URL(href, `https://offline.invalid/${from}`);
    if (url.search) throw new Error('Unsupported offline query');
    const decoded = decodeURIComponent(href.split('#')[0]);
    const resolved = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)) : from;
    if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(decoded) || /[\\\x00-\x1f\x7f]/.test(decoded)) throw new Error('Offline link escapes output');
    if (!files.has(resolved)) throw new Error(`Missing offline target ${resolved} from ${from}`);
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && !pages.get(resolved)?.ids.has(fragment)) throw new Error(`Missing offline anchor ${resolved}#${fragment}`);
    return resolved;
  }
  for (const [filename, { references }] of pages) {
    for (const { tag, href, rel, online } of references) {
      if (tag === 'a' && /^https?:\/\//.test(href)) {
        const url = new URL(href);
        if (!online || url.username || url.password) throw new Error('Unmarked/unsafe online reference');
        onlineLinks++; continue;
      }
      const resolved = target(href, filename);
      if (tag === 'link' && (rel !== 'stylesheet' || !resolved.endsWith('.css'))) throw new Error('Unsupported offline resource link');
      if (!['a', 'link'].includes(tag)) throw new Error('Unsupported offline href component');
      localLinks++;
    }
  }
  return { files: files.size, pages: pages.size, bytes, localLinks, onlineLinks, brokenLinks: 0 };
}
