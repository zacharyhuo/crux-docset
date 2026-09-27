const typeKinds = new Map([['8', 'Annotation'], ['9', 'Enum'], ['10', 'Interface'], ['11', 'Struct'], ['12', 'Class'], ['13', 'Class']]);
const memberKinds = new Map([['0', 'Constant'], ['1', 'Field'], ['2', 'Field'], ['3', 'Constructor'], ['4', 'Property'], ['5', 'Method'], ['6', 'Method'], ['7', 'Property']]);
const identifier = /^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u;
const controls = /[\u0000-\u001f\u007f]/;

function qualified(value) {
  if (typeof value !== 'string' || !value.split('.').every(part => identifier.test(part))) throw new Error('Invalid Javadoc qualified identity');
  return value;
}

function packageName(value) { return value === '<Unnamed>' ? '' : qualified(value); }

function pagePath(value) {
  if (typeof value !== 'string' || !value.endsWith('.html') || /[\\?#:]/.test(value) || controls.test(value)) throw new Error('Invalid Javadoc page path');
  for (const segment of value.split('/')) {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === '.' || decoded === '..' || /[%/\\?#:]/.test(decoded) || controls.test(decoded)) throw new Error('Unsafe Javadoc page path');
  }
  return value;
}

function fragment(value) {
  if (typeof value !== 'string' || !value || /[\\#]/.test(value) || controls.test(value)) throw new Error('Invalid Javadoc fragment');
  if (controls.test(decodeURIComponent(value))) throw new Error('Unsafe Javadoc fragment');
  return value;
}

function kindType(value, fallback, mapping) {
  const type = mapping.get(value === undefined ? fallback : value);
  if (!type) throw new Error('Unknown or cross-category Javadoc kind');
  return type;
}

/** Resolve parsed standard-doclet records without disk, network or script execution. */
export function resolveJavadocSymbols({ modules, packages, types, members }) {
  const symbols = [];
  const moduleNames = new Set();
  const packageModules = new Map();
  const typeIdentities = new Set();
  const symbolKeys = new Set();
  const add = (name, type, path) => {
    const key = JSON.stringify([name, type, path]);
    if (symbolKeys.has(key)) throw new Error('Duplicate Javadoc symbol');
    symbolKeys.add(key);
    symbols.push({ name, type, path });
  };
  const prefix = (module, pkg) => [module, pkg.replaceAll('.', '/')].filter(Boolean).join('/');
  const page = (module, pkg, file) => pagePath([prefix(module, pkg), file].filter(Boolean).join('/'));
  const resolveModule = row => {
    const pkg = packageName(row.p);
    const candidates = packageModules.get(pkg) ?? new Set(pkg === '' && moduleNames.size === 0 ? [''] : []);
    if (row.m !== undefined) {
      qualified(row.m);
      if (!moduleNames.has(row.m) || !candidates.has(row.m)) throw new Error('Unknown Javadoc module/package identity');
      return row.m;
    }
    if (candidates.size !== 1) throw new Error('Missing or ambiguous Javadoc package module');
    return [...candidates][0];
  };
  for (const row of modules) {
    const name = qualified(row.l);
    if (moduleNames.has(name)) throw new Error('Duplicate Javadoc module');
    moduleNames.add(name);
    add(name, 'Module', page(name, '', 'module-summary.html'));
  }
  for (const row of packages) {
    if (row.k === '18') continue;
    if (row.k !== undefined) throw new Error('Unknown Javadoc package kind');
    const pkg = packageName(row.l);
    const module = row.m === undefined ? '' : qualified(row.m);
    if (module && !moduleNames.has(module)) throw new Error('Unknown Javadoc module');
    const candidates = packageModules.get(pkg) ?? new Set();
    if (candidates.has(module)) throw new Error('Duplicate Javadoc package');
    candidates.add(module);
    packageModules.set(pkg, candidates);
    add(row.l, 'Package', row.u === undefined ? page(module, pkg, 'package-summary.html') : pagePath(row.u));
  }
  for (const row of types) {
    if (row.k === '18') continue;
    const pkg = packageName(row.p);
    const name = qualified(row.l);
    const module = resolveModule(row);
    const key = JSON.stringify([module, pkg, name]);
    if (typeIdentities.has(key)) throw new Error('Duplicate Javadoc type identity');
    typeIdentities.add(key);
    add([pkg, name].filter(Boolean).join('.'), kindType(row.k, '12', typeKinds),
      row.u === undefined ? page(module, pkg, `${name}.html`) : pagePath(row.u));
  }
  for (const row of members) {
    const pkg = packageName(row.p);
    const owner = qualified(row.c);
    const module = resolveModule(row);
    if (!typeIdentities.has(JSON.stringify([module, pkg, owner]))) throw new Error('Unknown Javadoc member owner');
    fragment(row.l);
    add([pkg, owner, row.l].filter(Boolean).join('.'), kindType(row.k, '5', memberKinds),
      `${page(module, pkg, `${owner}.html`)}#${fragment(row.u ?? row.l)}`);
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return symbols.sort((a, b) => compare(a.name, b.name) || compare(a.type, b.type) || compare(a.path, b.path));
}
