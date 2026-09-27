import path from 'node:path';
import { GO_CONTEXTS } from './inventory.js';

const packagePath = value => /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(value);
const outside = value => value.split('/').some(part => ['cmd', 'internal', 'vendor', 'testdata'].includes(part) || part.startsWith('_')) || value.split('/')[0].includes('.');
const literalExamples = new Set(['http://address:port', 'http://localhost:6060/debug/pprof/']);

// Audited against the exact official SDK, not generic missing-link allowances.
// Preserve erroneous upstream prose rather than invent a different API target.
function reviewedMissingReference(version, from, target, fragment) {
  if (version !== '1.27.1') return undefined;
  const key = `${from.packagePath}:${target}#${fragment}`;
  if (key === 'os:syscall#EPLAN9') return {
    kind: 'online', reason: 'out-of-scope-platform',
    href: 'https://github.com/golang/go/blob/go1.27.1/src/syscall/errors_plan9.go#L41',
  };
  const sources = {
    'database/sql/driver:database/sql#Query': 'database/sql/driver/types.go#L40',
    'database/sql/driver:database/sql#Exec': 'database/sql/driver/types.go#L40',
    'database/sql/driver:database/sql#QueryRow': 'database/sql/driver/types.go#L40',
    'os/signal:os#Exec': 'os/signal/doc.go#L55',
    'simd:arch/simd#': 'simd/doc.go#L84',
  };
  if (Object.hasOwn(sources, key)) return { kind: 'literal', reason: 'upstream-broken-reference',
    evidence: `https://github.com/golang/go/blob/go1.27.1/src/${sources[key]}` };
}

export function createGoLinkResolver(inventory, { version, goroot, anchors }) {
  if (!/^1\.\d+\.\d+$/.test(version) || !path.isAbsolute(goroot) || goroot.includes('..') || !(anchors instanceof Map)) throw new Error('Invalid Go link source identity');
  const packages = new Map(), namespaces = new Set();
  for (const entry of inventory.pages) {
    if (!packagePath(entry.packagePath) || !GO_CONTEXTS.includes(entry.context) ||
        entry.outputPath !== `platforms/${entry.context.replace('/', '-')}/${entry.packagePath}/index.html` || !anchors.has(entry.outputPath)) throw new Error('Invalid Go link inventory');
    const contexts = packages.get(entry.packagePath) ?? new Map();
    if (contexts.has(entry.context)) throw new Error('Duplicate Go link page');
    contexts.set(entry.context, entry); packages.set(entry.packagePath, contexts);
    const parts = entry.packagePath.split('/');
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i).join('/'));
  }
  function local(target, fragment, from, context) {
    const relative = target === from.outputPath && fragment ? '' : path.posix.relative(path.posix.dirname(from.outputPath), target);
    return { kind: 'local', href: `${relative}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`, context,
      platformFallback: context !== undefined && context !== from.context };
  }
  return function resolve(href, from) {
    if (typeof href !== 'string' || href.length > 8192 || /[\x00-\x20\x7f\\]/.test(href) || href.startsWith('//')) throw new Error('Unsafe Go documentation URL');
    if (literalExamples.has(href)) return { kind: 'literal', reason: 'example-address' };
    if (packages.get(from.packagePath)?.get(from.context)?.outputPath !== from.outputPath) throw new Error('Unknown source Go page');
    let url;
    if (!href || href.startsWith('#')) url = new URL(`https://pkg.go.dev/${from.packagePath}@go${version}${href}`);
    else if (href.startsWith('/')) url = new URL(`https://pkg.go.dev${href}`);
    else {
      url = new URL(href);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsafe Go documentation URL scheme');
    }
    if (url.username || url.password) throw new Error('Credentials in Go documentation URL');
    // Inspect raw pathname as well: URL normalization must not erase traversal.
    const rawPath = href.split(/[?#]/)[0];
    const decoded = decodeURIComponent(rawPath);
    if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(decoded)) throw new Error('Go documentation path traversal');
    if (url.hostname === 'pkg.go.dev' && url.pathname.startsWith('/files/')) {
      const prefix = `/files${goroot}/std/`;
      if (url.port || url.search || !url.pathname.startsWith(prefix)) throw new Error('Unknown Go local source path');
      const source = url.pathname.slice(prefix.length);
      if (!packagePath(source) || !/^#L[1-9]\d*$/.test(url.hash)) throw new Error('Invalid Go source path/line');
      return { kind: 'online', href: `https://github.com/golang/go/blob/go${version}/src/${source}${url.hash}`, reason: 'source' };
    }
    if (['go.dev', 'golang.org'].includes(url.hostname) && !url.port && url.pathname.startsWith('/pkg/')) {
      url = new URL(`https://pkg.go.dev/${url.pathname.slice(5).replace(/\/$/, '')}${url.search}${url.hash}`);
    }
    if (url.hostname !== 'pkg.go.dev' || url.port) {
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Unexpected local-service link');
      if (url.hostname === 'golang.org') { url.hostname = 'go.dev'; url.protocol = 'https:'; }
      return { kind: 'online', href: url.href, reason: url.protocol === 'http:' ? 'upstream-http-reference' : 'external-reference' };
    }
    if (/^\/(doc|ref|issue)\//.test(url.pathname)) return { kind: 'online', href: `https://go.dev${url.pathname}${url.search}${url.hash}`, reason: 'official-reference' };
    let targetName = url.pathname.slice(1).replace(/\/$/, '');
    const at = targetName.indexOf('@');
    if (at >= 0) {
      if (targetName.slice(at + 1) !== `go${version}`) return { kind: 'online', href: `https://pkg.go.dev${url.pathname}${url.search}${url.hash}`, reason: 'other-version' };
      targetName = targetName.slice(0, at);
    }
    if (!packagePath(targetName)) throw new Error('Invalid Go package link');
    let fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';
    if (fragment.length > 2048 || /[\x00-\x1f\x7f]/.test(fragment)) throw new Error('Invalid Go link anchor');
    for (const key of url.searchParams.keys()) if (!['GOOS', 'GOARCH'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Unsupported Go link context/query');
    const os = url.searchParams.get('GOOS'), arch = url.searchParams.get('GOARCH');
    let requested = from.context;
    if (os || arch) {
      const choices = GO_CONTEXTS.filter(c => (!os || c.split('/')[0] === os) && (!arch || c.split('/')[1] === arch));
      if (!choices.length) throw new Error('Unsupported Go link context');
      requested = choices.includes(from.context) ? from.context : choices[0];
    }
    const candidates = packages.get(targetName);
    if (!candidates) {
      if (namespaces.has(targetName) && !fragment && !url.search) return local('index.html', `package-group-${targetName.replaceAll('/', '-')}`, from);
      if (outside(targetName)) return { kind: 'online', href: `https://pkg.go.dev${url.pathname}${url.search}${url.hash}`, reason: 'out-of-scope' };
      const reviewed = reviewedMissingReference(version, from, targetName, fragment);
      if (reviewed) return reviewed;
      throw new Error(`Missing in-scope Go page: ${targetName}`);
    }
    const order = [requested, ...GO_CONTEXTS.filter(c => c !== requested)];
    for (const context of order) {
      const target = candidates.get(context);
      if (!target || (fragment && !anchors.get(target.outputPath).has(fragment))) continue;
      return local(target.outputPath, fragment, from, context);
    }
    const reviewed = reviewedMissingReference(version, from, targetName, fragment);
    if (reviewed) return reviewed;
    throw new Error(`Missing in-scope Go anchor: ${targetName}#${fragment}`);
  };
}
