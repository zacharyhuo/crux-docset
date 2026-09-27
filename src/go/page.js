import { load } from 'cheerio';
import { GO_CONTEXTS } from './inventory.js';

const identifier = /^[_\p{L}][\p{L}\p{Nd}_]*$/u;
const kinds = { function: 'Function', method: 'Method', field: 'Field', constant: 'Constant', variable: 'Variable' };

// Only scan declaration prefixes, never evaluate Go or upstream JavaScript.
function tokens(text) {
  if (text.length > 256 * 1024) throw new Error('Go declaration size limit');
  const result = [];
  const pattern = /\s+|[_\p{L}][\p{L}\p{Nd}_]*|"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'|[^\s]/guy;
  let match;
  while ((match = pattern.exec(text))) {
    if (!/^\s/.test(match[0])) result.push(match[0]);
    if (result.length > 100000) throw new Error('Go declaration token limit');
  }
  return result;
}
function afterGroup(items, start, open, close) {
  let depth = 0;
  for (let i = start; i < items.length; i++) {
    if (items[i] === open) depth++;
    else if (items[i] === close && --depth === 0) return i + 1;
  }
  throw new Error('Unclosed Go declaration group');
}
function headerKind(id, kind, text) {
  const t = tokens(text);
  if (kind === 'type') {
    if (t[0] !== 'type' || t[1] !== id) throw new Error('Go type declaration identity mismatch');
    let i = 2;
    if (t[i] === '[') i = afterGroup(t, i, '[', ']');
    if (!t[i]) throw new Error('Missing Go type declaration');
    if (t[i] === 'struct' && t[i + 1] === '{') return 'Struct';
    if (t[i] === 'interface' && t[i + 1] === '{') return 'Interface';
    return 'Type';
  }
  if (t[0] !== 'func') throw new Error('Missing Go function declaration');
  let i = 1;
  if (kind === 'method') {
    if (t[i] !== '(') throw new Error('Missing Go method receiver');
    const end = afterGroup(t, i, '(', ')');
    const receiver = t.slice(i + 1, end - 1);
    if (identifier.test(receiver[0]) && (receiver[1] === '*' || identifier.test(receiver[1] ?? ''))) receiver.shift();
    if (receiver[0] === '*') receiver.shift();
    if (receiver[0] !== id.split('.')[0]) throw new Error('Go method receiver mismatch');
    i = end;
  } else if (kind !== 'function' || id.includes('.')) throw new Error('Unknown Go declaration header kind');
  if (t[i] !== id.split('.').at(-1)) throw new Error('Go function declaration identity mismatch');
  i++;
  if (t[i] === '[') i = afterGroup(t, i, '[', ']');
  if (t[i] !== '(') throw new Error('Missing Go function parameter list');
  return kinds[kind];
}

// Inline anchor spans may contain only a comment; the actual declaration follows
// the span. Capture textual offsets once per pre, preserving that exact boundary.
function declarationText(pre) {
  let text = '';
  const offsets = new Map();
  const stack = [...pre.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'text') { text += node.data; continue; }
    if (node.attribs?.class?.split(/\s+/).includes('comment') || ['script', 'style', 'template'].includes(node.name)) continue;
    if (node.attribs?.['data-kind']) offsets.set(node, text.length);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  const entries = [...offsets];
  const ends = new Map();
  let next = text.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const offset = entries[i][1];
    if (!ends.has(offset)) { ends.set(offset, next); next = offset; }
  }
  return { text, keyword: /^\s*(const|var|type|func)\b/u.exec(text)?.[1],
    inline: new Map(entries.map(([node, offset]) => [node, text.slice(offset, ends.get(offset))])) };
}

