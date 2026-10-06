#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadRecipe, hashBuildInputs } from '../recipes.js';
import { getAdapter } from '../adapters.js';
import { loadRecipeIcons } from '../icons.js';
import { fingerprint } from '../identity.js';
import { readJSON, qualifyCandidate } from './verify.js';
import { GitHubPublication } from './github.js';
import { restorePublication, publishCandidate } from './publisher.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `node src/publication/cli.js restore --repository OWNER/REPO --publication-state EMPTY_DIR
node src/publication/cli.js qualify --candidate DIR --id python [--variant ID]
node src/publication/cli.js publish --repository OWNER/REPO --publication-state DIR --candidate DIR --id python [--variant ID] --source-commit MAIN_SHA
restore reads GitHub; qualify is local-only; publish writes only docset-publication and docset Releases.
GitHub authentication comes from GITHUB_TOKEN supplied to this process, never a client credential.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, repository: { type: 'string' }, 'publication-state': { type: 'string' },
    candidate: { type: 'string' }, id: { type: 'string' }, variant: { type: 'string' }, 'source-commit': { type: 'string' }
  } });
  if (values.help) console.log(help);
  else {
    const [command] = positionals;
    const allowed = { restore: ['repository', 'publication-state'], qualify: ['candidate', 'id', 'variant'],
      publish: ['repository', 'publication-state', 'candidate', 'id', 'variant', 'source-commit'] };
    if (positionals.length !== 1 || !allowed[command] || Object.keys(values).some(key => !allowed[command].includes(key))) throw new Error(help);
    let result;
    if (command === 'restore') {
      if (!values['publication-state']) throw new Error('--publication-state is required');
      result = await restorePublication(path.resolve(values['publication-state']), new GitHubPublication({ repository: values.repository, token: process.env.GITHUB_TOKEN }));
    } else {
      if (!values.candidate || !values.id) throw new Error('--candidate and --id are required');
      const { recipe, recipeDirectory } = await loadRecipe({ root, id: values.id, variantId: values.variant });
      const icons = await loadRecipeIcons(recipeDirectory);
      const policy = await readJSON(path.join(root, 'publication', `${recipe.familyId}.json`));
      const code = await hashBuildInputs(root, ['src', 'package-lock.json', ...getAdapter(recipe.builder.adapter).inputFiles]);
      code.recipeIcons = fingerprint(icons);
      const context = { directory: path.resolve(values.candidate), recipe, icons, policy, builderDigest: fingerprint(code) };
      if (command === 'qualify') result = (await qualifyCandidate(context)).qualification;
      else {
        if (!values['publication-state'] || !process.env.GITHUB_TOKEN) throw new Error('--publication-state and GITHUB_TOKEN are required for publication');
        result = await publishCandidate({ ...context, publication: path.resolve(values['publication-state']), sourceCommit: values['source-commit'],
          github: new GitHubPublication({ repository: values.repository, token: process.env.GITHUB_TOKEN }) });
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
