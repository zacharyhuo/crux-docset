import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function run(input){const m=await import('../src/spring/build.js').catch(()=>({}));assert.equal(typeof m.buildSpringApi,'function');return m.buildSpringApi(input);}
test('refuses unreviewed source identity and changed build inputs before Gradle execution',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'crux-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'source');await mkdir(sourceRoot);await writeFile(path.join(sourceRoot,'gradle.properties'),'version=7.0.9\n');
  const input={sourceRoot,work:path.join(root,'work'),tools:{jdkHome:path.join(root,'jdk')},version:'7.0.9',commit:'82a6b40b9366ec181ededdad282b307ee5381a52'};
  await assert.rejects(run({...input,commit:'a'.repeat(40)}),/identity|reviewed/i);
  await assert.rejects(run(input));
  await assert.rejects(access(path.join(root,'work/api-result.json')));
});
