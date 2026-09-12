import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { environment, run, WORK } from './run.mjs';
import { inspectHTML, validateContext, main as renderMain } from './render.mjs';

test('environment does not inherit credentials, proxies, Node injection, or host HOME', () => {
  process.env.MDN_EXPERIMENT_FAKE_SECRET = 'must-not-pass';
  try {
    const env = environment();
    assert.equal(env.MDN_EXPERIMENT_FAKE_SECRET, undefined);
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'HTTPS_PROXY', 'NODE_PATH']) {
      assert.equal(env[key], undefined);
    }
    assert.equal(env.HOME, path.join(WORK, 'home'));
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=2048');
  } finally { delete process.env.MDN_EXPERIMENT_FAKE_SECRET; }
});
test('a successful measured child sees only the clean environment', async () => {
  process.env.MDN_EXPERIMENT_FAKE_SECRET = 'must-not-pass';
  try {
    const result = await run('test-clean-child', [process.execPath, '-e',
      'if(process.env.MDN_EXPERIMENT_FAKE_SECRET) process.exit(9); console.log(process.env.HOME)']);
    assert.equal(result.returncode, 0);
    assert.ok(result.max_rss_bytes > 0);
  } finally { delete process.env.MDN_EXPERIMENT_FAKE_SECRET; }
});
test('nonzero exit is a failure, and a hanging child is bounded', async () => {
  await assert.rejects(run('test-exit', [process.execPath, '-e', 'process.exit(7)']), /failed \(7\)/);
  const start = performance.now();
  await assert.rejects(run('test-timeout', [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    { timeout: 200 }), /failed \(124\)/);
  assert.ok(performance.now() - start < 5000);
  const records = (await readFile(path.join(WORK, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.at(-1).returncode, 124);
});
test('fallback routes and empty fragments cannot be counted as generated documents', () => {
  assert.throws(() => validateContext({ renderer: 'Homepage', url: '/en-US/' }));
  assert.throws(() => validateContext({ renderer: 'Doc', url: '/en-US/docs/Web/CSS', doc: { body: [] } }));
  assert.throws(() => inspectHTML('<!--lit-part--><!--/lit-part-->'));
  const metrics = inspectHTML('<h1>Demo</h1><section>' + 'x'.repeat(1000) +
    '<script src="https://example.invalid/a.js"></script><iframe src="/sample"></iframe>{{broken}}</section>');
  assert.equal(metrics.scripts, 1);
  assert.equal(metrics.iframes, 1);
  assert.equal(metrics.resource_refs.length, 2);
  assert.deepEqual(metrics.unresolved_macros, ['{{broken}}']);
});
test('direct SSR invocation refuses the host environment before importing upstream code', async () => {
  await assert.rejects(renderMain(), /Use run.mjs render/);
});
