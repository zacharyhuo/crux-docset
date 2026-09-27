import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { recipeIdentity, assertVersionLine, fingerprint } from '../identity.js';
import { regularPath } from '../build-state.js';
import { resolveGoSource, acquireGoInputs } from '../go/source.js';
import { buildPkgsite, scanGoSources, withPkgsite } from '../go/runtime.js';
import { makeGoInventory, readGoDirectory } from '../go/inventory.js';
import { exportGoDocs } from '../go/export.js';
import { writeGoBundle } from '../go/bundle.js';

function checkRecipe(recipe) {
  recipeIdentity(recipe);
  if (recipe.familyId !== 'go' || recipe.identifier !== 'dev.crux.go' || recipe.bundleName !== 'Go' || recipe.homepage !== 'index.html' ||
      !/^1\.\d+$/.test(recipe.versionLine) || recipe.variantId !== `go-${recipe.versionLine.replace('.', '-')}-en` ||
      recipe.builder?.adapter !== 'go-pkgsite' || Object.keys(recipe.builder).some(k => k !== 'adapter') ||
      recipe.source?.discoveryUrl !== 'https://go.dev/dl/?mode=json&include=all' || recipe.source.strategy !== 'stable-line-official-sdk' ||
      Object.keys(recipe.source).some(k => !['discoveryUrl', 'strategy'].includes(k))) throw new Error('Invalid Go recipe identity/configuration');
}
const sourceIdentity = lock => ({ url: lock.archive.url, sha256: lock.archive.sha256, version: lock.version, lock });

export const goAdapter = Object.freeze({
  acceptsArchive: false,
  inputFiles: ['tools/pkgsite/toolchain-lock.json'],
  async resolve(recipe, { directory, archive, fetcher = fetch }) {
    checkRecipe(recipe);
    if (archive) throw new Error('Go adapter does not accept a local archive');
    if (!path.isAbsolute(directory)) throw new Error('Go source scratch must be absolute');
    // Resolve metadata before acquisition: unchanged inputs need no SDK/compiler work.
    const lock = await resolveGoSource(recipe, { fetcher });
    return { source: sourceIdentity(lock), input: { lock, directory } };
  },
  async build(recipe, snapshot, { candidate }) {
    checkRecipe(recipe);
    const { lock, directory } = snapshot.input;
    assertVersionLine(lock.version, recipe);
    if (fingerprint(sourceIdentity(lock)) !== fingerprint(snapshot.source)) throw new Error('Go source snapshot identity changed');
    if (!path.isAbsolute(candidate) || !path.isAbsolute(directory) || candidate === directory || candidate.startsWith(directory + path.sep) || directory.startsWith(candidate + path.sep)) throw new Error('Go source and candidate work must be separate');
    await regularPath(candidate, true); await regularPath(directory, true);
    let stage = 'acquire';
    try {
      // All large SDK/tool caches live in the CLI-owned disposable source directory.
      const inputs = await acquireGoInputs(lock, { directory: path.join(directory, 'sdk-input') });
      stage = 'renderer';
      const rendererWork = path.join(directory, 'renderer');
      const built = await buildPkgsite(inputs, { work: rendererWork });
      stage = 'inventory';
      const sources = await scanGoSources(inputs, { work: path.join(directory, 'inventory') });
      const moduleDirectory = path.join(rendererWork, 'gopath/pkg/mod', `${lock.renderer.module}@${lock.renderer.version}`);
      const licenses = { go: await readFile(path.join(inputs.goroot, 'LICENSE'), 'utf8'), pkgsite: await readFile(path.join(moduleDirectory, 'LICENSE'), 'utf8') };
      let inventory;
      stage = 'export';
      const exported = await withPkgsite(built, { work: path.join(directory, 'runtime') }, async session => {
        const renderedPackages = readGoDirectory(await session.readPage(`/std@go${lock.version}`), { version: lock.version });
        inventory = makeGoInventory({ version: lock.version, sourcePackages: sources.packages, renderedPackages, contexts: sources.contexts });
        return exportGoDocs(session, inventory, { destination: path.join(directory, 'export'), sourceLock: inputs.sourceLock, goroot: inputs.goroot, licenses });
      });
      stage = 'bundle';
      const result = await writeGoBundle(recipe, exported, { candidate, version: lock.version });
      const { binary: _localBinary, ...renderer } = built.pkgsite;
      await writeFile(path.join(candidate, 'go-build-evidence.json'), JSON.stringify({ sourceLock: inputs.sourceLock, renderer,
        sourceInventory: sources, inventory, export: exported.evidence }, null, 2), { flag: 'wx' });
      return result;
    } catch (error) {
      const diagnostic = { stage, version: lock.version, message: String(error.message).slice(0, 65536) };
      const log = path.join(directory, 'runtime/server.log');
      try {
        const stat = await regularPath(log);
        if (stat.size <= 1024 ** 2) diagnostic.runtimeLog = await readFile(log, 'utf8');
      } catch (readError) { if (readError.code !== 'ENOENT') diagnostic.logError = String(readError.message); }
      await writeFile(path.join(candidate, 'go-failure.json'), JSON.stringify(diagnostic, null, 2), { flag: 'wx' });
      throw error;
    }
  },
});
