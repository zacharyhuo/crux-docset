import { load } from 'cheerio';
import { prepareSpringKotlinPage } from './kotlin-page.js';
import { serializeSpringHTML } from './html.js';

/** Link/content adaptation only: does not certify CSS/JS, license or provenance. */
export function rewriteSpringApiPage(html, { from, resolve }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2 ||
      typeof from !== 'string' || !/^api\/(?:javadoc-api|kdoc-api)\//.test(from) || typeof resolve !== 'function') throw new Error('Invalid API page input/limit');
  const prepared = from.startsWith('api/kdoc-api/') ? prepareSpringKotlinPage(html) : { html, removedPlayground: false };
  const $ = load(prepared.html), counts = { local: 0, online: 0, corrected: 0, changed: 0, removedPlayground: Number(prepared.removedPlayground) };
  for (const node of $('a[href]')) {
    const original = node.attribs.href, result = resolve(original, from);
    if (result.kind !== 'local' && result.kind !== 'online') throw new Error('Unsupported API link resolution');
    $(node).attr('href', result.href);
    if (result.kind === 'online') $(node).attr('data-crux-online', 'true');
    else $(node).removeAttr('data-crux-online');
    counts[result.kind]++;
    counts.changed += Number(original !== result.href);
    counts.corrected += Number(result.correction === 'dokka-java-member');
  }
  return { html: serializeSpringHTML($), counts };
}
