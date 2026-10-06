import test from 'node:test';
import assert from 'node:assert/strict';

const lock=()=>({lockfileVersion:3,packages:{'':{name:'renderer'},'node_modules/a':{version:'1.2.3',resolved:'https://registry.npmjs.org/a/-/a-1.2.3.tgz',integrity:'sha512-'+Buffer.alloc(64,1).toString('base64')}}});
async function inspect(value){const m=await import('../src/spring/npm-lock.js').catch(()=>({}));assert.equal(typeof m.inspectSpringNpmLock,'function');return m.inspectSpringNpmLock(value);}
test('requires registry archive and integrity for every transitive npm package',async()=>{
  assert.equal((await inspect(lock())).packages,1);
  for(const mutate of [x=>delete x.packages['node_modules/a'].integrity,x=>delete x.packages['node_modules/a'].resolved,
    x=>x.packages['node_modules/a'].resolved='http://registry.npmjs.org/a.tgz',
    x=>x.packages['node_modules/a'].integrity='sha512-short',
    x=>x.packages['node_modules/a'].version='latest',
    x=>x.packages['node_modules/a'].link=true]){
    const input=lock();mutate(input);await assert.rejects(inspect(input),/lock/i);
  }
});
