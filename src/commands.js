import { parseArgs } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, buildCandidate } from './pipeline.js';
import { validate } from './validate.js';
import { loadRecipeIcons } from './icons.js';
import { loadRecipe, listRecipes, hashBuildInputs } from './recipes.js';
import { getAdapter } from './adapters.js';
import { regularPath } from './build-state.js';

const help = `crux-docset list
crux-docset build [--id FAMILY | --recipe FILE] [--variant ID] [--work DIR] [--archive LOCAL.zip] [--base-url HTTPS_ARTIFACT_ROOT]
crux-docset validate --bundle PATH [--id FAMILY | --recipe FILE] [--variant ID]
Local-only by default. No upload or Git write. Requires Node >=24; Python builds also require uv.`;
const jsonOutput = (value, exitCode = 0) => ({ output: JSON.stringify(value, null, 2), exitCode });

// Explicit dependencies let fixture adapters exercise the same command/pipeline as the CLI.
// The executable always uses the static repository registry, never one supplied by a recipe.
export async function runCLI(args, { root, resolveAdapter = getAdapter }) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, recipe: { type: 'string' }, id: { type: 'string' }, variant: { type: 'string' },
    work: { type: 'string' }, archive: { type: 'string' }, bundle: { type: 'string' }, 'base-url': { type: 'string' }
  } });
  if (values.help) return { output: help, exitCode: 0 };
  const [command] = positionals;
  if (!['build', 'validate', 'list'].includes(command) || positionals.length !== 1) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  if (command === 'list') {
    if (Object.keys(values).length) throw new Error('list does not accept build options');
    return jsonOutput(await listRecipes({ root }));
  }
  const { recipe, recipeDirectory, work } = await loadRecipe({ root, id: values.id, recipePath: values.recipe, variantId: values.variant, work: values.work });
  const adapter = resolveAdapter(recipe.builder.adapter);
  if (command === 'validate') {
    if (!values.bundle) throw new Error('--bundle is required');
    if (values.archive || values['base-url'] || values.work) throw new Error('validate does not accept build options');
    const report = await validate(path.resolve(values.bundle), recipe);
    return jsonOutput(report, report.passed ? 0 : 1);
  }
  if (values.bundle) throw new Error('build does not accept --bundle');
  if (values.archive && !adapter.acceptsArchive) throw new Error(`Adapter ${recipe.builder.adapter} does not accept --archive`);
  const baseUrl = values['base-url'];
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('--base-url requires HTTPS with no credentials, query or fragment');
  }
  const code = await hashBuildInputs(root, ['src', 'package-lock.json', ...adapter.inputFiles]);
  const icons = await loadRecipeIcons(recipeDirectory);
  code.recipeIcons = fingerprint(icons);
  const builder = { digest: fingerprint(code), node: process.version, platform: process.platform, arch: process.arch, adapter: recipe.builder.adapter, configuration: recipe.builder };
  const start = performance.now();
  const result = await buildCandidate({ work, recipe, builder, validate, baseUrl, withSource: async consume => {
    // Ownership and the variant lock are already held before allocating source scratch.
    const directory = await mkdtemp(path.join(work, 'source-'));
    try {
      const snapshot = await adapter.resolve(recipe, { directory, archive: values.archive ? path.resolve(values.archive) : undefined });
      return await consume(snapshot.source, async candidate => {
        const built = await adapter.build(recipe, snapshot, { candidate, icons });
        const bundle = path.join(candidate, `${recipe.bundleName}.docset`);
        await regularPath(bundle, true);
        // Icons are a common packaging responsibility. A builder cannot redirect writes.
        for (const [name, bytes] of Object.entries(icons)) {
          try { await regularPath(path.join(bundle, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await writeFile(path.join(bundle, name), bytes);
        }
        return built;
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  } });
  return jsonOutput({ ...result, familyId: recipe.familyId, variantId: recipe.variantId, elapsedSeconds: Math.round((performance.now() - start) / 10) / 100 });
}
