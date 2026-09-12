#!/usr/bin/env node
// macOS-native, bounded experiment. Never loads a host .env or inherited credentials.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, writeFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = import.meta.dirname;
export const WORK = path.join(ROOT, '.work');
const deadline = performance.now() + 180_000;
export const CONTENT_COMMIT = '8bc4e3fe45532906246a760bff0b06b7cd105c52';
export const samples = [
  'web/html/reference/elements/a',
  'web/css/reference/properties/display',
  'web/javascript/reference/global_objects/array/map',
];
export function environment(work = WORK) {
  return {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
    XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_CONFIG_HOME: path.join(work, 'home/config'),
    DOT_FILE: path.join(work, '.env'),
    npm_config_cache: path.join(work, 'cache/npm'),
    npm_config_userconfig: path.join(work, 'home/user.npmrc'),
    npm_config_globalconfig: path.join(work, 'home/global.npmrc'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8', MDN_EXPERIMENT_CLEAN: '1',
    RAYON_NUM_THREADS: '2', NODE_OPTIONS: '--max-old-space-size=2048',
  };
}
export async function run(label, command, { timeout = 180_000, extra = {}, cwd = WORK } = {}) {
  timeout = Math.min(timeout, deadline - performance.now());
  if (timeout <= 0) throw new Error('Experiment action exceeded its 180-second budget');
  for (const dir of ['home', 'cache', 'tmp', 'logs']) await mkdir(path.join(WORK, dir), { recursive: true });
  // Rari calls dotenv(): an empty local file prevents traversal to a parent's .env.
  await writeFile(path.join(WORK, '.env'), '');
  const log = path.join(WORK, 'logs', `${label}-${Date.now()}.log`);
  const output = await open(log, 'w');
  const start = performance.now();
  let timedOut = false;
  const child = spawn('/usr/bin/time', ['-l', ...command], {
    cwd, env: { ...environment(), ...extra }, stdio: ['ignore', output.fd, output.fd], detached: true,
  });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const interrupt = () => { kill(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await output.close();
  }
  const text = await readFile(log, 'utf8');
  const result = { label, command, wall_seconds: +((performance.now() - start) / 1000).toFixed(3),
    returncode: timedOut ? 124 : (code ?? 1),
    max_rss_bytes: Number(text.match(/(\d+)\s+maximum resident set size/)?.[1]) || null,
    log: path.relative(ROOT, log) };
  await appendFile(path.join(WORK, 'observations.jsonl'), JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result));
  console.log(text.slice(-5000));
  if (result.returncode) throw new Error(`${label} failed (${result.returncode}); see ${log}`);
  return result;
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function downloadSource(file) {
  const target = path.join(WORK, 'content', file);
  if (await exists(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await run('source-' + path.basename(file), ['curl', '-q', '-fSL', '--max-time', '45', '--max-filesize', '5000000',
    `https://raw.githubusercontent.com/mdn/content/${CONTENT_COMMIT}/${file}`, '-o', target + '.partial'], { timeout: 50_000 });
  await rename(target + '.partial', target);
}
async function support() {
  for (const file of ['files/en-us/_redirects.txt', 'files/en-us/web/javascript/reference/index.md',
    'files/en-us/web/css/reference/index.md',
    'files/en-us/web/api/index.md',
    ...[...new Set(samples.flatMap(s => {
      const parts = s.split('/');
      return parts.slice(0, -1).map((_, i) => `files/en-us/${parts.slice(0, i + 1).join('/')}/index.md`);
    }))],
    ...['GroupData', 'InterfaceData', 'L10n-CSS', 'L10n-CSSFormalDefinitions', 'L10n-Common',
      'L10n-JavaScript', 'L10n-SVG', 'L10n-Template', 'SVGData', 'SpecData'].map(n => `files/jsondata/${n}.json`)]) {
    await downloadSource(file);
  }
}
async function setup() {
  await mkdir(WORK, { recursive: true });
  await writeFile(path.join(WORK, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { '@mdn/fred': '2.9.1', '@mdn/rari': '0.2.34' } }));
  await writeFile(path.join(WORK, 'package-lock.json'), await readFile(path.join(ROOT, 'npm-lock.json')));
  if (!await exists(path.join(WORK, 'node_modules/@mdn/fred/out/static/ssr/index.js'))) {
    await run('npm-install', ['npm', 'ci',
      '--ignore-scripts', '--no-audit', '--no-fund']);
  }
  await run('rari-install', [process.execPath, 'node_modules/@mdn/rari/lib/postinstall.js']);
  for (const sample of samples) {
    await downloadSource(`files/en-us/${sample}/index.md`);
  }
  await run('rari-help', [process.execPath, 'node_modules/@mdn/rari/lib/cli.js', '--help']);
}
const rari = path.join(WORK, 'node_modules/@mdn/rari/bin/rari');
export async function main(action) {
  if (action === 'setup') return setup();
  if (action === 'support') return support();
  if (action === 'help') return run('rari-build-help', [rari, 'build', '--help']);
  if (action === 'build' || action === 'build-cached') return run('rari-' + action,
    [rari, ...(action === 'build-cached' ? ['--skip-updates'] : []), 'build', '--no-basic',
      '--issues', path.join(WORK, 'issues.json'), '--json-issues', '--json-live-samples',
      ...samples.map(s => path.join(WORK, 'content/files/en-us', s, 'index.md'))], { extra: {
    CONTENT_ROOT: path.join(WORK, 'content/files'), BUILD_OUT_ROOT: path.join(WORK, 'out'),
  } });
  if (action === 'render') return run('fred-render', [process.execPath, path.join(ROOT, 'render.mjs')]);
  if (action === 'snapshot') return run('snapshot', [process.execPath, path.join(ROOT, 'snapshot.mjs')]);
  throw new Error('Usage: node experiments/mdn/run.mjs setup|support|help|build|build-cached|render|snapshot');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
