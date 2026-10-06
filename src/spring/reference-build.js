import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { regularPath } from '../build-state.js';
import { inspectSpringNpmLock } from './npm-lock.js';
import { runSpringCommand } from './process.js';
import lock from '../../tools/spring/toolchain-lock.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../tools/spring/reference/', import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');

export async function buildSpringReference({ sourceRoot, objectStore, work, tools, version, commit }) {
  if (version !== lock.spring.version || commit !== lock.spring.commit) throw new Error('Unreviewed Spring reference identity');
  for (const value of [sourceRoot, objectStore, work, tools?.nodeRoot, tools?.referenceUI]) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Absolute Spring reference paths required');
  if ((await regularPath(tools.referenceUI)).size !== lock.reference.uiBytes) throw new Error('Spring UI archive size mismatch');
  const ui = await readFile(tools.referenceUI);
  if (hash(ui) !== lock.reference.uiSha256) throw new Error('Spring UI archive hash mismatch');
  const packageLock = await readFile(path.join(root, 'package-lock.json'));
  if (hash(packageLock) !== lock.reference.packageLockSha256) throw new Error('Spring reference lock changed');
  inspectSpringNpmLock(JSON.parse(packageLock));
  await mkdir(work, { mode: 0o700 });
  for (const name of ['home', 'tmp']) await mkdir(path.join(work, name));
  for (const name of ['npm-user.conf', 'npm-global.conf']) await writeFile(path.join(work, name), '', { flag: 'wx' });
  for (const name of ['package.json', 'version-resource.cjs']) await writeFile(path.join(work, name), await readFile(path.join(root, name)), { flag: 'wx' });
  await writeFile(path.join(work, 'package-lock.json'), packageLock, { flag: 'wx' });
  await writeFile(path.join(work, 'ui-bundle.zip'), ui, { flag: 'wx' });
  await writeFile(path.join(work, 'build-input.json'), JSON.stringify({ sourceRoot, version, commit }), { flag: 'wx' });
  const playbook = {
    antora: { extensions: [{ require: './version-resource.cjs' }, { require: '@springio/antora-extensions/override-navigation-builder-extension' }] },
    site: { title: `Spring Framework ${version}`, start_page: 'framework::index.adoc' },
    content: { sources: [{ url: objectStore, branches: [], tags: [], commits: [commit], worktrees: false, start_path: 'framework-docs' }] },
    asciidoc: { extensions: ['@asciidoctor/tabs', '@springio/asciidoctor-extensions', '@springio/asciidoctor-extensions/include-code-extension'],
      attributes: { 'page-pagination': '', 'hide-uri-scheme': '@', 'tabs-sync-option': '@' } },
    runtime: { fetch: false, cache_dir: './antora-cache', log: { failure_level: 'warn', level: 'warn', format: 'json' } },
    ui: { bundle: { url: './ui-bundle.zip' } }, output: { dir: './site' },
  };
  await writeFile(path.join(work, 'playbook.yml'), JSON.stringify(playbook, null, 2), { flag: 'wx' });
  const node = path.join(tools.nodeRoot, 'bin/node');
  const env = { PATH: `${tools.nodeRoot}/bin:/usr/bin:/bin`, HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'), LANG: 'C',
    NPM_CONFIG_USERCONFIG: path.join(work, 'npm-user.conf'), NPM_CONFIG_GLOBALCONFIG: path.join(work, 'npm-global.conf') };
  await runSpringCommand({ command: node, args: [path.join(tools.nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(work, 'npm-cache')], cwd: work, env, stage: 'reference-install', timeoutMs: 180000 });
  const result = await runSpringCommand({ command: node, args: ['--max-old-space-size=1536', path.join(work, 'node_modules/@antora/cli/bin/antora'), path.join(work, 'playbook.yml')], cwd: work, env, stage: 'reference-render', timeoutMs: 180000 });
  const renderedRoot = path.join(work, 'site/framework', version);
  await regularPath(path.join(renderedRoot, 'index.html'));
  if (hash(await readFile(path.join(work, 'package-lock.json'))) !== lock.reference.packageLockSha256) throw new Error('Reference lock mutated');
  const source = JSON.parse(await readFile(path.join(work, 'reference-input-evidence.json')));
  if (source.version !== version || source.commit !== commit) throw new Error('Rendered Spring reference identity mismatch');
  return { renderedRoot, evidence: { result, source, packageLockSha256: lock.reference.packageLockSha256 } };
}
