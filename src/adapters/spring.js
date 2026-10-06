import path from 'node:path';
import { readFile, writeFile, readdir, cp, realpath } from 'node:fs/promises';
import { recipeIdentity, fingerprint } from '../identity.js';
import { regularPath } from '../build-state.js';
import { acquireSpringSource } from '../spring/source.js';
import { acquireSpringBuildTools } from '../spring/tools.js';
import { buildSpringApi } from '../spring/build.js';
import { buildSpringReference } from '../spring/reference-build.js';
import { exportSpringApi } from '../spring/api-export.js';
import { exportSpringReference } from '../spring/export.js';
import { readJavadocIndex } from '../javadoc/read-index.js';
import { resolveSpringKotlinIndex } from '../spring/kotlin-index.js';
import { createSpringBundleReferencePolicy } from '../spring/bundle-reference-policy.js';
import { writeSpringBundle } from '../spring/bundle.js';
import { packageSpringNotices } from '../spring/notices.js';
import lock from '../../tools/spring/toolchain-lock.json' with { type: 'json' };
import rules from '../spring/bundle-reference-rules.json' with { type: 'json' };

function checkRecipe(recipe) {
  recipeIdentity(recipe);
  if (recipe.familyId !== 'spring-framework' || recipe.identifier !== 'dev.crux.spring-framework' ||
      recipe.bundleName !== 'Spring_Framework' || recipe.name !== 'Spring Framework' || recipe.homepage !== 'index.html' ||
      recipe.versionLine !== '7.0' || recipe.variantId !== 'spring-framework-7-0-en' || recipe.language !== 'en' ||
      recipe.builder?.adapter !== 'spring-framework' || Object.keys(recipe.builder).length !== 1 ||
      recipe.source?.repository !== 'https://github.com/spring-projects/spring-framework' ||
      recipe.source.strategy !== 'reviewed-source-build' || Object.keys(recipe.source).length !== 2) throw new Error('Invalid or unreviewed Spring recipe');
}
const identity = () => ({ repository: 'https://github.com/spring-projects/spring-framework',
  version: lock.spring.version, commit: lock.spring.commit, treeSha256: lock.spring.treeSha256 });
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** Experimental fixed-version adapter. Recipe remains disabled: successful
 * local construction does not qualify redistribution or remote publication.
 * No arbitrary recipe commands, build scripts, caches or tool URLs accepted.
 */
export const springAdapter = Object.freeze({
  acceptsArchive: false,
  inputFiles: ['tools/spring', 'recipes/spring-framework/notices'],
  async resolve(recipe, { directory, archive }) {
    checkRecipe(recipe);
    if (archive) throw new Error('Spring adapter does not accept a local archive');
    if (!path.isAbsolute(directory)) throw new Error('Absolute Spring scratch required');
    return { source: identity(), input: { directory } };
  },
  async build(recipe, snapshot, { candidate }) {
    checkRecipe(recipe);
    if (fingerprint(snapshot.source) !== fingerprint(identity())) throw new Error('Spring snapshot identity changed');
    const { version, commit } = identity();
    let directory = snapshot.input.directory;
    if (!path.isAbsolute(directory) || !path.isAbsolute(candidate)) throw new Error('Absolute Spring build paths required');
    await regularPath(directory, true); await regularPath(candidate, true);
    directory = await realpath(directory); candidate = await realpath(candidate);
    if (overlaps(directory, candidate)) throw new Error('Spring scratch and candidate must be separate');
    let stage = 'source';
    const sourceRoot = path.join(directory, 'upstream/source'), referenceWork = path.join(directory, 'reference-build');
    try {
      const source = await acquireSpringSource({ directory: path.join(directory, 'upstream'), version, commit });
      if (source.treeSha256 !== lock.spring.treeSha256) throw new Error('Spring full source tree lock mismatch');
      stage = 'tools';
      const tools = await acquireSpringBuildTools({ directory: path.join(directory, 'tools') });
      stage = 'api-build';
      const api = await buildSpringApi({ sourceRoot, work: path.join(directory, 'api-build'), tools, version, commit });
      stage = 'reference-build';
      const reference = await buildSpringReference({ sourceRoot, objectStore: path.join(directory, 'upstream/objects.git'), work: referenceWork, tools, version, commit });
      stage = 'export';
      const apiExport = await exportSpringApi({ ...api, sourceRoot, destination: path.join(directory, 'api-export'), version, commit });
      const referenceExport = await exportSpringReference({ sourceRoot, renderedRoot: reference.renderedRoot, destination: path.join(directory, 'reference-export'), version, commit });
      const documentsRoot = path.join(directory, 'Documents');
      await cp(apiExport.documentsRoot, documentsRoot, { recursive: true, force: false, errorOnExist: true });
      for (const name of await readdir(referenceExport.documentsRoot)) await cp(path.join(referenceExport.documentsRoot, name), path.join(documentsRoot, name), { recursive: true, force: false, errorOnExist: true });
      const java = await readJavadocIndex(path.join(documentsRoot, 'api/javadoc-api'));
      const kotlin = resolveSpringKotlinIndex(await readFile(path.join(documentsRoot, 'api/kdoc-api/scripts/pages.json'), 'utf8'));
      const symbols = [...java.symbols.map(s => ({ ...s, path: `api/javadoc-api/${s.path}` })),
        ...kotlin.map(s => ({ ...s, path: `api/kdoc-api/${s.path}` })), ...referenceExport.symbols];
      const sources = new Map();
      for (const file of Object.keys(rules.proofs)) sources.set(file, await readFile(path.join(sourceRoot, file), 'utf8'));
      const referencePolicy = createSpringBundleReferencePolicy({ version, commit, sources });
      stage = 'bundle';
      const result = await writeSpringBundle(recipe, { documentsRoot, symbols, evidence: { version, commit } }, { candidate, version, commit, referencePolicy });
      stage = 'notices';
      const resources = path.join(result.bundle, 'Contents/Resources');
      const notices = await packageSpringNotices({ documents: path.join(resources, 'Documents'), output: path.join(resources, 'spring-assets') });
      await writeFile(path.join(candidate, 'spring-build-evidence.json'), JSON.stringify({ qualification: 'local-build-only-not-release-qualified',
        source, tools: tools.evidence, api: api.evidence, reference: reference.evidence,
        apiExport, referenceExport: referenceExport.evidence, links: result.links, notices }, null, 2), { flag: 'wx' });
      return result;
    } catch (error) {
      // The CLI removes owned scratch on failure. Preserve bounded diagnostics
      // in quarantine first; never copy credentials or arbitrary source files.
      const logs = {};
      for (const [name, file] of Object.entries({ api: path.join(sourceRoot, 'api-build.log'),
        referenceInstall: path.join(referenceWork, 'reference-install.log'), referenceRender: path.join(referenceWork, 'reference-render.log') })) {
        try { const stat = await regularPath(file); if (stat.size <= 8 * 1024 ** 2) logs[name] = await readFile(file, 'utf8'); }
        catch (e) { if (e.code !== 'ENOENT') logs[name] = `Log unavailable: ${e.message}`; }
      }
      await writeFile(path.join(candidate, 'spring-failure.json'), JSON.stringify({ stage, version, commit, message: String(error.message).slice(0, 65536), logs }, null, 2), { flag: 'wx' });
      throw error;
    }
  },
});
