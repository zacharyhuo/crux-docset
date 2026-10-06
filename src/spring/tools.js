import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { unpackSpringToolArchive } from './tool-archive.js';
import { downloadSpringAsset } from './download.js';
import lock from '../../tools/spring/toolchain-lock.json' with { type: 'json' };

/** Archives are an optional local content cache, always checked by the same
 * digest as a download. Tool versions/URLs cannot be supplied by recipes. */
export async function acquireSpringBuildTools({ directory, archives = {}, platform = process.platform, arch = process.arch }) {
  if (platform !== lock.platform || arch !== lock.arch) throw new Error('Unqualified Spring execution platform');
  if (!path.isAbsolute(directory) || Object.keys(archives).some(k => !['jdk', 'referenceNode'].includes(k)) ||
      Object.values(archives).some(v => typeof v !== 'string' || !path.isAbsolute(v))) throw new Error('Invalid Spring tool directory/cache');
  await mkdir(directory, { mode: 0o700 });
  const specs = [
    { name: 'jdk', root: lock.jdk.home.split('/')[0], url: lock.jdk.url, sha256: lock.jdk.sha256, maxBytes: lock.jdk.bytes },
    { name: 'referenceNode', root: `node-v${lock.reference.node}-darwin-arm64`, url: lock.reference.nodeURL, sha256: lock.reference.nodeSha256, maxBytes: 128 * 1024 ** 2 },
  ];
  const installed = {};
  for (const spec of specs) {
    const archive = archives[spec.name] ?? path.join(directory, spec.name + '.tgz');
    if (!archives[spec.name]) await downloadSpringAsset({ ...spec, destination: archive });
    installed[spec.name] = await unpackSpringToolArchive({ archive, directory: path.join(directory, spec.name), sha256: spec.sha256, root: spec.root });
  }
  const referenceUI = path.join(directory, 'reference-ui.zip');
  await downloadSpringAsset({ url: lock.reference.uiURL, destination: referenceUI, sha256: lock.reference.uiSha256, maxBytes: lock.reference.uiBytes });
  return { jdkHome: path.join(installed.jdk.root, 'Contents/Home'), nodeRoot: installed.referenceNode.root, referenceUI,
    evidence: { jdk: installed.jdk, referenceNode: installed.referenceNode, uiSha256: lock.reference.uiSha256 } };
}
