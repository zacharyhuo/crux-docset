import { parse, walk, tokenize, tokenTypes } from 'css-tree';

// Finite Spring Javadoc/Dokka CSS profile, not a general CSS sanitizer.
const rules = new Set(['import', 'media', 'font-face', '-moz-document']);
const functions = new Set(['var', 'rgba', 'hsla', 'invert', 'rotate', 'calc', 'translatez', 'min',
  'linear-gradient', 'rect', 'format', 'rgb', 'url-prefix', 'brightness', 'sepia', 'saturate',
  'hue-rotate', 'contrast', 'minmax', 'image-set', '-webkit-image-set', 'type']);

function checkTokens(css) {
  const t = tokenTypes, stack = []; let count = 0;
  const opening = new Map([[t.Function, t.RightParenthesis], [t.LeftParenthesis, t.RightParenthesis],
    [t.LeftSquareBracket, t.RightSquareBracket], [t.LeftCurlyBracket, t.RightCurlyBracket]]);
  const closing = new Set(opening.values());
  tokenize(css, (type, start, end) => {
    if (++count > 500000) throw new Error('CSS token limit');
    if (opening.has(type)) {
      stack.push(opening.get(type));
      if (stack.length > 128) throw new Error('CSS nesting limit');
    } else if (closing.has(type) && stack.pop() !== type) throw new Error('Invalid CSS delimiter');
    if (type === t.BadString || type === t.BadUrl) throw new Error('Invalid CSS token');
    if (type === t.String || type === t.Url) {
      const last = css[end - 1], expected = type === t.String ? css[start] : ')';
      let slashCount = 0;
      for (let i = end - 2; i >= start && css[i] === '\\'; i--) slashCount++;
      if (last !== expected || slashCount % 2 || end - start < 2) throw new Error('Unterminated CSS resource/string');
    }
    if (type === t.Comment && !css.slice(start, end).endsWith('*/')) throw new Error('Unterminated CSS comment');
  });
  if (stack.length) throw new Error('Unterminated CSS block');
}

/** Return decoded dependencies in document order, including data URLs.
 * Callers must resolve paths, verify files/import closure and inspect embedded
 * content. This neither executes CSS nor proves JS/offline runtime behavior.
 */
export function readSpringCssReferences(css, { context = 'stylesheet' } = {}) {
  if (!['stylesheet', 'declarationList'].includes(context)) throw new Error('Invalid CSS context');
  if (typeof css !== 'string' || !css.isWellFormed()) throw new Error('Invalid CSS text');
  if (Buffer.byteLength(css) > 2 * 1024 ** 2) throw new Error('CSS input limit');
  checkTokens(css);
  const ast = parse(css, { context, parseCustomProperty: true, onParseError(error) { throw new Error(`Invalid CSS: ${error.message}`); } });
  const result = [], parents = []; let nodes = 0;
  function add(kind, url) {
    if (url.length > 65536 || result.length >= 10000) throw new Error('CSS dependency limit');
    result.push({ kind, url });
  }
  walk(ast, {
    enter(node) {
      if (++nodes > 200000) throw new Error('CSS node limit');
      const parent = parents.at(-1);
      if (node.type === 'Raw') throw new Error('Unsupported opaque CSS');
      if (node.type === 'Atrule') {
        if (!rules.has(node.name.toLowerCase())) throw new Error(`Unsupported CSS rule: ${node.name}`);
        if (node.name.toLowerCase() === 'import' && !['String', 'Url'].includes(node.prelude?.children.first?.type)) throw new Error('Unsupported CSS import target');
      }
      if (node.type === 'Function') {
        if (!functions.has(node.name.toLowerCase())) throw new Error(`Unsupported CSS function: ${node.name}`);
        if (['image-set', '-webkit-image-set'].includes(node.name.toLowerCase())) {
          for (const child of node.children) if (!['String', 'Url', 'Dimension', 'Operator'].includes(child.type) &&
              !(child.type === 'Function' && child.name.toLowerCase() === 'type')) throw new Error('Unsupported computed CSS image-set');
        }
      }
      const isImport = parent?.type === 'AtrulePrelude' && parents.at(-2)?.name?.toLowerCase() === 'import';
      if (node.type === 'Url') add(isImport ? 'import' : 'url', node.value);
      if (node.type === 'String') {
        if (isImport && parent.children.first === node) add('import', node.value);
        else if (parent?.type === 'Function' && ['image-set', '-webkit-image-set'].includes(parent.name.toLowerCase())) add('image-set', node.value);
      }
      parents.push(node);
    },
    leave() { parents.pop(); },
  });
  return result;
}
