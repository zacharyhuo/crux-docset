import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { parseSearchData } from './search-data.js';
import { resolveJavadocSymbols } from './symbols.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/** Read an immutable, locally generated standard-doclet tree; never execute it. */
export async function readJavadocIndex(root) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Javadoc root must be a non-symlink directory');
  const base = await realpath(root);
  let totalBytes = 0;

  async function readText(relative) {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) throw new Error('Unsafe Javadoc file path');
    let current = base;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Non-directory or symlink in Javadoc path: ${relative}`);
    }
    const file = path.join(current, parts.at(-1));
    const initial = await lstat(file);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`Javadoc input must be a regular non-symlink file: ${relative}`);
    if (initial.size > MAX_FILE_BYTES || totalBytes + initial.size > MAX_TOTAL_BYTES) throw new Error(`Javadoc read size limit exceeded: ${relative}`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev || opened.size !== initial.size) throw new Error(`Javadoc file changed during read: ${relative}`);
      // The extra byte detects growth without allocating an unbounded buffer.
      const bytes = Buffer.alloc(initial.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      const after = await handle.stat();
      if (count !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || await realpath(file) !== file) throw new Error(`Javadoc file changed during read: ${relative}`);
      totalBytes += count;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally { await handle.close(); }
  }

  const data = {};
  for (const kind of ['module', 'package', 'type', 'member']) {
    data[`${kind}s`] = parseSearchData(await readText(`${kind}-search-index.js`), kind);
  }
  const symbols = resolveJavadocSymbols(data);
  const pages = new Map();
  for (const symbol of symbols) {
    const hash = symbol.path.indexOf('#');
    const encodedPage = hash < 0 ? symbol.path : symbol.path.slice(0, hash);
    const page = encodedPage.split('/').map(decodeURIComponent).join('/');
    const targets = pages.get(page) ?? [];
    if (hash >= 0) targets.push(decodeURIComponent(symbol.path.slice(hash + 1)));
    pages.set(page, targets);
  }
  for (const [page, targets] of pages) {
    const $ = load(await readText(page));
    if ($('meta[http-equiv]').toArray().some(node => $(node).attr('http-equiv')?.toLowerCase() === 'refresh')) throw new Error(`Javadoc redirect page is not an API target: ${page}`);
    const anchors = new Map();
    // Browser fragment lookup sees the whole document, including navigation
    // and script elements. A duplicate outside main can steal the real target.
    $('[id], a[name]').each((_, element) => {
      const values = new Set([$(element).attr('id'), element.tagName === 'a' ? $(element).attr('name') : undefined]);
      for (const value of values) if (value !== undefined) {
        anchors.set(value, { count: (anchors.get(value)?.count ?? 0) + 1,
          inMain: $(element).closest('body main').length > 0 && $(element).closest('script,style,template').length === 0 });
      }
    });
    $('script,style,template').remove();
    if (!$('body main').text().trim()) throw new Error(`Javadoc page has no main body content: ${page}`);
    for (const target of targets) {
      const anchor = anchors.get(target);
      if (anchor?.count !== 1 || !anchor.inMain) throw new Error(`Missing or ambiguous Javadoc anchor ${target} in ${page}`);
    }
  }
  return { symbols, evidence: { files: 4, pages: pages.size, symbols: symbols.length } };
}
