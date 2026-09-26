import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('CLI help is usable and unknown commands fail without a build', () => {
  const help = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /build/);
  const invalid = spawnSync(process.execPath, ['src/cli.js', 'typo'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown command/);
});

test('CLI lists available variants without downloading or starting a builder', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'list'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.ok(rows.some(row => row.familyId === 'python' && row.variantId === 'python-3-14-en' && row.enabled));
});

test('CLI rejects ambiguous recipe selectors before building', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'build', '--id', 'python', '--recipe', 'recipes/python/recipe.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /together|exclusive/i);
});
