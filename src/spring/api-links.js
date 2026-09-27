import path from 'node:path';
import { resolveDokkaJavaMember } from './dokka-java-links.js';
import { resolveReviewedSpringJavaReference } from './java-reference-policy.js';

const javaPrefix = 'api/javadoc-api/', kotlinPrefix = 'api/kdoc-api/';
const safeFile = value => typeof value === 'string' && value.length <= 4096 && value.split('/').every(p => /^[A-Za-z0-9_$.-]+$/.test(p) && p !== '.' && p !== '..');
const validID = value => typeof value === 'string' && value.length <= 8192 && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
function parseLocal(href, from, floor = 0) {
  const hash = href.indexOf('#'), rawPath = hash < 0 ? href : href.slice(0, hash);
  if (rawPath.startsWith('/') || /[?:]/.test(rawPath) || /%(?:2f|5c)/i.test(rawPath) ||
      rawPath.split('/').some(p => p.includes('%') && /^(?:%2e|\.){1,2}$/i.test(p))) throw new Error('Unsafe API local path');
  let decoded, fragment, raw;
  try {
    decoded = decodeURIComponent(rawPath);
    raw = hash < 0 ? '' : new URL(href.slice(hash), 'https://offline.invalid/').hash.slice(1);
    fragment = decodeURIComponent(raw);
  } catch { throw new Error('Unsafe API link encoding'); }
  if (/[%\\?:#\u0000-\u0020\u007f]/.test(decoded) || !validID(fragment)) throw new Error('Unsafe API decoded path/fragment');
  const parts = from.split('/'); parts.pop();
  for (const part of decoded.split('/')) {
    if (part === '..') { if (parts.length <= floor) throw new Error('Unsafe API path escape'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return { target: decoded ? parts.join('/') : from, raw, fragment };
}

/** Link rewriting over an immutable assembled-documents inventory. The caller
 * owns bounded file reads, unique DOM-ID checking, and source/tool provenance.
 * Known same-version links cannot silently fall back to online or top-of-page.
 */
export function createSpringApiLinkResolver({ version, pages, resources = new Set(), javaMembers = new Map(), javaReferencePolicy }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !(pages instanceof Map) || !pages.size || pages.size > 20000 ||
      !(resources instanceof Set) || resources.size > 10000 || !(javaMembers instanceof Map) || javaMembers.size > 10000) throw new Error('Invalid API inventory/limit');
  if (javaReferencePolicy !== undefined) resolveReviewedSpringJavaReference(javaReferencePolicy, version, '', '', '');
  const content = new Map(), assets = new Set(), declared = new Map(), inheritance = new Map();
  let count = 0;
  for (const [file, ids] of pages) {
    if (!safeFile(file) || !file.endsWith('.html') || !(ids instanceof Set) || ids.size > 200000) throw new Error('Unsafe API page inventory');
    for (const id of ids) if (!validID(id)) throw new Error('Unsafe API anchor inventory');
    count += ids.size;
    if (count > 2000000) throw new Error('API anchor inventory limit');
    content.set(file, new Set(ids));
  }
  for (const file of resources) {
    if (!safeFile(file) || content.has(file)) throw new Error('Unsafe API resource inventory');
    assets.add(file);
  }
  let memberCount = 0;
  for (const [file, data] of javaMembers) {
    if (!safeFile(file) || !content.has(javaPrefix + file) || !data || !Array.isArray(data.members) || !Array.isArray(data.inherited) ||
        data.members.length + data.inherited.length > 10000) throw new Error('Invalid API member inventory');
    memberCount += data.members.length + data.inherited.length;
    if (memberCount > 2000000) throw new Error('API member inventory limit');
    resolveDokkaJavaMember('', data.members); // validate candidate schema before cloning
    const own = new Map();
    for (const member of data.members) {
      if (member.page !== file || !content.get(javaPrefix + file).has(member.anchor) || own.has(member.anchor)) throw new Error('Missing/duplicate API declared member anchor');
      own.set(member.anchor, { page: member.page, anchor: member.anchor, kind: member.kind });
    }
    declared.set(file, own);
    inheritance.set(file, data.inherited.map(ref => {
      if (!ref || !safeFile(ref.page) || !validID(ref.anchor) || !ref.anchor) throw new Error('Invalid API inherited member');
      return { page: ref.page, anchor: ref.anchor };
    }));
  }
  for (const refs of inheritance.values()) for (const ref of refs) {
    if (!declared.get(ref.page)?.has(ref.anchor)) throw new Error('Missing API inherited declaring anchor');
  }
  const candidates = file => [...(declared.get(file)?.values() ?? []), ...(inheritance.get(file) ?? []).map(ref => declared.get(ref.page).get(ref.anchor))];
  const exists = (target, raw, fragment) => content.has(target) ? (!raw || content.get(target).has(raw) || content.get(target).has(fragment)) : !raw && assets.has(target);
  const local = (target, raw, from, correction) => {
    const relative = path.posix.relative(path.posix.dirname(from), target);
    const href = relative + (raw ? `#${raw}` : '');
    if (href.length > 8192) throw new Error('API encoded link size limit');
    return { kind: 'local', href, target, fragment: raw, ...(correction ? { correction } : {}) };
  };
  const remoteRoot = `https://docs.spring.io/spring-framework/docs/${version}/`;
  return (href, from) => {
    if (!content.has(from)) throw new Error('Unknown API origin');
    if (typeof href !== 'string' || href.length > 8192 || !href.isWellFormed() || /[\u0000-\u0020\u007f\\]/.test(href)) throw new Error('Unsafe API link');
    // Preserve upstream author attribution; do not accept mail headers, query
    // actions, or encoded control characters as an executable document link.
    if (/^mailto:[A-Za-z0-9._+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(href)) return { kind: 'online', href };
    let parsed;
    if (/^https?:\/\//.test(href)) {
      const url = new URL(href);
      if (url.username || url.password) throw new Error('Unsafe API online credentials');
      const prefix = ['javadoc-api/', 'kdoc-api/', 'reference/'].find(part => href.startsWith(remoteRoot + part));
      if (!prefix) return { kind: 'online', href };
      // Parse the original spelling, not URL-normalized dot segments.
      parsed = prefix === 'reference/'
        ? parseLocal(href.slice(remoteRoot.length + prefix.length), 'reference/index.html', 1)
        : parseLocal(href.slice(remoteRoot.length), 'api/root.html', 1);
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) throw new Error('Unsupported API link scheme/root');
      parsed = parseLocal(href, from);
    }
    let { target, raw, fragment } = parsed;
    if (!content.has(target) && !assets.has(target) && content.has(`${target}/index.html`)) target += '/index.html';
    if (!safeFile(target)) throw new Error('Unsafe API target');
    if (exists(target, raw, fragment)) return local(target, raw, from);
    if (raw && from.startsWith(kotlinPrefix) && target.startsWith(javaPrefix)) {
      const match = resolveDokkaJavaMember(fragment, candidates(target.slice(javaPrefix.length)));
      if (match) {
        const destination = javaPrefix + match.page, encoded = encodeURIComponent(match.anchor);
        if (!exists(destination, encoded, match.anchor)) throw new Error('Missing corrected API member');
        return local(destination, encoded, from, 'dokka-java-member');
      }
    }
    if (javaReferencePolicy !== undefined && content.has(target) && raw) {
      const reviewed = resolveReviewedSpringJavaReference(javaReferencePolicy, version, from, target, fragment);
      if (reviewed) return reviewed;
    }
    throw new Error(`Missing API target ${target}#${raw} from ${from}`);
  };
}
