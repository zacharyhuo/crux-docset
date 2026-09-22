import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprint } from '../src/pipeline.js';
import { PNG } from 'pngjs';

test('recipe icons are local, validated and included in build identity', async t => {
  const icons = await import('../src/icons.js').catch(() => ({}));
  assert.equal(typeof icons.loadRecipeIcons, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-icons-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'));
  for (const name of ['icon.png', 'icon@2x.png']) {
    await copyFile(new URL(`../recipes/python/assets/${name}`, import.meta.url), path.join(root, 'assets', name));
  }
  const original = await icons.loadRecipeIcons(root);
  assert.deepEqual(original['icon.png'], await readFile(path.join(root, 'assets/icon.png')));
  const decoded = PNG.sync.read(original['icon.png']);
  decoded.data[0] ^= 255;
  const changed = PNG.sync.write(decoded);
  await writeFile(path.join(root, 'assets/icon.png'), changed);
  assert.notEqual(fingerprint(original), fingerprint(await icons.loadRecipeIcons(root)));
  await writeFile(path.join(root, 'assets/icon.png'), 'bad png');
  await assert.rejects(icons.loadRecipeIcons(root), /PNG|icon/i);
  await rm(path.join(root, 'assets/icon.png'));
  await symlink(path.join(root, 'assets/icon@2x.png'), path.join(root, 'assets/icon.png'));
  await assert.rejects(icons.loadRecipeIcons(root), /regular|symlink/i);
});
