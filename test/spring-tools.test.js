import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function run(input){const m=await import('../src/spring/tools.js').catch(()=>({}));assert.equal(typeof m.acquireSpringBuildTools,'function');return m.acquireSpringBuildTools(input);}
test('unqualified platforms cannot provision or execute Spring tools',async()=>{
  await assert.rejects(run({directory:'/not-created',platform:'linux',arch:'arm64'}),/platform/i);
});
test('a local tool cache is reverified against the repository lock, not trusted by filename',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'crux-toolset-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const archive=path.join(root,'jdk.tgz');await writeFile(archive,'wrong bytes');
  await assert.rejects(run({directory:path.join(root,'tools'),archives:{jdk:archive},platform:'darwin',arch:'arm64'}),/hash/i);
});
