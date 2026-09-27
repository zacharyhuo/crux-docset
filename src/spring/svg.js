import { DOMParser } from '@xmldom/xmldom';
import { readSpringCssReferences } from './css.js';

const svgNS = 'http://www.w3.org/2000/svg';
const tags = new Set('svg g path mask defs rect use polygon radialGradient stop circle'.split(' '));
const attrs = new Set('width height viewBox fill id fill-rule clip-rule d fill-opacity style maskUnits x y mask transform stroke stroke-opacity points rx opacity cx cy r gradientUnits gradientTransform offset stop-color version'.split(' '));
const isIdentifier = value => value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);

/** Fixed static Javadoc/Dokka SVG profile. Reject unknown active/resource forms;
 * no fetching, rewriting, rasterization or general-purpose SVG support.
 */
export function verifySpringSvg(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('Invalid SVG text');
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('SVG input limit');
  // No entity declarations, external subsets or stylesheet instructions. Ordinary
  // XML declaration is allowed; xmldom checks its syntax but does not fetch it.
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) throw new Error('Unsupported SVG XML declaration');
  let doc;
  try { doc = new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(text, 'image/svg+xml'); }
  catch (error) { throw new Error(`Invalid SVG XML: ${error.message}`); }
  if (doc.documentElement?.tagName !== 'svg' || doc.documentElement.getAttribute('xmlns') !== svgNS) throw new Error('Invalid SVG root/namespace');
  const ids = new Set(), references = [], stack = [doc];
  let nodes = 0, elements = 0;
  const add = value => {
    if (!value.startsWith('#') || !isIdentifier(value.slice(1))) throw new Error('Unsupported SVG external/resource reference');
    references.push(value.slice(1));
    if (references.length > 10000) throw new Error('SVG reference limit');
  };
  while (stack.length) {
    const node = stack.pop();
    if (++nodes > 10000) throw new Error('SVG node limit');
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
    if (node.nodeType !== 1) {
      if (![3, 8, 9].includes(node.nodeType) && !(node.nodeType === 7 && node.target === 'xml')) throw new Error('Unsupported SVG XML node');
      continue;
    }
    elements++;
    if (node.namespaceURI !== svgNS || !tags.has(node.tagName)) throw new Error(`Unsupported SVG element: ${node.tagName}`);
    for (const attr of Array.from(node.attributes)) {
      const { name, value } = attr;
      if (name === 'xmlns' && value === svgNS) continue;
      if (name === 'xmlns:xlink' && value === 'http://www.w3.org/1999/xlink') continue;
      if (name === 'xlink:href' && attr.namespaceURI === 'http://www.w3.org/1999/xlink' && node.tagName === 'use') { add(value); continue; }
      if (attr.namespaceURI || !attrs.has(name)) throw new Error(`Unsupported SVG attribute: ${name}`);
      if (name === 'id') {
        if (!isIdentifier(value) || ids.has(value)) throw new Error('Invalid/duplicate SVG ID');
        ids.add(value);
      }
      if (name === 'style' || ['fill', 'stroke', 'mask'].includes(name)) {
        const css = name === 'style' ? value : `${name}:${value}`;
        for (const reference of readSpringCssReferences(css, { context: 'declarationList' })) add(reference.url);
      }
    }
  }
  for (const id of references) if (!ids.has(id)) throw new Error(`Missing SVG reference: ${id}`);
  return { elements, references: references.length };
}
