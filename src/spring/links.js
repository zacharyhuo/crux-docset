import path from 'node:path';
import { resolveReviewedSpringReference } from './references.js';

const filePattern = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:html|png)$/;
const controls = /[\u0000-\u0020\u007f\\]/;
function validFile(file) {
  return typeof file === 'string' && file.length <= 4096 && !controls.test(file) && filePattern.test(file);
}
function localTarget(href, from) {
  if (typeof href !== 'string' || href.length > 8192 || controls.test(href) || href.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/i.test(href) || href.includes('?')) throw new Error('Unsafe Spring local link');
  const hash = href.indexOf('#'), rawPath = hash < 0 ? href : href.slice(0, hash);
  if (/%(?:2f|5c)/i.test(rawPath)) throw new Error('Unsafe Spring encoded path separator');
  let decoded, fragment;
  try { decoded = decodeURIComponent(rawPath); fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)); }
  catch { throw new Error('Unsafe Spring link encoding'); }
  if (decoded.startsWith('/') || controls.test(decoded) || /[%?#:]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(fragment) || !fragment.isWellFormed()) throw new Error('Unsafe Spring decoded link');
  const target = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)) : from;
  if (!validFile(target)) throw new Error('Unsafe Spring target path');
  return { target, fragment };
}

/** Inventories are prepared body anchors (not navigation/script IDs), verified
 * resources, and reviewed local redirects, all relative to the reference root.
 * This pure resolver cannot authenticate the filesystem/source itself.
 */
export function createSpringLinkResolver({ version, pages, resources = new Set(), redirects = new Map(), policy }) {
  resolveReviewedSpringReference(policy, version, '', '', ''); // authenticate opaque policy even with no corrections
  if (!(pages instanceof Map) || !pages.size || pages.size > 2000 || !(resources instanceof Set) || resources.size > 1000 ||
      !(redirects instanceof Map) || redirects.size > 100) throw new Error('Invalid Spring link inventory');
  const content = new Map(), assets = new Set(), aliases = new Map();
  for (const [file, ids] of pages) {
    if (!validFile(file) || !file.endsWith('.html') || !(ids instanceof Set) || ids.size > 100000) throw new Error('Unsafe Spring page inventory');
    for (const id of ids) if (typeof id !== 'string' || !id || id.length > 1024 || !id.isWellFormed() || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Unsafe Spring anchor inventory');
    content.set(file, new Set(ids));
  }
  for (const file of resources) {
    if (!validFile(file) || !file.endsWith('.png')) throw new Error('Unsafe Spring resource inventory');
    assets.add(file);
  }
  for (const [from, href] of redirects) {
    if (!validFile(from) || !from.endsWith('.html') || content.has(from) || assets.has(from)) throw new Error('Invalid Spring redirect collision');
    const target = localTarget(href, from);
    if (target.fragment || !target.target.endsWith('.html')) throw new Error('Unsupported Spring redirect target');
    aliases.set(from, target.target);
  }
  const exists = (target, fragment) => content.has(target) ? (!fragment || content.get(target).has(fragment)) : !fragment && assets.has(target);
  const local = (target, fragment, from, ruleId) => {
    const href = path.posix.relative(path.posix.dirname(from), target) + (fragment ? `#${encodeURIComponent(fragment)}` : '');
    if (href.length > 8192) throw new Error('Spring link encoded path size limit');
    return { kind: 'local', href, ...(ruleId ? { ruleId } : {}) };
  };
  return (href, from) => {
    if (!content.has(from)) throw new Error('Unknown Spring reference origin');
    if (typeof href === 'string' && /^https?:\/\//.test(href)) {
      if (href.length > 8192 || controls.test(href)) throw new Error('Unsafe Spring online link');
      const url = new URL(href);
      if (url.username || url.password) throw new Error('Unsafe Spring online credentials');
      return { kind: 'online', href };
    }
    let { target, fragment } = localTarget(href, from);
    const original = target, seen = new Set();
    while (aliases.has(target)) {
      if (seen.has(target) || seen.size >= 8) throw new Error('Spring redirect cycle/depth limit');
      seen.add(target); target = aliases.get(target);
    }
    if (exists(target, fragment)) return local(target, fragment, from);
    const correction = resolveReviewedSpringReference(policy, version, from, original, fragment);
    if (!correction) throw new Error(`Missing Spring reference ${original}#${fragment} from ${from}`);
    if (correction.kind === 'unavailable') return correction;
    if (!content.get(correction.target)?.has(correction.fragment)) throw new Error('Missing Spring rendered replacement anchor');
    return local(correction.target, correction.fragment, from, correction.ruleId);
  };
}
