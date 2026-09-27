import { load } from 'cheerio';

export const GO_CONTEXTS = Object.freeze(['linux/amd64', 'windows/amd64', 'darwin/amd64', 'js/wasm']);
const validPath = value => typeof value === 'string' && value.length <= 512 && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/.test(value);
const excludedReason = value => value.split('/').find(p => ['cmd', 'internal', 'vendor', 'testdata'].includes(p)) ??
  (value.split('/').some(p => p.startsWith('_')) ? 'hidden' : undefined);

export function readGoDirectory(html, { version }) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 16 * 1024 ** 2) throw new Error('Go directory size limit');
  const $ = load(html);
  if ($(`a[aria-label="Version: go${version}"]`).length !== 1) throw new Error('Go directory version mismatch');
  const links = $('.UnitDirectories-table a[href]');
  if (!links.length) throw new Error('Missing Go package directory');
  const packages = new Set();
  for (const element of links) {
    const href = $(element).attr('href'), suffix = `@go${version}`;
    if (!href.startsWith('/') || !href.endsWith(suffix)) throw new Error('Invalid Go directory link');
    const packagePath = href.slice(1, -suffix.length);
    if (!validPath(packagePath)) throw new Error('Invalid Go directory package path');
    packages.add(packagePath);
  }
  return [...packages].sort();
}

export function makeGoInventory({ version, sourcePackages, renderedPackages, contexts = GO_CONTEXTS }) {
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || JSON.stringify(contexts) !== JSON.stringify(GO_CONTEXTS)) throw new Error('Invalid Go version/contexts');
  if (!Array.isArray(sourcePackages) || !Array.isArray(renderedPackages) || sourcePackages.length > 10000 || renderedPackages.length > 10000) throw new Error('Go inventory size limit');
  const seen = new Set(), names = new Set(), namespaces = new Set(), excluded = new Map(), pages = [];
  for (const row of sourcePackages) {
    const { packagePath, context, experimental, files } = row;
    if (!validPath(packagePath) || !contexts.includes(context) || typeof experimental !== 'boolean' || !Array.isArray(files) || !files.length ||
        files.some(f => typeof f !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.go$/.test(f) || f.endsWith('_test.go')) || new Set(files).size !== files.length) throw new Error('Invalid Go source package');
    const key = `${packagePath}:${context}`;
    if (seen.has(key)) throw new Error('Duplicate Go source package/context');
    seen.add(key);
    const reason = excludedReason(packagePath);
    if (reason) { excluded.set(packagePath, reason); continue; }
    names.add(packagePath);
    const parts = packagePath.split('/');
    for (let i = 1; i < parts.length; i++) namespaces.add(parts.slice(0, i).join('/'));
    const [os, arch] = context.split('/');
    pages.push({ packagePath, context, experimental, route: `/${packagePath}@go${version}?GOOS=${os}&GOARCH=${arch}`,
      outputPath: `platforms/${os}-${arch}/${packagePath}/index.html` });
  }
  for (const required of ['builtin', 'unsafe']) if (!names.has(required)) throw new Error(`Go source inventory missing ${required}`);
  const rendered = new Set();
  for (const name of renderedPackages) {
    if (!validPath(name) || rendered.has(name)) throw new Error('Invalid/duplicate rendered Go package');
    rendered.add(name);
    const reason = excludedReason(name);
    if (reason) excluded.set(name, reason);
    else if (!names.has(name)) {
      if (!namespaces.has(name)) throw new Error(`Go coverage: unexpected rendered package ${name}`);
      excluded.set(name, 'namespace');
    }
  }
  for (const name of names) if (!rendered.has(name)) throw new Error(`Go coverage: missing rendered package ${name}`);
  pages.sort((a, b) => a.packagePath < b.packagePath ? -1 : a.packagePath > b.packagePath ? 1 : contexts.indexOf(a.context) - contexts.indexOf(b.context));
  return { pages, excluded: [...excluded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([packagePath, reason]) => ({ packagePath, reason })) };
}
