import { load } from 'cheerio';
import { serializeSpringHTML } from './html.js';

/** Final link pass over already adapted API/reference HTML and a complete,
 * verified assembled inventory. Does not replace source/resource qualification.
 * Missing same-version targets fail; no guessed current/unversioned aliases.
 */
export function rewriteSpringBundleLinks(html, { from, resolve }) {
  if (typeof html !== 'string' || !html.isWellFormed() || Buffer.byteLength(html) > 16 * 1024 ** 2 ||
      typeof from !== 'string' || typeof resolve !== 'function') throw new Error('Invalid Spring assembled page');
  const $ = load(html), corrections = [], warnings = []; let changed = 0;
  for (const node of $('a[href]')) {
    const original = node.attribs.href, result = resolve(original, from);
    if (result.kind === 'unavailable') {
      if (result.ruleId !== 'missing-jca' || result.reason !== 'upstream-missing-api' ||
          !/^https:\/\/github\.com\/spring-projects\/spring-framework\/blob\/[a-f0-9]{40}\/framework-docs\/modules\/ROOT\/pages\/core\/beans\/context-introduction\.adoc$/.test(result.evidence)) throw new Error('Unreviewed Spring unavailable API');
      $(node).removeAttr('href').removeAttr('target').removeAttr('rel').removeAttr('data-crux-online');
      const notice = $('<span class="Crux-missingApiNotice" role="note"></span>').text(' [Referenced API unavailable in this version; ');
      notice.append($('<a data-crux-online="true"></a>').attr('href', result.evidence).text('upstream source'));
      notice.append(']'); $(node).after(notice);
      warnings.push({ from, href: original, ...result }); changed++;
      continue;
    }
    if (result.kind !== 'local' && result.kind !== 'online') throw new Error('Unadapted Spring assembled link');
    $(node).attr('href', result.href);
    if (result.kind === 'online') $(node).attr('data-crux-online', 'true');
    else $(node).removeAttr('data-crux-online');
    changed += Number(original !== result.href);
    if (result.correction) corrections.push({ from, ...result, originalHref: original, resolvedHref: result.href });
  }
  return { html: serializeSpringHTML($), changed, corrections, warnings };
}
