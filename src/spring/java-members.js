import { load } from 'cheerio';

const safePage = value => typeof value === 'string' && value.length <= 4096 && value.endsWith('.html') &&
  value.split('/').every(p => /^[A-Za-z0-9_$.-]+$/.test(p) && p !== '.' && p !== '..');

/** Extract facts from pinned standard-doclet HTML without following links.
 * Inherited references are NOT members until the caller verifies their target
 * in the declaring page's own members. Source identity is caller-owned.
 */
export function readSpringJavaMembers(html, { page }) {
  if (!safePage(page)) throw new Error('Invalid Java member page path');
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2) throw new Error('Java member page input limit');
  const $ = load(html);
  if ($('meta[http-equiv]').toArray().some(node => node.attribs['http-equiv'].toLowerCase() === 'refresh')) throw new Error('Java member redirect page');
  if ($('body main').length !== 1) throw new Error('Java member page requires one main body');
  const counts = new Map();
  for (const node of $('[id]')) counts.set(node.attribs.id, (counts.get(node.attribs.id) ?? 0) + 1);
  const members = [], inherited = [], externalInherited = [];
  for (const node of $('body main section.detail[id]')) {
    if ($(node).closest('script,style,template').length) continue;
    const kind = $(node).closest('.method-details').length ? 'Method' :
      $(node).closest('.constructor-details').length ? 'Constructor' :
      $(node).closest('.field-details,.enum-constant-details').length ? 'Field' : undefined;
    if (!kind) continue;
    // Standard doclet exposes generic erasure aliases on the direct h3 only.
    // IDs in examples, notes, and type-parameter descriptions are not members.
    for (const anchor of [node.attribs.id, ...$(node).children('h3[id]').toArray().map(n => n.attribs.id)]) {
      if (!anchor || anchor.length > 8192 || /[\u0000-\u001f\u007f]/.test(anchor) || counts.get(anchor) !== 1) throw new Error('Missing or ambiguous Java member anchor');
      members.push({ page, anchor, kind });
    }
  }
  for (const node of $('body main .inherited-list code a[href]')) {
    // Nested type links point to class pages, not field/method declarations.
    if ($(node).closest('.inherited-list').children('h3').attr('id')?.startsWith('nested-classes-inherited-from-class-')) continue;
    const href = node.attribs.href;
    if (href.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(href)) throw new Error('Unsafe inherited reference');
    if (/^https?:\/\//.test(href)) {
      const url = new URL(href);
      if (url.username || url.password) throw new Error('Unsafe inherited credentials');
      externalInherited.push(href); continue;
    }
    const hash = href.indexOf('#'), rawPath = hash < 0 ? href : href.slice(0, hash);
    if (hash < 0 || rawPath.startsWith('/') || /[%?:]/.test(rawPath)) throw new Error('Unsafe inherited path');
    const parts = page.split('/'); parts.pop();
    for (const part of rawPath.split('/')) {
      if (part === '..') { if (!parts.length) throw new Error('Escaping inherited path'); parts.pop(); }
      else if (part && part !== '.') parts.push(part);
    }
    const target = rawPath ? parts.join('/') : page;
    let anchor;
    try { anchor = decodeURIComponent(href.slice(hash + 1)); } catch { throw new Error('Invalid inherited fragment encoding'); }
    if (!safePage(target) || !anchor || /[\u0000-\u001f\u007f]/.test(anchor)) throw new Error('Invalid inherited target');
    inherited.push({ page: target, anchor });
  }
  if (members.length + inherited.length > 10000) throw new Error('Java member inventory limit');
  return { members, inherited, externalInherited };
}
