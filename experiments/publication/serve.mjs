import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GitHubFixture } from '../../test/helpers/publication.js';
import { GitHubPublication } from '../../src/publication/github.js';
import { restorePublication, publishCandidate } from '../../src/publication/publisher.js';
import { loadRecipe, hashBuildInputs } from '../../src/recipes.js';
import { loadRecipeIcons } from '../../src/icons.js';
import { fingerprint } from '../../src/identity.js';
import { getAdapter } from '../../src/adapters.js';
import { serveAcceptance } from './https-fixture.mjs';

// Real official archives + real publisher, backed by an in-process GitHub fixture.
// HTTPS is an actual loopback TLS server; its one-day CA is scoped to the test
// session. No Keychain, system trust, production app or real GitHub writes.
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { work: { type: 'string' } } });
if (!values.work || !path.isAbsolute(values.work)) throw new Error('--work requires an absolute experiment parent');
await mkdir(values.work, { recursive: true });
const work = await mkdtemp(path.join(values.work, 'python-https-'));
console.log(`EXPERIMENT ${work}`);
const remote = new GitHubFixture();
const github = new GitHubPublication({ repository: remote.repository, token: 'fixture-token', fetcher: remote.fetch });
const publication = path.join(work, 'publication');
await restorePublication(publication, github);
for (const variantId of ['python-3-14-en', 'python-3-13-en']) {
  const { stdout, stderr } = await execute(process.execPath, ['src/cli.js', 'build', '--id', 'python', '--variant', variantId,
    '--work', path.join(work, variantId), '--publication-state', publication], { cwd: root, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(work, `${variantId}-build.log`), stdout + stderr);
  const result = JSON.parse(stdout);
  const { recipe, recipeDirectory } = await loadRecipe({ root, id: 'python', variantId });
  const icons = await loadRecipeIcons(recipeDirectory);
  const code = await hashBuildInputs(root, ['src', 'package-lock.json', ...getAdapter(recipe.builder.adapter).inputFiles]);
  code.recipeIcons = fingerprint(icons);
  const policy = JSON.parse(await readFile(path.join(root, 'publication/python.json')));
  const published = await publishCandidate({ directory: result.directory, publication, recipe, icons, policy, builderDigest: fingerprint(code), sourceCommit: 'c'.repeat(40), github });
  console.log(`QUALIFIED ${variantId} ${published.releaseId}`);
}
const state = remote.state();
await writeFile(path.join(work, 'fixture-github-state.json'), JSON.stringify(state, null, 2));
const releases = state.catalog.families[0].releases;
const archives = new Map();
for (const release of releases) {
  const tag = new URL(release.artifact.url).pathname.split('/').at(-2);
  const entry = remote.releases.find(r => r.tag_name === tag).assets.find(a => a.name === 'Python.tgz');
  archives.set(release.releaseId, remote.assets.get(entry.id).bytes);
}
await serveAcceptance(work, state.catalog, archives);
