import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('candidate cache includes schema-2 ownership and does not reuse ownerless v1 caches', async () => {
  const workflow = await readFile(new URL('../.github/workflows/python-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\.work\/python\/owner\.json/);
  assert.match(workflow, /python-candidate-v2-/);
  assert.doesNotMatch(workflow, /python-candidate-v1-/);
  assert.match(workflow, /source-lock\.json/);
  assert.doesNotMatch(workflow, /--base-url/, 'CI has no configured publisher and cannot invent artifact URLs');
});
