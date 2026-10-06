import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex');
async function run(input){const m=await import('../src/spring/download.js').catch(()=>({}));assert.equal(typeof m.downloadSpringAsset,'function');return m.downloadSpringAsset(input);}
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'crux-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {url:'https://nodejs.org/dist/v20.16.0/node-v20.16.0-darwin-arm64.tar.gz',destination:path.join(dir,'asset'),sha256:digest('content'),maxBytes:20,fetcher:async()=>new Response('content')};}
test('download verifies the actual bytes and never overwrites an existing artifact',async t=>{
  const input=await fixture(t);await run(input);assert.equal(await readFile(input.destination,'utf8'),'content');
  await assert.rejects(run(input),/exist/i);
});
test('rejects changed data, oversized streams and redirects outside approved public hosts',async t=>{
  for(const [name,change] of Object.entries({hash:{sha256:'a'.repeat(64)},size:{maxBytes:3},redirect:{fetcher:async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}})},status:{fetcher:async()=>new Response('no',{status:500})}})){
    const input=await fixture(t);input.destination+='-'+name;await assert.rejects(run({...input,...change}),/hash|limit|URL|HTTP/i);
  }
});
