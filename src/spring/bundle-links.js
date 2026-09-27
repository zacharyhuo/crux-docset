import { load } from 'cheerio';
import { serializeSpringHTML } from './html.js';

/** Final link pass over already adapted API/reference HTML and a complete,
 * verified assembled inventory. Does not replace source/resource qualification.
 * Missing same-version targets fail; no guessed current/unversioned aliases.
 */
export function rewriteSpringBundleLinks(html, { from, resolve }) {
  if (typeof html !== 'string' || !html.isWellFormed() || Buffer.byteLength(html) > 16 * 1024 ** 2 ||
      typeof from !== 'string' || typeof resolve !== 'function') throw new Error('Invalid Spring assembled page');
  const $ = load(html); let changed = 0;
  for (const node of $('a[href]')) {
    const original = node.attribs.href, result = resolve(original, from);
    if (result.kind !== 'local' && result.kind !== 'online') throw new Error('Unadapted Spring assembled link');
    $(node).attr('href', result.href);
    if (result.kind === 'online') $(node).attr('data-crux-online', 'true');
    else $(node).removeAttr('data-crux-online');
    changed += Number(original !== result.href);
  }
  return { html: serializeSpringHTML($), changed };
}
