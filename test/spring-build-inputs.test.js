import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = b => createHash('sha256').update(b).digest('hex');
const commit = 'a'.repeat(40);
function fixture() {
  const properties = 'version=7.0.9\n';
  const wrapper = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.0-bin.zip\n';
  const checksum = 'b'.repeat(64);
  const prepared = wrapper + `distributionSha256Sum=${checksum}\n`;
  const files = new Map([
    ['gradle.properties', Buffer.from(properties)], ['gradle/wrapper/gradle-wrapper.properties', Buffer.from(wrapper)],
    ['gradle/wrapper/gradle-wrapper.jar', Buffer.from('jar')], ['build.gradle', Buffer.from('build')],
    ['settings.gradle', Buffer.from('settings')], ['buildSrc/build.gradle', Buffer.from('buildSrc')],
  ]);
  const baseline = { schemaVersion: 1, status: 'partial-baseline-not-release-qualified',
    repository: 'https://github.com/spring-projects/spring-framework', version: '7.0.9', commit,
    files: Object.fromEntries([...files].map(([p,b]) => [p,hash(b)])),
    localBuildOverrides: [{ path: 'gradle/wrapper/gradle-wrapper.properties', sha256: hash(prepared) }],
    gradleDistribution: { version: '9.7.0', url: 'https://services.gradle.org/distributions/gradle-9.7.0-bin.zip', sha256: checksum } };
  return { files, baseline, prepared };
}
async function check(input) {
  const module = await import('../src/spring/build-inputs.js').catch(() => ({}));
  assert.equal(typeof module.verifySpringBuildInputs, 'function', 'build input verifier exists');
  return module.verifySpringBuildInputs(input);
}
test('verifies upstream and explicit prepared inputs without granting release qualification', async () => {
  const f = fixture();
  const result = await check({ ...f, version:'7.0.9', commit, mode:'upstream' });
  assert.equal(result.fileCount,6); assert.equal(result.releaseQualified,false);
  f.files.set('gradle/wrapper/gradle-wrapper.properties',Buffer.from(f.prepared));
  const prepared = await check({ ...f, version:'7.0.9', commit, mode:'prepared' });
  assert.notEqual(result.digest,prepared.digest);
});
for (const [name, mutate, pattern] of [
  ['changed source', f=>f.files.set('build.gradle',Buffer.from('changed')), /checksum/],
  ['missing input', f=>f.files.delete('settings.gradle'), /missing/i],
  ['unexpected input', f=>f.files.set('other',Buffer.from('x')), /unexpected/i],
  ['wrong commit', f=>f.commit='c'.repeat(40), /identity/],
  ['wrong version', f=>f.version='7.0.10', /identity/],
  ['implicit override', f=>f.files.set('gradle/wrapper/gradle-wrapper.properties',Buffer.from(f.prepared)), /checksum/],
  ['unknown mode', f=>f.mode='anything', /mode/],
  ['missing baseline pin', f=>delete f.baseline.files['build.gradle'], /baseline/],
  ['unsafe distribution', f=>f.baseline.gradleDistribution.url='https://evil.invalid/gradle.zip', /distribution/],
  ['oversized input', f=>f.files.set('build.gradle',Buffer.alloc(1024*1024+1)), /oversized/],
  ['baseline version disagrees with source', f=>{ f.baseline.version='7.0.10';f.version='7.0.10'; }, /version property/],
  ['baseline distribution disagrees with source', f=>{ f.baseline.gradleDistribution.version='9.8.0';f.baseline.gradleDistribution.url='https://services.gradle.org/distributions/gradle-9.8.0-bin.zip'; }, /distribution property/],
]) test(`rejects ${name}`, async()=>{
  const f={...fixture(),version:'7.0.9',commit,mode:'upstream'};mutate(f);
  await assert.rejects(check(f),pattern);
});
