import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { prepareSpringKotlinPage } from '../src/spring/kotlin-page.js';

const playground = '<script type="text/javascript" src="https://unpkg.com/kotlin-playground@1/dist/playground.min.js" async=""></script>';
const document = extra => `<html><head>${extra}<script src="scripts/platform-content-handler.js" defer></script></head><body><a id="x%2Fy"></a><div class="sample-container"><pre><code class="block lang-kotlin" theme="idea">fun main() {<br>  println(&quot;&lt;hello&gt;&quot;)<br>}</code></pre></div></body></html>`;

test('removes only the unused pinned Playground loader while preserving static examples and local UI', () => {
  const input = document(playground), before = load(input);
  const result = prepareSpringKotlinPage(input), after = load(result.html);
  assert.equal(result.removedPlayground, true);
  assert.equal(after('script[src]').length, 1);
  assert.equal(after('script').attr('src'), 'scripts/platform-content-handler.js');
  assert.equal(after('.sample-container').html(), before('.sample-container').html());
  assert.equal(after('[id]').attr('id'), 'x%2Fy');
  assert.equal(prepareSpringKotlinPage(result.html).removedPlayground, false);
});

test('does not silently discard runnable Kotlin examples', () => {
  assert.throws(() => prepareSpringKotlinPage(document(playground).replace('block lang-kotlin', 'runnablesample')), /runnable/i);
});

test('rejects changed or executable Playground loaders instead of deleting unreviewed behavior', () => {
  for (const script of [playground.replace('@1/', '@2/'), playground.replace(' async=""', ' onload="start()"'), playground.replace('</script>', 'start()</script>'), playground + playground]) {
    assert.throws(() => prepareSpringKotlinPage(document(script)), /Playground/i);
  }
});

test('bounds page input and preserves other resources for the later resource gate', () => {
  assert.throws(() => prepareSpringKotlinPage(null), /input/i);
  assert.throws(() => prepareSpringKotlinPage('x'.repeat(16 * 1024 * 1024 + 1)), /limit/i);
  const result = prepareSpringKotlinPage(document('<script src="https://example.invalid/other.js"></script>'));
  assert.equal(load(result.html)('script[src="https://example.invalid/other.js"]').length, 1);
  assert.equal(result.removedPlayground, false);
});
