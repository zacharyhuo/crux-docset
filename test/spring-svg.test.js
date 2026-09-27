import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySpringSvg } from '../src/spring/svg.js';
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${body}</svg>`;

test('accepts static vector artwork and resolves local paint/use references', () => {
  assert.deepEqual(verifySpringSvg(wrap('<defs><path id="shape" d="M0 0"/><radialGradient id="paint"><stop offset="0" stop-color="#fff"/></radialGradient></defs><use xlink:href="#shape" fill="url(#paint)"/>')), { elements: 6, references: 2 });
});
test('inspects SVG CSS declarations for local references and missing targets', () => {
  assert.equal(verifySpringSvg(wrap('<defs><radialGradient id="a"/></defs><path style="fill:url(#a);opacity:.5"/>')).references, 1);
  assert.throws(() => verifySpringSvg(wrap('<path fill="url(#missing)"/>')), /missing/i);
  assert.throws(() => verifySpringSvg(wrap('<path id="a"/><path id="a"/>')), /duplicate/i);
});
test('preserves upstream artwork IDs rather than applying filesystem-path rules to inert names', () => {
  assert.equal(verifySpringSvg(wrap('<g id="Fill 1"><path id="⌘/modifier/kotlin"/></g><use xlink:href="#⌘/modifier/kotlin"/>')).references, 1);
});
test('rejects executable or external content without fetching it', () => {
  for (const body of ['<script>alert(1)</script>', '<foreignObject/>', '<image href="https://example.com/a.png"/>',
    '<use xlink:href="other.svg#a"/>', '<path onload="alert(1)"/>', '<path style="fill:url(https://example.com/a.svg)"/>',
    '<path fill="url(&#104;ttps://example.com/a.svg)"/>']) assert.throws(() => verifySpringSvg(wrap(body)), /SVG/i, body);
});
test('rejects namespace confusion, DTD, processing instructions and malformed XML', () => {
  for (const input of ['<svg/>', '<svg xmlns="http://evil.invalid"/>', wrap('<path xmlns="http://evil.invalid"/>'),
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]>' + wrap('<path/>'),
    '<?xml-stylesheet href="https://example.com/a.css"?>' + wrap('<path/>'), wrap('<path>'), wrap('<path id="a" id="b"/>')]) {
    assert.throws(() => verifySpringSvg(input), /SVG|XML/i, input);
  }
});
test('bounds SVG bytes and node count', () => {
  assert.throws(() => verifySpringSvg('x'.repeat(256 * 1024 + 1)), /limit/i);
  assert.throws(() => verifySpringSvg(wrap('<g/>'.repeat(10001))), /limit/i);
});
