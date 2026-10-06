import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('candidate cache includes schema-2 ownership and isolates reviewed variant caches', async () => {
  const workflow = await readFile(new URL('../.github/workflows/python-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\.work\/python\/owner\.json/);
  assert.match(workflow, /python-candidate-v3-.*env\.VARIANT/);
  assert.doesNotMatch(workflow, /python-candidate-v[12]-/);
  assert.match(workflow, /source-lock\.json/);
  assert.doesNotMatch(workflow, /--base-url/, 'CI has no configured publisher and cannot invent artifact URLs');
});

test('daily supply remains default-only while manual historical supply binds variant through build qualification and publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/python-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /type: choice\s+options:\s+- python-3-14-en\s+- python-3-13-en/);
  assert.match(workflow, /github\.event\.inputs\.variant \|\| 'python-3-14-en'/);
  assert.match(workflow, /build --id python --variant "\$VARIANT" --work \.work\/python/);
  assert.match(workflow, /qualify --id python --variant "\$VARIANT"/);
  assert.match(workflow, /VARIANT: \$\{\{ needs\.build\.outputs\.variant \}\}/);
  assert.match(workflow, /publish --id python --variant "\$VARIANT"/);
});

test('supply workflow preserves main-only builds and confines write permission to independently validating publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/python-candidate.yml', import.meta.url), 'utf8');
  const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  publish:'));
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(build, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(build, /contents: write/);
  assert.match(build, /cli\.js restore/);
  assert.match(build, /--publication-state \.publisher/);
  assert.match(build, /cli\.js qualify/);
  assert.match(build, /python-unreserved/);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /contents: write/);
  assert.match(publish, /cli\.js publish/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.(?!GITHUB_TOKEN)[A-Z_]+|git push|--clobber/);
});
