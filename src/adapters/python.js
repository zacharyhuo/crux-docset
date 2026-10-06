import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { download, buildPython } from '../python.js';
import { discoverPython } from '../pipeline.js';
import { sha256, assertVersionLine } from '../identity.js';
import { regularPath } from '../build-state.js';

export const pythonAdapter = Object.freeze({
  acceptsArchive: true,
  inputFiles: ['tools/doc2dash/uv.lock', 'tools/doc2dash/pyproject.toml', 'publication/python.json'],
  async resolve(recipe, { directory, archive, fetcher = fetch }) {
    let url = 'local-archive';
    if (!archive) {
      const discovery = path.join(directory, 'discovery.html');
      await download(recipe.source.discoveryUrl, discovery, { maxBytes: 2 * 1024 * 1024, fetcher });
      url = discoverPython(await readFile(discovery, 'utf8'), recipe.source.discoveryUrl);
      const version = new URL(url).pathname.match(/python-([\d.]+)-docs-html\.zip$/)?.[1];
      assertVersionLine(version, recipe);
      archive = path.join(directory, 'source.zip');
      await download(url, archive, { fetcher });
    }
    await regularPath(archive);
    return { source: { url, sha256: await sha256(archive) }, input: { archive } };
  },
  build(recipe, snapshot, { candidate, icons }) {
    return buildPython(candidate, recipe, snapshot.input.archive, icons);
  }
});
