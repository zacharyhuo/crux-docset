import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';

async function fixture(t,entries){
  const scratch=await mkdtemp(path.join(tmpdir(),'crux-tool-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  const blocks=[];
  for(const {name,content='',type='File',linkpath='',mode=0o755} of entries){
    const data=Buffer.from(content),header=Buffer.alloc(512);
    new Header({path:name,size:data.length,type,mode,linkpath}).encode(header);
    blocks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  const bytes=gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)])),archive=path.join(scratch,'tool.tgz');await writeFile(archive,bytes);
  return {archive,directory:path.join(scratch,'unpacked'),sha256:createHash('sha256').update(bytes).digest('hex'),root:'sdk'};
}
async function unpack(input){const m=await import('../src/spring/tool-archive.js').catch(()=>({}));assert.equal(typeof m.unpackSpringToolArchive,'function');return m.unpackSpringToolArchive(input);}
test('unpacks verified tools and only internal file symlinks into a new owned directory',async t=>{
  const input=await fixture(t,[{name:'sdk/lib/main.js',content:'not executed'},{name:'sdk/bin/npm',type:'SymbolicLink',linkpath:'../lib/main.js'}]);
  const result=await unpack(input);
  assert.equal(await readFile(path.join(result.root,'lib/main.js'),'utf8'),'not executed');
  assert.equal(await readlink(path.join(result.root,'bin/npm')),'../lib/main.js');
  assert.equal(result.files,2);
  await assert.rejects(unpack(input),/exist/i);
});
test('rejects checksum mismatch before producing executable tool files',async t=>{
  const input=await fixture(t,[{name:'sdk/bin/tool',content:'data'}]);
  await assert.rejects(unpack({...input,sha256:'a'.repeat(64)}),/hash/i);
});
test('normalizes the official Temurin directory setgid bit without granting it locally',async t=>{
  const input=await fixture(t,[{name:'sdk/',type:'Directory',mode:0o2755},{name:'sdk/bin/tool',content:'data'}]);
  const result=await unpack(input);
  assert.equal((await lstat(result.root)).mode&0o7000,0);
});
for(const entry of [
  {name:'sdk/../outside'}, {name:'/sdk/absolute'}, {name:'sdk/link',type:'SymbolicLink',linkpath:'../../outside'},
  {name:'sdk/link',type:'SymbolicLink',linkpath:'missing'}, {name:'sdk/pipe',type:'FIFO'},
  {name:'sdk/file'}, {name:'sdk/FILE'}, {name:'sdk/file/child'},
  {name:'sdk/privileged',mode:0o4755},
])test(`rejects unsafe tool entry ${entry.name} ${entry.type??''}`,async t=>{
  const input=await fixture(t,[{name:'sdk/file',content:'original'},entry]);
  await assert.rejects(unpack(input),/unsafe|duplicate|alias|parent|link/i);
});
