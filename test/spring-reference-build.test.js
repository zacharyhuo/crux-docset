import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function run(input){const m=await import('../src/spring/reference-build.js').catch(()=>({}));assert.equal(typeof m.buildSpringReference,'function');return m.buildSpringReference(input);}
test('unreviewed version and changed UI archives never start a reference renderer',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'crux-reference-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const ui=path.join(root,'ui.zip');await writeFile(ui,'not the reviewed UI');
  const input={sourceRoot:root,objectStore:root,work:path.join(root,'work'),tools:{referenceUI:ui,nodeRoot:root},version:'7.0.9',commit:'82a6b40b9366ec181ededdad282b307ee5381a52'};
  await assert.rejects(run({...input,version:'7.0.10'}),/identity|reviewed/i);
  await assert.rejects(run(input),/UI|hash/i);
});
