const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 200000;
const MAX_FIELD_BYTES = 16 * 1024;
const schemas = new Map([
  ['module', { fields: ['l'], required: ['l'], kinds: [] }],
  ['package', { fields: ['l', 'm', 'u', 'k'], required: ['l'], kinds: ['18'] }],
  ['type', { fields: ['l', 'p', 'm', 'u', 'k'], required: ['l', 'p'], kinds: ['8', '9', '10', '11', '12', '13', '18'] }],
  ['member', { fields: ['l', 'p', 'c', 'm', 'u', 'k'], required: ['l', 'p', 'c'], kinds: ['0', '1', '2', '3', '4', '5', '6', '7'] }],
]);

/** Parse the pinned standard-doclet wire format as data, never JavaScript. */
export function parseSearchData(text, kind) {
  const schema = schemas.get(kind);
  if (!schema || typeof text !== 'string') throw new Error('Invalid Javadoc search input or kind');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Javadoc search file exceeds byte limit');
  const source = text.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  const prefix = `${kind}SearchIndex = `;
  const suffix = ';updateSearchResults();';
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) throw new Error('Unrecognized Javadoc search wrapper');
  const json = source.slice(prefix.length, -suffix.length);
  scanRecords(json, schema);
  return JSON.parse(json);
}

// A non-recursive grammar restricted to an array of string-valued records.
// JSON.parse alone loses duplicate keys; scan decoded keys before final parsing.
function scanRecords(json, schema) {
  let offset = 0;
  const fail = message => { throw new Error(`Invalid Javadoc search data at ${offset}: ${message}`); };
  const whitespace = () => { while (offset < json.length && /[\t\n\r ]/.test(json[offset])) offset++; };
  const take = character => {
    whitespace();
    if (json[offset] !== character) fail(`expected ${character}`);
    offset++;
  };
  const string = () => {
    whitespace();
    if (json[offset] !== '"') fail('expected string');
    const start = offset++;
    while (offset < json.length) {
      const character = json[offset++];
      if (character === '\\') { offset++; continue; }
      if (character !== '"') continue;
      let value;
      try { value = JSON.parse(json.slice(start, offset)); }
      catch { fail('malformed string'); }
      if (!value.length || Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) fail('empty or oversized field');
      return value;
    }
    fail('unterminated string');
  };
  take('[');
  whitespace();
  let count = 0;
  if (json[offset] !== ']') {
    while (true) {
      if (++count > MAX_ITEMS) fail('too many items');
      take('{');
      const fields = new Map();
      whitespace();
      if (json[offset] !== '}') {
        while (true) {
          const key = string();
          if (!schema.fields.includes(key) || fields.has(key)) fail('unknown or duplicate field');
          take(':');
          fields.set(key, string());
          whitespace();
          if (json[offset] !== ',') break;
          offset++;
        }
      }
      take('}');
      const kind = fields.get('k');
      if (kind !== undefined && !schema.kinds.includes(kind)) fail('unknown or cross-category kind');
      const required = kind === '18' ? ['l', 'u'] : schema.required;
      if (required.some(key => !fields.has(key))) fail('missing required field');
      whitespace();
      if (json[offset] !== ',') break;
      offset++;
    }
  }
  take(']');
  whitespace();
  if (offset !== json.length) fail('trailing content');
}
