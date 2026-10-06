import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditAssets } from '../src/asset-audit.js';
const api = await import('../src/spring/notices.js').catch(e => { if(e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });
const sha = text => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spring-notices-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const documents=path.join(root,'Documents'), output=path.join(root,'audit');
  await mkdir(documents);
  const files={'index.html':'<h1>Spring</h1>', 'licenses/SPRING-LICENSE.txt':'Spring license',
    'licenses/UPSTREAM-NOTICES.txt':'Spring attribution', 'NOTICES.txt':'Crux modifications',
    'api/javadoc-api/legal/LICENSE':'JDK license', 'api/javadoc-api/legal/ADDITIONAL_LICENSE_INFO':'JDK exception',
    'api/javadoc-api/legal/ASSEMBLY_EXCEPTION':'JDK assembly', 'api/javadoc-api/legal/jquery.md':'jQuery license',
    'api/javadoc-api/legal/jqueryUI.md':'jQuery UI license', 'api/javadoc-api/legal/dejavufonts.md':'Font license',
    'api/kdoc-api/scripts/main.js':'/* fixture bundle */'};
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(documents,file)),{recursive:true});await writeFile(path.join(documents,file),text);}
  const catalog={schemaVersion:1,components:[{name:'fixture',version:'1.0',declaredLicense:'MIT',archive:'https://registry.npmjs.org/fixture/-/fixture-1.0.tgz',notices:[{sha256:sha('License\r\n') }]}],notices:[{sha256:sha('License\r\n'),text:'License\r\n'}],fonts:[]};
  const rules={schemaVersion:1,version:'7.0.9',sourceCommit:'82a6b40b9366ec181ededdad282b307ee5381a52',
    htmlGroups:{root:{count:1,pathsSha256:sha(JSON.stringify(['index.html']))}},
    staticFiles:Object.entries(files).filter(([f])=>!f.endsWith('.html')).map(([file,text])=>({path:file,sha256:sha(text),components:file.endsWith('main.js')?['fixture@1.0']:['spring']})),
    notices:['DOKKA-LICENSE.txt','DOKKA-NOTICE.txt','PRISM-LICENSE.txt'].map(p=>({path:p,text:p,sha256:sha(p)}))};
  return {root,documents,output,catalog,rules};
}

test('packs exact license bytes, attributes every file and never self-approves release',async t=>{
  assert.equal(typeof api.packageSpringNoticeEvidence,'function','notice packager is available');
  const f=await fixture(t), result=await api.packageSpringNoticeEvidence(f);
  assert.equal(result.integrityPassed,true); assert.equal(result.releaseQualified,false);
  assert.equal(await readFile(path.join(f.documents,`licenses/crux-third-party/${sha('License\r\n')}.txt`),'utf8'),'License\r\n');
  const manifest=JSON.parse(await readFile(path.join(f.output,'manifest.json')));
  assert.ok(manifest.files.some(x=>x.path==='index.html'&&x.components.includes('crux-adaptations')));
  assert.ok(manifest.components.every(x=>x.reviewed===false));
  const report=await auditAssets(f.documents,path.join(f.output,'manifest.json'));
  assert.equal(report.passed,false);
  assert.ok(report.errors.every(x=>x.startsWith('Component requires review:')));
  await writeFile(path.join(f.documents,'api/kdoc-api/scripts/main.js'),'tampered');
  const changed=await auditAssets(f.documents,path.join(f.output,'manifest.json'));
  assert.ok(changed.errors.some(x=>x.includes('checksum mismatch')));
});

for(const kind of ['notice-text','missing-reference','unknown-owner','resource-drift','missing-resource','extra-resource','extra-html','symlink','existing-output','overlap'])
test(`rejects ${kind} without writing license output`,async t=>{
  assert.equal(typeof api.packageSpringNoticeEvidence,'function','notice packager is available');
  const f=await fixture(t);
  if(kind==='notice-text') f.catalog.notices[0].text='changed';
  if(kind==='missing-reference') f.catalog.components[0].notices[0].sha256='0'.repeat(64);
  if(kind==='unknown-owner') f.rules.staticFiles[0].components=['unknown'];
  if(kind==='resource-drift') await writeFile(path.join(f.documents,'api/kdoc-api/scripts/main.js'),'changed');
  if(kind==='missing-resource') await rm(path.join(f.documents,'api/kdoc-api/scripts/main.js'));
  if(kind==='extra-resource') await writeFile(path.join(f.documents,'unknown.bin'),'unexpected');
  if(kind==='extra-html') await writeFile(path.join(f.documents,'extra.html'),'<p>unexpected</p>');
  if(kind==='symlink') await symlink(path.join(f.documents,'index.html'),path.join(f.documents,'linked.html'));
  if(kind==='existing-output') await mkdir(f.output);
  if(kind==='overlap') f.output=path.join(f.documents,'audit');
  await assert.rejects(api.packageSpringNoticeEvidence(f));
  assert.equal((await readdir(path.join(f.documents,'licenses'))).includes('crux-third-party'),false);
});
