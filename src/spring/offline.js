import path from 'node:path';
import { load } from 'cheerio';
import { readSpringReferencePage } from './reference-page.js';

const tags = new Set('article div nav ul li a h1 p h2 code table caption colgroup col thead tr th tbody td em span pre i h3 b dl dt dd img h4 strong ol blockquote sup h5 h6 br hr'.split(' '));
const attributes = new Set('class aria-label id title href style aria-labelledby data-lang data-value src alt width name'.split(' '));
// Deliberately finite renderer profile: new dynamic components require review.
const classes = new Set(`doc admonitionblock anchor arabic bare breadcrumbs breadcrumbs-container caution colist content conum discrete dlist exampleblock fa fit-content fold-block footnote footnoteref frame-all grid-all halign-left hdlist hdlist1 hdlist2 highlight highlightjs hljs icon icon-caution icon-important icon-note icon-tip icon-warning imageblock important is-hidden-folded is-hidden-unfolded is-loading is-sync listingblock literalblock nav-section-summary next note olist openblock page pagination paragraph prev primary quoteblock secondary sect1 sect2 sect3 sect4 section-summary sectionbody sidebarblock small stretch stripes-odd tab tableblock tablist tabpanel tabs text-center tip title ulist valign-top warning xref`.split(' '));
const languages = new Set('java kotlin Kotlin xml txt properties sql bash shell groovy yaml jsp html javascript none'.split(' '));
const controls = /[\u0000-\u0020\u007f\\]/;

function checkImage(url, outputPath) {
  if (!url || url.length > 4096 || controls.test(url) || /[?#]/.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/')) throw new Error('Unsafe Spring image URL');
  let decoded;
  try { decoded = decodeURIComponent(url); } catch { throw new Error('Unsafe Spring image encoding'); }
  if (controls.test(decoded) || /[?#:%]/.test(decoded) || decoded.startsWith('/')) throw new Error('Unsafe Spring image path');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(outputPath), decoded));
  if (!target.startsWith('reference/') || !target.endsWith('.png')) throw new Error('Unsupported Spring image path/resource');
}

/** Prepare body content without upstream scripts/styles. Resource URLs are
 * inventoried, NOT verified as present; the exporter must copy and verify them.
 */
export function prepareSpringOfflinePage(html, identity) {
  const parsed = readSpringReferencePage(html, identity);
  const $ = load(html), article = $('body main article.doc');
  const anchors = new Set(), contentAnchors = new Set(), resources = [];
  for (const node of article.find('*').addBack()) {
    const e = $(node);
    if (!tags.has(node.name)) throw new Error(`Unsupported Spring body component: ${node.name}`);
    for (const key of Object.keys(node.attribs)) if (!attributes.has(key)) throw new Error(`Unsupported Spring body attribute/resource: ${key}`);
    for (const name of (e.attr('class') ?? '').split(/\s+/).filter(Boolean)) {
      if (!classes.has(name) && !(name.startsWith('language-') && languages.has(name.slice(9)))) throw new Error(`Unsupported Spring body class: ${name}`);
    }
    for (const id of new Set([e.attr('id'), node.name === 'a' ? e.attr('name') : undefined].filter(v => v !== undefined))) {
      if (!id || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id) || anchors.has(id)) throw new Error('Invalid or duplicate Spring body anchor');
      anchors.add(id);
      if (!e.is('nav,pre,code') && !e.parents('nav,pre,code').length) contentAnchors.add(id);
    }
    if (e.attr('style') !== undefined && (node.name !== 'col' || !/^width: (?:100|\d{1,2}(?:\.\d{1,4})?)%;$/.test(e.attr('style')))) throw new Error('Unsupported Spring body inline style/resource');
    if (e.attr('href') !== undefined && node.name !== 'a') throw new Error('Unsupported Spring href component');
    if (e.attr('src') !== undefined && node.name !== 'img') throw new Error('Unsupported Spring src component');
    if (node.name === 'img') {
      checkImage(e.attr('src'), identity.outputPath);
      resources.push({ tag: 'img', attribute: 'src', url: e.attr('src') });
    }
    if (e.attr('width') !== undefined && (node.name !== 'img' || !/^(?:\d{1,4}|(?:100|\d{1,2})%)$/.test(e.attr('width')))) throw new Error('Unsupported Spring image width');
  }
  let tabPanels = 0;
  for (const node of article.find('.tabs').toArray().reverse()) {
    const group = $(node), content = group.children('.content');
    const list = content.children('.tablist'), ul = list.children('ul');
    const labels = ul.children('li.tab'), panels = content.children('.tabpanel');
    const title = group.children('.title');
    if (content.length !== 1 || title.length > 1 || group.children().length !== 1 + title.length || list.length !== 1 || ul.length !== 1 ||
        list.children().length !== 1 || ul.children().length !== labels.length || list.attr('id') || ul.attr('id') ||
        !labels.length || panels.length !== labels.length || content.children().length !== panels.length + 1) throw new Error('Unsupported Spring tab structure');
    for (const [i, panelNode] of panels.toArray().entries()) {
      const panel = $(panelNode), label = labels.eq(i), labelId = label.attr('id');
      if (!labelId || !panel.attr('id') || panel.attr('aria-labelledby') !== labelId || !label.text().trim() ||
          label.find('*').toArray().some(e => e.name !== 'p') || label.find('[id],[name]').length) throw new Error('Invalid Spring tab label/panel');
      const disclosure = $('<details open class="Crux-codeExample"></details>').attr('id', panel.attr('id'));
      disclosure.append($('<summary></summary>').attr('id', labelId).text(label.text().trim()));
      disclosure.append(panel.contents()); panel.replaceWith(disclosure); tabPanels++;
    }
    list.remove(); group.removeClass('tabs is-sync is-loading');
  }
  if (article.find('.tablist,.tabpanel,.tab,.is-loading,.is-sync').length) throw new Error('Orphaned Spring tab/dynamic component');
  const summaries = new Map();
  for (const node of article.find('.is-hidden-unfolded')) {
    const e = $(node), pre = e.closest('pre');
    if (pre.length !== 1 || !e.closest('code').length) throw new Error('Unsupported Spring folded summary');
    let disclosure = summaries.get(pre[0]);
    if (!disclosure) {
      disclosure = $('<details class="Crux-foldSummary"><summary>Upstream shortened view</summary><pre></pre></details>');
      pre.after(disclosure); summaries.set(pre[0], disclosure);
    }
    disclosure.children('pre').append(e.removeClass('is-hidden-unfolded'));
  }
  article.find('.is-hidden-folded').removeClass('is-hidden-folded');
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
    article.find(`i.icon-${kind}`).each((_, node) => {
      const e = $(node);
      if (e.text().trim() || e.children().length) throw new Error('Unsupported Spring admonition icon content');
      e.text(kind[0].toUpperCase() + kind.slice(1)).removeClass(`fa icon-${kind}`);
    });
  }
  // A textual source-summary is preserved as such, not confused with full code.
  // The exporter supplies the native collapsed document navigation separately.
  return { bodyHTML: $.html(article), title: parsed.title, symbols: parsed.symbols, headings: parsed.headings, anchors, contentAnchors, resources, tabPanels };
}
