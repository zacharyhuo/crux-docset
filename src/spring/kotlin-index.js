const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const controls = /[\u0000-\u001f\u007f]/;
const modifiers = /^(?:(?:abstract|open|override|inline|suspend|infix|operator|lateinit|data|sealed|internal|public|protected|private|tailrec|external|expect|actual|const|final|crossinline|noinline) )*/;

function field(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192 || controls.test(value)) throw new Error('Invalid Kotlin index field or field limit');
  return value;
}

function location(value) {
  field(value);
  if (!value.endsWith('.html') || /[\\?#:]/.test(value)) throw new Error('Invalid Kotlin index location');
  for (const part of value.split('/')) {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === '.' || decoded === '..' || /[%/\\?#:]/.test(decoded) || controls.test(decoded)) throw new Error('Unsafe Kotlin index path');
  }
  return value;
}

/** Parse Dokka 2.1 pages.json as data only. Filesystem/content verification is
 * a separate caller gate; this resolver neither reads nor executes documents.
 */
export function resolveSpringKotlinIndex(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Kotlin index input limit exceeded');
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('Invalid Kotlin index JSON'); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 50000) throw new Error('Invalid or empty Kotlin index schema');
  const owners = new Map();
  const prepared = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'description,location,name,searchKeys') throw new Error('Invalid Kotlin index record schema');
    const signature = field(row.name), identity = field(row.description), target = location(row.location);
    if (!identity.split('.').every(part => identifier.test(part))) throw new Error('Invalid Kotlin qualified identity');
    if (!Array.isArray(row.searchKeys) || row.searchKeys.length !== 3 || row.searchKeys.some(key => typeof key !== 'string') ||
        row.searchKeys[0] !== identity.split('.').at(-1) || row.searchKeys[1] !== signature || row.searchKeys[2] !== identity) throw new Error('Inconsistent Kotlin search identity');
    const declaration = signature.replace(modifiers, '');
    let type;
    if (/^(?:class|object) /.test(declaration)) type = 'Class';
    else if (/^interface /.test(declaration)) type = 'Interface';
    else if (/^enum /.test(declaration)) type = 'Enum';
    if (type) {
      if (owners.has(identity)) throw new Error('Duplicate Kotlin type identity');
      owners.set(identity, type);
    }
    return { signature, identity, target, declaration, type };
  });
  const unique = new Set();
  const symbols = prepared.map(row => {
    const parent = row.identity.slice(0, row.identity.lastIndexOf('.'));
    let type = row.type;
    if (!type) {
      if (row.declaration.startsWith('constructor(')) type = 'Constructor';
      else if (row.declaration.startsWith('fun ')) type = owners.has(parent) ? 'Method' : 'Function';
      else if (/^(?:val|var) /.test(row.declaration)) type = 'Property';
      else if (owners.get(parent) === 'Enum' && row.signature === row.identity.split('.').at(-1)) type = 'Constant';
      else throw new Error(`Unsupported Kotlin declaration: ${row.signature}`);
    }
    const name = `${row.identity} — ${row.signature}`;
    field(name);
    const symbol = { name, type, path: row.target }, key = JSON.stringify(symbol);
    if (unique.has(key)) throw new Error('Duplicate Kotlin symbol');
    unique.add(key);
    return symbol;
  });
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return symbols.sort((a, b) => compare(a.name, b.name) || compare(a.type, b.type) || compare(a.path, b.path));
}
