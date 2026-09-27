import { load } from 'cheerio';

const excluded = 'nav,aside,header,footer,pre,code,script,style,template,.section-summary';
const controls = /[\u0000-\u001f\u007f]/;

/** Parse a generated Framework Antora page, without executing or changing it.
 * This verifies index targets, not resource closure or source provenance.
 */
export function readSpringReferencePage(html, { version, outputPath }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2) throw new Error('Spring reference page size limit');
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || controls.test(version)) throw new Error('Invalid Spring reference version');
  if (typeof outputPath !== 'string' || outputPath.length > 4096 || !/^reference\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.html$/.test(outputPath) || controls.test(outputPath)) throw new Error('Invalid Spring reference output path');
  const $ = load(html);
  let nodeCount = 0;
  const pending = [$.root()[0]];
  while (pending.length) {
    const node = pending.pop();
    if (++nodeCount > 300000) throw new Error('Spring reference DOM size limit');
    if (node.children) for (const child of node.children) pending.push(child);
  }
  for (const [name, expected] of [['version', version], ['component', 'framework']]) {
    const meta = $(`head meta[name="${name}"]`);
    if (meta.length !== 1 || meta.attr('content') !== expected) throw new Error(`Spring reference ${name} identity mismatch`);
  }
  if ($('meta[http-equiv]').toArray().some(e => $(e).attr('http-equiv')?.toLowerCase() === 'refresh')) throw new Error('Spring reference redirect is not an indexable document');
  const article = $('body main article.doc');
  if (article.length !== 1 || $('article.doc').length !== 1 || article.parents(excluded).length) throw new Error('Missing or ambiguous Spring reference article');

  const anchorCounts = new Map();
  $('[id],a[name]').each((_, e) => {
    for (const id of new Set([$(e).attr('id'), e.tagName === 'a' ? $(e).attr('name') : undefined])) {
      if (id !== undefined) anchorCounts.set(id, (anchorCounts.get(id) ?? 0) + 1);
    }
  });
  const prose = article.clone();
  // Code is meaningful body content, but headings in examples are not sections.
  prose.find('nav,aside,header,footer,script,style,template,h1,h2,h3,h4,h5,h6').remove();
  if (!prose.text().trim()) throw new Error('Spring reference page has no body content');
  const contentHeadings = article.find('h1,h2,h3,h4,h5,h6').toArray().filter(e => !$(e).parents(excluded).length);
  const titles = contentHeadings.filter(e => e.tagName === 'h1');
  if (titles.length !== 1 || contentHeadings[0] !== titles[0]) throw new Error('Missing or ambiguous Spring reference title');
  if (contentHeadings.length > 20001) throw new Error('Spring reference heading count limit');
  const headingTitle = element => {
    const copy = $(element).clone();
    copy.find('script,style,template,a.anchor').remove();
    const text = copy.text().replace(/\s+/gu, ' ').trim();
    if (!text || text.length > 2048 || controls.test(text)) throw new Error('Invalid Spring reference heading title');
    return text;
  };
  const title = headingTitle(titles[0]);
  const symbols = [{ name: title, type: 'Guide', path: outputPath }];
  const headings = [], parents = [];
  for (const element of contentHeadings.slice(1)) {
    const id = $(element).attr('id');
    if (!id || id.length > 1024 || controls.test(id) || anchorCounts.get(id) !== 1) throw new Error('Invalid or ambiguous Spring reference heading anchor');
    const text = headingTitle(element), level = Number(element.tagName.slice(1));
    while (parents.length && parents.at(-1).level >= level) parents.pop();
    const target = `${outputPath}#${encodeURIComponent(id)}`;
    symbols.push({ name: [title, ...parents.map(p => p.title), text].join(' — '), type: 'Section', path: target });
    headings.push({ title: text, level, path: target });
    parents.push({ title: text, level });
  }
  return { title, symbols, headings };
}
