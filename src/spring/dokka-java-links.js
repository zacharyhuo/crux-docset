const qualified = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const mappings = new Map([
  ['kotlin.String', ['java.lang.String']], ['kotlin.Any', ['java.lang.Object']],
  ['kotlin.Annotation', ['java.lang.annotation.Annotation']], ['kotlin.CharSequence', ['java.lang.CharSequence']],
  ...[['Boolean', 'boolean'], ['Byte', 'byte'], ['Short', 'short'], ['Int', 'int'], ['Long', 'long'], ['Float', 'float'], ['Double', 'double'], ['Char', 'char']].flatMap(([name, primitive]) => [
    [`kotlin.${name}`, [primitive, `java.lang.${name === 'Int' ? 'Integer' : name === 'Char' ? 'Character' : name}`]],
    [`kotlin.${name}Array`, [`${primitive}[]`]],
  ]),
  ...['Iterable', 'Iterator', 'Collection', 'List', 'Set', 'Map'].flatMap(name => [
    [`kotlin.collections.${name}`, [`${name === 'Iterable' ? 'java.lang' : 'java.util'}.${name}`]],
    [`kotlin.collections.Mutable${name}`, [`${name === 'Iterable' ? 'java.lang' : 'java.util'}.${name}`]],
  ]),
]);

// Split nested DRI arguments, not commas inside a generic bound. Refuse syntax
// we cannot prove instead of applying a broad replacement regex.
function split(value) {
  if (!value) return [];
  const result = [], stack = []; let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '[' || ch === '(') { if (stack.length >= 16) throw new Error('depth'); stack.push(ch); }
    else if (ch === ']' || ch === ')') { if (stack.pop() !== (ch === ']' ? '[' : '(')) throw new Error('brackets'); }
    else if (ch === ',' && !stack.length) { result.push(value.slice(start, i)); start = i + 1; }
  }
  result.push(value.slice(start));
  if (stack.length || result.some(x => !x) || result.length > 100) throw new Error('arguments');
  return result;
}

function types(value, depth = 0) {
  if (depth > 16 || !value) throw new Error('type depth');
  if (value === '?') return ['?'];
  if (value.startsWith('TypeParam(bounds=[') && value.endsWith('])')) {
    const bounds = split(value.slice(18, -2));
    if (bounds.length !== 1) throw new Error('unsupported bounds');
    return types(bounds[0], depth + 1);
  }
  const nullable = value.endsWith('?');
  if (nullable) value = value.slice(0, -1);
  const bracket = value.indexOf('[');
  let base = value, args;
  if (bracket >= 0) {
    if (!value.endsWith(']')) throw new Error('generic');
    base = value.slice(0, bracket);
    args = split(value.slice(bracket + 1, -1));
    if (!args.length) throw new Error('empty generic');
    for (const arg of args) types(arg, depth + 1);
  }
  if (!qualified.test(base)) throw new Error('type');
  if (base === 'kotlin.Array') {
    if (args?.length !== 1) throw new Error('array');
    return types(args[0], depth + 1).filter(x => x.includes('.')).map(x => `${x}[]`);
  }
  const result = mappings.get(base) ?? [base];
  return nullable ? result.filter(x => x.includes('.') || x.endsWith('[]')) : result;
}

function method(value) {
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(value);
  if (!match) throw new Error('method');
  return { name: match[1], parameters: split(match[2]) };
}

/** Candidates must come from verified Javadoc detail anchors or explicit
 * inherited-member links whose declaring-page detail anchors were checked.
 * This pure matching step does not authenticate source/render provenance.
 * null means unsupported, absent, or ambiguous: never choose the first match.
 */
export function resolveDokkaJavaMember(fragment, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 10000) throw new Error('Java member inventory limit');
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.page !== 'string' || candidate.page.length > 4096 ||
        !candidate.page.endsWith('.html') || candidate.page.split('/').some(p => !/^[A-Za-z0-9_$.-]+$/.test(p) || p === '.' || p === '..') ||
        typeof candidate.anchor !== 'string' || !candidate.anchor || candidate.anchor.length > 8192 || /[\u0000-\u001f\u007f]/.test(candidate.anchor) ||
        !['Method', 'Constructor', 'Field', 'Constant', 'Class'].includes(candidate.kind)) throw new Error('Invalid Java member inventory');
    unique.set(JSON.stringify([candidate.page, candidate.anchor, candidate.kind]), candidate);
  }
  if (typeof fragment !== 'string' || fragment.length > 8192 || /[\u0000-\u0020\u007f]/.test(fragment)) return null;
  const members = [...unique.values()], exact = members.filter(x => x.anchor === fragment);
  if (exact.length) return exact.length === 1 ? { ...exact[0] } : null;
  let requested, parameterTypes;
  try { requested = method(fragment); parameterTypes = requested.parameters.map(value => types(value)); } catch { return null; }
  const matches = members.filter(candidate => {
    if (['Field', 'Constant'].includes(candidate.kind)) return !parameterTypes.length && candidate.anchor === requested.name;
    if (candidate.kind !== 'Method') return false;
    let declared;
    try { declared = method(candidate.anchor); } catch { return false; }
    if (declared.name !== requested.name || declared.parameters.length !== parameterTypes.length) return false;
    return declared.parameters.every((type, i) => parameterTypes[i].includes(type) ||
      (i === declared.parameters.length - 1 && type.endsWith('...') && parameterTypes[i].includes(type.slice(0, -3))));
  });
  return matches.length === 1 ? { ...matches[0] } : null;
}
