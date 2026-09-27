import test from 'node:test';
import assert from 'node:assert/strict';
import { readSpringCssReferences } from '../src/spring/css.js';

test('finds stylesheet imports and font/image URLs without treating comments or content text as requests', () => {
  const css = `/* url(https://not-a-request.invalid/) */
    @import "fonts/fonts.css" screen;
    @import url('theme.css');
    @font-face { font-family: test; src: url(font.woff2) format('woff2'); }
    .icon { background: URL("../images/icon.svg"); content: "url(fake.png)"; }`;
  assert.deepEqual(readSpringCssReferences(css), [
    { kind: 'import', url: 'fonts/fonts.css' }, { kind: 'import', url: 'theme.css' },
    { kind: 'url', url: 'font.woff2' }, { kind: 'url', url: '../images/icon.svg' },
  ]);
});
test('decodes escaped URL values so a remote request cannot hide behind CSS escaping', () => {
  assert.deepEqual(readSpringCssReferences(String.raw`.a{background:url(https\3a //example.com/i.svg)} .b{background:url("../images/\69 con.svg")}`), [
    { kind: 'url', url: 'https://example.com/i.svg' }, { kind: 'url', url: '../images/icon.svg' },
  ]);
});
test('finds image-set strings and URLs including custom-property values', () => {
  assert.deepEqual(readSpringCssReferences(':root{--image:url(a.svg)} .a{background:image-set("one.png" 1x,url(two.png) 2x)}'), [
    { kind: 'url', url: 'a.svg' }, { kind: 'image-set', url: 'one.png' }, { kind: 'url', url: 'two.png' },
  ]);
});
test('reports data images as dependencies instead of silently approving embedded SVG', () => {
  assert.deepEqual(readSpringCssReferences(`.a{background:url('data:image/svg+xml,<svg/>')}`), [
    { kind: 'url', url: 'data:image/svg+xml,<svg/>' },
  ]);
});
test('parses SVG style declarations without pretending they are a stylesheet', () => {
  assert.deepEqual(readSpringCssReferences('fill:url(#paint);opacity:.5', { context: 'declarationList' }), [{ kind: 'url', url: '#paint' }]);
  assert.throws(() => readSpringCssReferences('color:red', { context: 'value' }), /context/i);
});
test('rejects opaque syntax and unreviewed computed resource forms instead of undercounting', () => {
  for (const css of ['.a{background:url("broken)}', '.a{background:attr(data-image type(<url>))}',
    '@unknown "hidden.css";', '.a{background:image("a.png")}', String.raw`.a{background:u\72l("hidden.png")}`,
    String.raw`@\69mport "hidden.css";`]) {
    assert.throws(() => readSpringCssReferences(css), /CSS/i, css);
  }
});
test('rejects oversized or invalid text and bounds dependency count', () => {
  assert.throws(() => readSpringCssReferences('x'.repeat(2 * 1024 ** 2 + 1)), /limit/i);
  assert.throws(() => readSpringCssReferences('\ud800'), /CSS/i);
  assert.throws(() => readSpringCssReferences('.a{background:' + 'url(a),'.repeat(10001) + 'none}'), /limit/i);
});
