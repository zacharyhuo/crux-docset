import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifySpringBuildInputs, springBuildInputPaths } from './build-inputs.js';
import { inspectSpringDependencyLock } from './dependency-lock.js';
import { runSpringCommand } from './process.js';
import { regularPath } from '../build-state.js';
import baseline from '../../tools/spring/build-inputs-baseline.json' with { type: 'json' };
import lock from '../../tools/spring/toolchain-lock.json' with { type: 'json' };

const toolRoot = fileURLToPath(new URL('../../tools/spring/', import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');
async function bounded(file, maximum = 8 * 1024 ** 2) {
  if ((await regularPath(file)).size > maximum) throw new Error('Spring build input size limit');
  return readFile(file);
}

/** Build only the two reviewed API targets in a new isolated work directory.
 * The caller must obtain sourceRoot from the authenticated source materializer.
 */
export async function buildSpringApi({ sourceRoot, work, tools, version, commit }) {
  if (version !== lock.spring.version || commit !== lock.spring.commit) throw new Error('Unreviewed Spring source identity');
  for (const value of [sourceRoot, work, tools?.jdkHome]) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Absolute Spring build paths required');
  const files = new Map();
  for (const file of springBuildInputPaths) files.set(file, await bounded(path.join(sourceRoot, file), 1024 ** 2));
  verifySpringBuildInputs({ files, baseline, version, commit, mode: 'upstream' });
  const wrapper = 'gradle/wrapper/gradle-wrapper.properties';
  files.set(wrapper, Buffer.from(files.get(wrapper).toString().replace('networkTimeout=', `distributionSha256Sum=${baseline.gradleDistribution.sha256}\nnetworkTimeout=`)));
  verifySpringBuildInputs({ files, baseline, version, commit, mode: 'prepared' });
  const xml = await bounded(path.join(toolRoot, lock.gradle.verificationMetadata));
  const dependencyLock = inspectSpringDependencyLock(xml.toString('utf8'));
  if (dependencyLock.sha256 !== lock.gradle.verificationSha256 || dependencyLock.artifacts.length !== lock.gradle.artifacts) throw new Error('Spring dependency lock changed');
  await mkdir(work, { mode: 0o700 });
  for (const name of ['home', 'tmp', 'gradle-home', 'external-metadata']) await mkdir(path.join(work, name));
  const metadataBytes = await bounded(path.join(toolRoot, lock.externalMetadata));
  const metadata = JSON.parse(metadataBytes);
  for (const entry of metadata.records) {
    if (!/^\d{2}\/(element-list|package-list)$/.test(entry.file)) throw new Error('Invalid Spring metadata path');
    const input = await bounded(path.join(toolRoot, 'external-metadata', entry.file), 1024 ** 2);
    if (input.length !== entry.bytes || hash(input) !== entry.sha256) throw new Error('Spring metadata hash mismatch');
    const output = path.join(work, 'external-metadata', entry.file); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, input, { flag: 'wx' });
  }
  await writeFile(path.join(work, 'external-metadata/manifest.json'), metadataBytes, { flag: 'wx' });
  await writeFile(path.join(sourceRoot, wrapper), files.get(wrapper));
  await writeFile(path.join(sourceRoot, 'gradle/verification-metadata.xml'), xml, { flag: 'wx' });
  const env = { PATH: `${tools.jdkHome}/bin:/usr/bin:/bin`, JAVA_HOME: tools.jdkHome, HOME: path.join(work, 'home'),
    TMPDIR: path.join(work, 'tmp'), GRADLE_USER_HOME: path.join(work, 'gradle-home'), LANG: 'C', CI: 'true' };
  const args = [path.join(sourceRoot, 'gradlew'), ':framework-api:javadoc', ':framework-api:dokkaGenerate',
    '-I', path.join(toolRoot, 'build.init.gradle'), '--dependency-verification', 'strict', '--no-scan', '--no-daemon',
    '--no-build-cache', '--no-configuration-cache', '--no-parallel', '--no-watch-fs', '--max-workers=2', '--console=plain',
    `-Dcrux.spring.work=${work}`, `-Duser.home=${env.HOME}`, '-Dorg.gradle.jvmargs=-Xmx1536m',
    '-Pkotlin.compiler.execution.strategy=out-of-process', '-Dorg.gradle.java.installations.auto-download=false',
    '-Dorg.gradle.java.installations.auto-detect=false', `-Dorg.gradle.java.installations.paths=${tools.jdkHome}`];
  const result = await runSpringCommand({ command: '/bin/sh', args, cwd: sourceRoot, env, stage: 'api-build' });
  if (hash(await bounded(path.join(sourceRoot, 'gradle/verification-metadata.xml'))) !== dependencyLock.sha256) throw new Error('Spring dependency lock mutated during build');
  const javaRoot = path.join(sourceRoot, 'framework-api/build/docs/javadoc-api'), kotlinRoot = path.join(work, 'kdoc-api');
  await regularPath(path.join(javaRoot, 'index.html')); await regularPath(path.join(kotlinRoot, 'index.html'));
  for (const [file, expected] of Object.entries(lock.dokka.verifiedOutputs)) {
    const folder = file.startsWith('ui-kit.') ? 'ui-kit' : file.endsWith('.js') ? 'scripts' : 'styles';
    if (hash(await bounded(path.join(kotlinRoot, folder, file))) !== expected) throw new Error(`Dokka generated asset changed: ${file}`);
  }
  return { javaRoot, kotlinRoot, evidence: { version, commit, dependencyLockSha256: dependencyLock.sha256, result } };
}
