import { load } from 'cheerio';
import { prepareSpringKotlinPage } from './kotlin-page.js';
import { serializeSpringHTML } from './html.js';

/** Link/content adaptation only: does not certify CSS/JS, license or provenance. */
export function rewriteSpringApiPage(html, { from, resolve }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2 ||
      typeof from !== 'string' || !/^api\/(?:javadoc-api|kdoc-api)\//.test(from) || typeof resolve !== 'function') throw new Error('Invalid API page input/limit');
  const prepared = from.startsWith('api/kdoc-api/') ? prepareSpringKotlinPage(html) : { html, removedPlayground: false };
  const $ = load(prepared.html), warnings = [], counts = { local: 0, online: 0, corrected: 0, changed: 0, unavailable: 0, removedPlayground: Number(prepared.removedPlayground) };
  for (const node of $('a[href]')) {
    const original = node.attribs.href, result = resolve(original, from);
    if (result.kind === 'unavailable') {
      if (result.reason !== 'upstream-missing-section' || result.ruleId !== 'controller-interface-config' ||
          !/^https:\/\/github\.com\/spring-projects\/spring-framework\/blob\/[a-f0-9]{40}\/spring-webmvc\/src\/main\/java\/org\/springframework\/web\/servlet\/mvc\/AbstractController\.java#L\d+$/.test(result.evidence)) throw new Error('Invalid API unavailable-section evidence');
      // An anchor without href is an inert placeholder: keep any id/name and
      // child markup, and place the evidence link beside it (never nested).
      $(node).removeAttr('href').removeAttr('target').removeAttr('rel').removeAttr('data-crux-online').addClass('Crux-unavailableReference');
      const notice = $('<span class="Crux-referenceNotice" role="note"></span>').text(' [Referenced section unavailable in this version; ');
      notice.append($('<a data-crux-online="true"></a>').attr('href', result.evidence).text('upstream source'));
      notice.append(']'); $(node).after(notice);
      warnings.push({ from, href: original, ...result });
      counts.unavailable++; counts.changed++; counts.online++;
      continue;
    }
    if (result.kind !== 'local' && result.kind !== 'online') throw new Error('Unsupported API link resolution');
    $(node).attr('href', result.href);
    if (result.kind === 'online') $(node).attr('data-crux-online', 'true');
    else $(node).removeAttr('data-crux-online');
    counts[result.kind]++;
    counts.changed += Number(original !== result.href);
    counts.corrected += Number(result.correction === 'dokka-java-member');
  }
  return { html: serializeSpringHTML($), counts, warnings };
}
