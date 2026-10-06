import { createHash } from 'node:crypto';

export const springBuildInputPaths = Object.freeze([
  'gradle.properties', 'gradle/wrapper/gradle-wrapper.properties', 'gradle/wrapper/gradle-wrapper.jar',
  'build.gradle', 'settings.gradle', 'buildSrc/build.gradle',
]);
const wrapper = 'gradle/wrapper/gradle-wrapper.properties';
const sha = b => createHash('sha256').update(b).digest('hex');
const validHash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);

/** Verify bounded bytes against an independently reviewed repository baseline.
 * The caller supplies authenticated commit identity; this pure check does not
 * authenticate Git, acquire source, execute Gradle, or qualify an entire tree.
 * Never accept a baseline delivered by an untrusted source archive.
 */
export function verifySpringBuildInputs({ files, baseline, version, commit, mode }) {
  if (!['upstream', 'prepared'].includes(mode)) throw new Error('Explicit upstream/prepared mode required');
  if (baseline?.schemaVersion !== 1 || baseline.status !== 'partial-baseline-not-release-qualified' ||
      baseline.repository !== 'https://github.com/spring-projects/spring-framework' ||
      !/^\d+\.\d+\.\d+$/.test(baseline.version) || !/^[a-f0-9]{40}$/.test(baseline.commit) ||
      !baseline.files || Object.keys(baseline.files).length !== springBuildInputPaths.length ||
      springBuildInputPaths.some(p => !validHash(baseline.files[p]))) throw new Error('Invalid Spring build input baseline');
  if (version !== baseline.version || commit !== baseline.commit) throw new Error('Spring source identity mismatch');
  const distribution = baseline.gradleDistribution;
  if (!distribution || !/^\d+\.\d+\.\d+$/.test(distribution.version) || !validHash(distribution.sha256) ||
      distribution.url !== `https://services.gradle.org/distributions/gradle-${distribution.version}-bin.zip`) throw new Error('Invalid pinned Gradle distribution');
  const overrides = baseline.localBuildOverrides;
  if (!Array.isArray(overrides) || overrides.length !== 1 || overrides[0].path !== wrapper || !validHash(overrides[0].sha256)) throw new Error('Invalid wrapper override baseline');
  if (!(files instanceof Map)) throw new Error('Input files must be a Map of bounded buffers');
  for (const p of files.keys()) if (!springBuildInputPaths.includes(p)) throw new Error(`Unexpected build input: ${p}`);
  const hashes = {};
  for (const p of springBuildInputPaths) {
    const bytes = files.get(p);
    if (!bytes) throw new Error(`Missing build input: ${p}`);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) throw new Error(`Invalid or oversized build input: ${p}`);
    hashes[p] = sha(bytes);
    const expected = mode === 'prepared' && p === wrapper ? overrides[0].sha256 : baseline.files[p];
    if (hashes[p] !== expected) throw new Error(`Build input checksum mismatch: ${p}`);
  }
  // Exact bytes are pinned above. Cross-check key metadata so an erroneous
  // reviewed baseline cannot silently pair another version/distribution.
  const property = (file, key) => {
    const rows = new TextDecoder('utf-8', { fatal: true }).decode(files.get(file)).split(/\r?\n/)
      .filter(line => line.startsWith(key + '='));
    if (rows.length !== 1) throw new Error(`Missing or duplicate build property: ${key}`);
    return rows[0].slice(key.length + 1).replaceAll('\\:', ':');
  };
  if (property('gradle.properties', 'version') !== version) throw new Error('Source version property mismatch');
  if (property(wrapper, 'distributionUrl') !== distribution.url) throw new Error('Gradle distribution property mismatch');
  if (mode === 'prepared' && property(wrapper, 'distributionSha256Sum') !== distribution.sha256) throw new Error('Gradle distribution checksum property mismatch');
  return { schemaVersion: 1, scope: 'spring-build-inputs-only', version, commit, mode,
    fileCount: springBuildInputPaths.length, hashes, releaseQualified: false,
    digest: sha(JSON.stringify({ version, commit, mode, hashes, distribution })) };
}
