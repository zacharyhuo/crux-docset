// Read-only inspection of inputs; writes only the experiment evidence file.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, WORK, CONTENT_COMMIT } from './run.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push({ path: path.relative(root, file),
        bytes: (await stat(file)).size, sha256: sha256(await readFile(file)) });
    }
  }
  await walk(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, bytes: files.reduce((n, f) => n + f.bytes, 0), tree_sha256: sha256(JSON.stringify(files)) };
}
const sources = await inventory(path.join(WORK, 'content'));
const dependencies = await inventory(path.join(WORK, 'home/Library/Application Support/rari'));
const observations = (await readFile(path.join(WORK, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const evidence = {
  generated_at: new Date().toISOString(), host: { platform: process.platform, arch: process.arch,
    release: os.release(), node: process.version, cpu: os.cpus()[0].model, logical_cpus: os.cpus().length },
  pins: { content: CONTENT_COMMIT, fred: { version: '2.9.1', npm_gitHead: 'a010ecbfec855c938d43ee1645e1d058d4c1fa0b',
    inspected_main: '1bd8b8ade2b798f89eca9995d71a261178a06e24' },
  rari: { version: '0.2.34', tag_commit: 'bfcea4b1e7d9df04fd35c05d3540490558154cc2',
    inspected_main: '4e521dbb8ccd463376e6a793d3dcefc02de6c735' } },
  npm_lock_sha256: sha256(await readFile(path.join(ROOT, 'npm-lock.json'))),
  rari_binary_sha256: sha256(await readFile(path.join(WORK, 'node_modules/@mdn/rari/bin/rari'))),
  sources, rari_data: dependencies,
  observations: observations.filter(o => /^(npm-install|rari-build|fred-render)/.test(o.label))
    .map(o => ({ ...o, command: o.command.map(s => s.replaceAll(WORK, '$WORK').replaceAll(ROOT, '$EXPERIMENT')) })),
  render: JSON.parse(await readFile(path.join(WORK, 'render-results.json'))),
};
await writeFile(path.join(WORK, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ source_files: sources.files.length, source_bytes: sources.bytes,
  data_files: dependencies.files.length, data_bytes: dependencies.bytes }));