export function readGoPage(html, { packagePath, version, context, outputPath }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2) throw new Error('Go page size limit');
  if (!/^1\.\d+\.\d+$/.test(version) || !GO_CONTEXTS.includes(context) || !/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(packagePath) ||
      outputPath !== `platforms/${context.replace('/', '-')}/${packagePath}/index.html`) throw new Error('Invalid Go page identity/output path');
  const $ = load(html);
  const versionLinks = $('[data-test-id="UnitHeader-version"] a[aria-label^="Version: "]');
  const location = $('a[data-test-id="UnitHeader-breadcrumbCurrent"]');
  if (versionLinks.length !== 1 || versionLinks.attr('aria-label') !== `Version: go${version}` ||
      location.length !== 1 || location.attr('href') !== `/${packagePath}@go${version}`) throw new Error('Go page version/package mismatch');
  const platform = $('.UnitBuildContext-titleContext');
  if (platform.length) {
    const choices = platform.find('.js-buildContextSelect option');
    const selected = choices.filter('[selected]');
    const single = platform.find('.UnitBuildContext-singleContext').clone();
    single.find('a').remove();
    const actual = choices.length ? (selected.length ? selected : choices.first()).text().trim() : single.text().trim();
    if (platform.length !== 1 || selected.length > 1 || actual !== context) throw new Error('Go rendered context mismatch');
  }
  const body = $('main .Documentation');
  if (body.length !== 1 || body.parents('script,style,template').length || !body.text().trim()) throw new Error('Missing Go documentation body');
  const nodes = $('*');
  if (nodes.length > 300000) throw new Error('Go page DOM size limit');
  const targets = new Map();
  for (const node of nodes) {
    const values = new Set([node.attribs.id, ...(node.name === 'a' ? [node.attribs.name] : [])].filter(Boolean));
    for (const id of values) targets.set(id, (targets.get(id) ?? 0) + 1);
  }
  const declarations = new Map();
  for (const pre of body.find('.Documentation-declaration > pre')) declarations.set(pre, declarationText(pre));
  const declarationHeaders = new Map(), headerTypes = new Map();
  for (const header of body.find('h4[data-kind]')) {
    const e = $(header);
    let pre = e.next('.Documentation-declaration').children('pre');
    if (!pre.length && e.parent().is('summary') && e.parent().parent().is('details')) {
      pre = e.parent().next('.Documentation-deprecatedItemBody').children('.Documentation-declaration').first().children('pre');
    }
    if (pre.length !== 1 || !declarations.has(pre[0]) || declarationHeaders.has(pre[0])) throw new Error('Missing adjacent Go declaration');
    declarationHeaders.set(pre[0], header);
    headerTypes.set(header, headerKind(e.attr('id') ?? '', e.attr('data-kind'), declarations.get(pre[0]).text));
  }
  const symbols = [{ name: packagePath, type: 'Package', path: outputPath }];
  const elements = body.find('[data-kind]');
  if (elements.length > 20000) throw new Error('Oversize Go API declarations');
  if (!elements.length && (declarations.size || body.find('.Documentation-index a[href]').length ||
      body.find('.Documentation-overview #pkg-overview').length !== 1 || !body.find('.Documentation-overview p').text().trim())) throw new Error('Missing Go API declarations/overview');
  for (const element of elements) {
    const e = $(element), id = e.attr('id'), kind = e.attr('data-kind');
    if (!id || id.length > 512 || id.split('.').length > 2 || !id.split('.').every(n => identifier.test(n)) || targets.get(id) !== 1 || e.parents('script,style,template').length) throw new Error('Invalid/duplicate Go symbol anchor');
    let type;
    if (element.name === 'h4') {
      type = headerTypes.get(element);
    } else {
      const pre = e.closest('pre')[0], declaration = declarations.get(pre);
      if (element.name !== 'span' || !declaration?.inline.has(element) || !kinds[kind]) throw new Error('Misplaced Go inline declaration');
      const t = tokens(declaration.inline.get(element));
      if (['const', 'var'].includes(t[0])) t.shift();
      if (t[0] === '*') t.shift();
      if (kind === 'field' && t[1] === '.') t.splice(0, 2);
      const names = [t[0]];
      for (let i = 1; t[i] === ',' && identifier.test(t[i + 1] ?? ''); i += 2) names.push(t[i + 1]);
      if (!names.includes(id.split('.').at(-1))) throw new Error(`Go inline declaration identity mismatch: ${id}`);
      if (['method', 'field'].includes(kind)) {
        const header = declarationHeaders.get(pre);
        const owner = header?.attribs['data-kind'] === 'type' ? header.attribs.id : undefined;
        if (id.split('.').length !== 2 || owner !== id.split('.')[0]) throw new Error('Go inline owner mismatch');
        if (headerTypes.get(header) !== (kind === 'method' ? 'Interface' : 'Struct') || (kind === 'method' && t[1] !== '(')) throw new Error('Go inline member kind mismatch');
      } else if (!['constant', 'variable'].includes(kind) || id.includes('.') ||
        declaration.keyword !== (kind === 'constant' ? 'const' : 'var')) throw new Error('Unexpected Go inline kind');
      type = kinds[kind];
    }
    symbols.push({ name: `${packagePath}.${id}`, type, path: `${outputPath}#${encodeURIComponent(id)}` });
  }
  const resources = [...new Set($('[src],link[rel="stylesheet"][href]').map((_, e) => $(e).attr('src') ?? $(e).attr('href')).get())];
  const sourceLinks = [...new Set(body.find('a.Documentation-source[href]').map((_, e) => $(e).attr('href')).get())];
  return { symbols, resources, sourceLinks };
}

export function selectGoSymbols(pages) {
  const chosen = new Map();
  for (const page of pages) {
    const rank = GO_CONTEXTS.indexOf(page.context);
    if (rank < 0) throw new Error('Unknown Go symbol context');
    for (const symbol of page.symbols) {
      const key = symbol.name;
      if (!chosen.has(key) || rank < chosen.get(key).rank) chosen.set(key, { rank, context: page.context, symbol });
    }
  }
  return [...chosen.values()].map(({ rank, context, symbol }) => ({ ...symbol, name: rank === 0 ? symbol.name : `${symbol.name} [${context}]` }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
}
