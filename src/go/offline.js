import { load } from 'cheerio';
import { readGoPage } from './page.js';

const tags = new Set('div section h3 h4 a p details summary pre span button ul ol li'.split(' '));
const attributes = new Set('class tabindex id name href title aria-label role aria-atomic data-kind hidden style value open'.split(' '));
const styles = new Set(['padding-left: 20px; list-style: initial;', 'margin: 6px 0 6px 0;']);
const controls = new Set(['Documentation-exampleShareButton', 'Documentation-exampleFormatButton', 'Documentation-exampleRunButton']);
const hooks = new Set(['js-documentation', 'js-docContent', 'js-exampleContainer', 'js-exampleOutputContainer', 'js-exampleHref', 'js-deprecatedTagLink', 'js-deprecatedDetails']);

// Fixed pkgsite currently emits no required images/fonts/embedded resources in
// Documentation. New body resources must be supported explicitly, never dropped
// as if their absence proved resource closure. Site chrome is outside this body.
export function prepareGoOfflinePage(html, identity) {
  const parsed = readGoPage(html, identity);
  const $ = load(html), body = $('main .Documentation');
  const anchors = new Set();
  let removedControls = 0;
  for (const node of body.find('*').addBack()) {
    if (!tags.has(node.name)) throw new Error(`Unsupported Go body component: ${node.name}`);
    for (const key of Object.keys(node.attribs)) if (!attributes.has(key)) throw new Error(`Unsupported Go body attribute/resource: ${key}`);
    const e = $(node), classes = (e.attr('class') ?? '').split(/\s+/);
    for (const name of classes) if (name.startsWith('js-') && !hooks.has(name)) throw new Error(`Unknown Go dynamic component: ${name}`);
    if (e.attr('style') !== undefined && !styles.has(e.attr('style'))) throw new Error('Unsupported Go body inline style/resource');
    if (node.name === 'button') {
      if (!classes.some(c => controls.has(c)) || e.attr('id') || e.find('*').length) throw new Error('Unknown Go body action');
      e.remove(); removedControls++; continue;
    }
    if (e.is('[hidden]')) {
      if (!e.is('pre.Documentation-exampleOutputContainer')) throw new Error('Unknown Go hidden content');
      // An empty output is not a result; supplied nonempty output is visible.
      if (e.find('.Documentation-exampleOutput').text().trim()) e.removeAttr('hidden');
    }
    for (const id of new Set([e.attr('id'), ...(node.name === 'a' ? [e.attr('name')] : [])].filter(Boolean))) {
      if (anchors.has(id)) throw new Error(`Duplicate Go body anchor: ${id}`);
      anchors.add(id);
    }
  }
  return { bodyHTML: $.html(body), anchors, symbols: parsed.symbols, removedControls };
}

export function adaptGoOfflinePage(prepared, entry, resolve) {
  const $ = load(prepared.bodyHTML, null, false), body = $('.Documentation');
  const links = { local: 0, online: 0, literal: 0 }, warnings = [];
  for (const node of body.find('a[href]')) {
    const e = $(node), href = e.attr('href'), result = resolve(href, entry);
    links[result.kind]++;
    if (result.kind === 'literal') {
      e.removeAttr('href');
      if (result.reason === 'upstream-broken-reference') {
        e.addClass('Crux-upstreamWarning').attr('title', 'Upstream reference has no valid target');
        e.append($('<span class="Crux-linkNote"></span>').text(' [Upstream reference has no valid target]'));
        warnings.push({ href, reason: result.reason, evidence: result.evidence });
      }
    } else {
      e.attr('href', result.href);
      if (result.kind === 'online') {
        e.attr('data-crux-online', result.reason).attr('rel', 'noreferrer noopener');
        e.append($('<span class="Crux-linkNote"></span>').text(' [Online]'));
      } else if (result.platformFallback) {
        e.append($('<span class="Crux-linkNote"></span>').text(` [${result.context}]`));
      }
    }
  }
  body.prepend($('<p class="Crux-offlineNotice"></p>').text('Examples are shown as source and are not executed offline. Supplied outputs are preserved.'));
  return { bodyHTML: $.html(), warnings, links };
}
