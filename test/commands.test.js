import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as plist from 'plist';
import { PNG } from 'pngjs';

const commands = await import('../src/commands.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const adapters = await import('../src/adapters.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });

async function fixture(t) {
  assert.equal(typeof commands.runCLI, 'function', 'CLI needs a shared multi-adapter command handler');
  const root = await mkdtemp(path.join(tmpdir(), 'crux-commands-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'builder.js'), '// test adapter input');
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  for (const id of ['alpha', 'beta']) {
    const dir = path.join(root, 'recipes', id);
    await mkdir(path.join(dir, 'variants'), { recursive: true });
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ schemaVersion: 2, id, sourceId: 'dev.crux', name: id, identifier: `dev.crux.${id}`, bundleName: id, homepage: 'index.html', defaultVariant: `${id}-2-en`, source: {}, builder: { adapter: id }, validation: { requireIcons: true, minimumPages: 1, minimumSymbols: 1, requiredSymbols: ['sample'] } }));
    for (const line of ['1', '2']) await writeFile(path.join(dir, 'variants', `${id}-${line}-en.json`), JSON.stringify({ variantId: `${id}-${line}-en`, versionLine: line, language: 'en', enabled: true }));
    for (const [name, size] of [['icon.png', 16], ['icon@2x.png', 32]]) await writeFile(path.join(dir, 'assets', name), PNG.sync.write(new PNG({ width: size, height: size })));
  }
  // Two in-memory test adapters, never addressable by recipe module paths or CLI flags.
  const makeAdapter = marker => ({
    inputFiles: [], acceptsArchive: false,
    async resolve(recipe, context) {
      await writeFile(path.join(context.directory, 'input.txt'), marker);
      return { source: { commit: marker }, input: context.directory };
    },
    async build(recipe, snapshot, context) {
      assert.equal(await readFile(path.join(snapshot.input, 'input.txt'), 'utf8'), marker);
      const bundle = path.join(context.candidate, `${recipe.bundleName}.docset`);
      const resources = path.join(bundle, 'Contents/Resources');
      await mkdir(path.join(resources, 'Documents'), { recursive: true });
      await writeFile(path.join(bundle, 'Contents/Info.plist'), plist.build({ CFBundleIdentifier: recipe.identifier, CFBundleName: recipe.name, isDashDocset: true, dashIndexFilePath: 'index.html' }));
      await writeFile(path.join(resources, 'Documents/index.html'), '<h1 id="sample">sample</h1>');
      const db = new DatabaseSync(path.join(resources, 'docSet.dsidx'));
      try { db.exec("CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT); INSERT INTO searchIndex VALUES(1,'sample','Guide','index.html#sample')"); } finally { db.close(); }
      return { version: `${recipe.versionLine}.0.0` };
    }
  });
  const registered = new Map([['alpha', makeAdapter('a')], ['beta', makeAdapter('b')]]);
  return { root, context: { root, resolveAdapter: id => { const a = registered.get(id); if (!a) throw new Error('Unsupported adapter'); return a; } } };
}

test('CLI routes distinct adapters and version lines through isolated validated pipelines', async t => {
  const { root, context } = await fixture(t);
  const build = async (...args) => JSON.parse((await commands.runCLI(['build', ...args], context)).output);
  const a = await build('--id', 'alpha');
  const b = await build('--id', 'beta');
  const old = await build('--id', 'alpha', '--variant', 'alpha-1-en');
  assert.equal(a.variantId, 'alpha-2-en');
  assert.equal(b.variantId, 'beta-2-en');
  assert.equal(old.variantId, 'alpha-1-en');
  assert.equal(a.directory.startsWith(path.join(root, '.work/alpha-2-en/releases/')), true);
  assert.equal(b.directory.startsWith(path.join(root, '.work/beta-2-en/releases/')), true);
  assert.equal(old.directory.startsWith(path.join(root, '.work/alpha-1-en/releases/')), true);
  assert.equal((await build('--id', 'alpha')).status, 'unchanged');
  for (const result of [a, b, old]) {
    const report = JSON.parse(await readFile(path.join(result.directory, 'validation.json')));
    assert.equal(report.passed, true);
    assert.equal(report.symbolCount, 1);
  }
  await assert.rejects(build('--id', 'alpha', '--variant', 'alpha-1-en', '--work', path.join(root, '.work/alpha-2-en')), /identity|owner/i);
  const names = await readdir(path.join(root, '.work/alpha-2-en'));
  assert.equal(names.some(n => n.startsWith('source-')), false, 'resolved source scratch is cleaned');
});

test('CLI rejects unsupported local archives and unknown adapters before creating build state', async t => {
  const { root, context } = await fixture(t);
  await assert.rejects(commands.runCLI(['build', '--id', 'alpha', '--archive', '/not/a/file'], context), /archive/i);
  const recipePath = path.join(root, 'recipes/alpha/recipe.json');
  const recipe = JSON.parse(await readFile(recipePath));
  await writeFile(recipePath, JSON.stringify({ ...recipe, builder: { adapter: '../untrusted.js' } }));
  await assert.rejects(commands.runCLI(['build', '--id', 'alpha'], context), /adapter/i);
  await assert.rejects(readdir(path.join(root, '.work')), { code: 'ENOENT' });
});

test('production registry is static and refuses recipe-provided executable module paths', () => {
  assert.equal(typeof adapters.getAdapter, 'function');
  assert.equal(typeof adapters.getAdapter('python-intersphinx').resolve, 'function');
  for (const value of ['../test/commands.test.js', 'constructor', 'toString', 'unknown']) assert.throws(() => adapters.getAdapter(value), /adapter/i);
});
