#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, sha256, buildCandidate } from './pipeline.js';
import { withOfficialSource, buildPython } from './python.js';
import { validate } from './validate.js';
import { loadRecipeIcons } from './icons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, recipe: { type: 'string', default: 'recipes/python/recipe.json' },
    work: { type: 'string', default: '.work/python' }, archive: { type: 'string' },
    bundle: { type: 'string' }, 'base-url': { type: 'string' }
  } });
  if (values.help) {
    console.log('crux-docset build [--recipe FILE] [--work DIR] [--archive LOCAL.zip] [--base-url HTTPS_RELEASES_DOWNLOAD_URL]\ncrux-docset validate --bundle PATH [--recipe FILE]\nLocal-only by default. No upload or Git write. Requires Node >=24 and uv.');
  } else {
    const [command] = positionals;
    if (!['build', 'validate'].includes(command) || positionals.length !== 1) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
    const recipe = JSON.parse(await readFile(values.recipe, 'utf8'));
    if (recipe.schemaVersion !== 1 || recipe.builder?.adapter !== 'python-intersphinx') throw new Error('Unsupported recipe schema or adapter');
    if (command === 'validate') {
      if (!values.bundle) throw new Error('--bundle is required');
      const report = await validate(path.resolve(values.bundle), recipe);
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } else {
      const work = path.resolve(values.work);
      await mkdir(work, { recursive: true });
      const code = {};
      const icons = await loadRecipeIcons(path.dirname(path.resolve(values.recipe)));
      code.recipeIcons = fingerprint(icons);
      for (const name of (await readdir(path.join(root, 'src'))).filter(n => n.endsWith('.js')).sort()) code[name] = await sha256(path.join(root, 'src', name));
      for (const name of ['package-lock.json', 'tools/doc2dash/uv.lock', 'tools/doc2dash/pyproject.toml']) code[name] = await sha256(path.join(root, name));
      const builder = { digest: fingerprint(code), node: process.version, platform: process.platform, arch: process.arch, doc2dash: recipe.builder.doc2dash };
      const start = performance.now();
      const consume = async (archive, url) => buildCandidate({ work, recipe, source: { url, sha256: await sha256(archive) }, builder, validate, baseUrl: values['base-url'], build: dir => buildPython(dir, recipe, archive, icons) });
      const result = values.archive ? await consume(path.resolve(values.archive), 'local-archive') : await withOfficialSource(recipe, work, consume);
      console.log(JSON.stringify({ ...result, elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 }, null, 2));
    }
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
