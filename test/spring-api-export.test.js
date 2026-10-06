import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const commit='82a6b40b9366ec181ededdad282b307ee5381a52';
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'crux-api-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const p of ['java','kotlin','source'])await mkdir(path.join(root,p));
  await writeFile(path.join(root,'java/index.html'),'<main><a href="../kdoc-api/">Kotlin</a><pre>\n\ncode()</pre></main>');
  await writeFile(path.join(root,'kotlin/index.html'),'<main><a href="../javadoc-api/">Java</a></main>');
  await writeFile(path.join(root,'java/style.css'),'main { color: black; }');
  await writeFile(path.join(root,'source/gradle.properties'),'version=7.0.9\n');
  const dir=path.join(root,'source/spring-webmvc/src/main/java/org/springframework/web/servlet/mvc');await mkdir(dir,{recursive:true});
  for(const name of ['Controller.java','AbstractController.java'])await writeFile(path.join(dir,name),await readFile(new URL(`./fixtures/spring-java/${name}`,import.meta.url)));
  return {root,javaRoot:path.join(root,'java'),kotlinRoot:path.join(root,'kotlin'),sourceRoot:path.join(root,'source'),destination:path.join(root,'export'),version:'7.0.9',commit};
}
async function run(args){const m=await import('../src/spring/api-export.js').catch(()=>({}));assert.equal(typeof m.exportSpringApi,'function');return m.exportSpringApi(args);}
test('exports both API trees with cross links and preserves input bytes',async t=>{
  const input=await fixture(t),before=await readFile(path.join(input.javaRoot,'index.html'));
  const result=await run(input);
  assert.equal(result.pages,2);assert.equal(result.resources,1);
  const html=await readFile(path.join(result.documentsRoot,'api/javadoc-api/index.html'),'utf8');
  assert.match(html,/href="\.\.\/kdoc-api\/index.html"/);
  assert.deepEqual(await readFile(path.join(input.javaRoot,'index.html')),before);
  assert.equal(await readFile(path.join(result.documentsRoot,'api/javadoc-api/style.css'),'utf8'),'main { color: black; }');
  assert.equal(result.inputs.length,3);
  await assert.rejects(run(input),/exist/i);
});
test('never accepts a symlink or missing internal target as a successful export',async t=>{
  const input=await fixture(t);await symlink('index.html',path.join(input.javaRoot,'alias.html'));
  await assert.rejects(run(input),/symlink/i);
  await rm(path.join(input.javaRoot,'alias.html'));
  await writeFile(path.join(input.kotlinRoot,'index.html'),'<a href="missing.html">Missing</a>');
  await assert.rejects(run(input),/missing/i);
});
