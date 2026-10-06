import path from 'node:path';
import { lstat, realpath, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditAssets } from '../asset-audit.js';
import catalog from '../../recipes/spring-framework/notices/dokka-2.1.0.json' with { type: 'json' };
import rules from '../../recipes/spring-framework/notices/assets-7.0.9.json' with { type: 'json' };

const sha = x => createHash('sha256').update(x).digest('hex');
const safe = x => typeof x === 'string' && x.length < 4096 && x.split('/').every(p => /^[A-Za-z0-9_$.-]+$/.test(p) && p !== '.' && p !== '..');
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const prefix = 'licenses/crux-third-party/';
const overlaps = (a,b) => a === b || a.startsWith(b+path.sep) || b.startsWith(a+path.sep);
const htmlGroup = file => file.startsWith('api/javadoc-api/') ? 'javadoc' : file.startsWith('api/kdoc-api/') ? 'dokka' : file.startsWith('reference/') ? 'reference' : 'root';
const htmlOwners = {javadoc:['spring','jdk','crux-adaptations'],dokka:['spring','dokka','crux-adaptations'],reference:['spring','crux-adaptations'],root:['crux-adaptations']};

/** Pinned production boundary: no recipe-controlled paths, commands or approvals. */
export const packageSpringNotices = options => packageSpringNoticeEvidence({...options,catalog,rules});

/** Internal packaging primitive for immutable, locally owned candidates and trusted
 * repository evidence (not an upload API). Captured hashes prove bytes, not rights.
 * Generated HTML has mixed provenance; its generator does NOT license all content.
 * Keep release review separate: this function never sets reviewed:true.
 */
export async function packageSpringNoticeEvidence({documents,output,catalog:inputCatalog,rules:inputRules}) {
  const catalog=structuredClone(inputCatalog), rules=structuredClone(inputRules);
  if(!path.isAbsolute(documents)||!path.isAbsolute(output)) throw Error('Absolute notice paths required');
  const root=await lstat(documents);
  if(!root.isDirectory()||root.isSymbolicLink()) throw Error('Invalid notice Documents directory');
  documents=await realpath(documents);
  const parent=await realpath(path.dirname(output)); output=path.join(parent,path.basename(output));
  if(overlaps(documents,output)) throw Error('Notice output and Documents must be separate');
  try {await lstat(output);throw Error('Notice output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(catalog?.schemaVersion!==1||rules?.schemaVersion!==1||rules.version!=='7.0.9'||rules.sourceCommit!=='82a6b40b9366ec181ededdad282b307ee5381a52') throw Error('Invalid Spring notice evidence');
  const pending=new Map(), components=new Map(), expected=new Map();
  function notice(file,text,checksum) {
    if(!safe(file)||!hash(checksum)||typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>1024**2||sha(text)!==checksum||pending.has(file)) throw Error('Invalid or changed notice text');
    pending.set(file,text);
  }
  for(const n of catalog.notices) notice(`${prefix}${n.sha256}.txt`,n.text,n.sha256);
  for(const n of rules.notices) notice(prefix+n.path,n.text,n.sha256);
  function component(id,version,license,source,notices) {
    if(typeof id!=='string'||!id.trim()||components.has(id)||typeof version!=='string'||!version||typeof license!=='string'||!license||!Array.isArray(notices)||!notices.length||notices.some(p=>!safe(p))) throw Error('Invalid notice component');
    const url=new URL(source); if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid component source');
    components.set(id,{id,version,license,source,reviewed:false,notices});
  }
  for(const c of catalog.components) {
    const notices=c.notices.map(n=>prefix+n.sha256+'.txt');
    if(notices.some(p=>!pending.has(p)))throw Error('Missing component notice reference');
    component(`${c.name}@${c.version}`,c.version,typeof c.declaredLicense==='string'?c.declaredLicense:JSON.stringify(c.declaredLicense),c.archive,notices);
  }
  component('spring',rules.version,'Apache-2.0','https://github.com/spring-projects/spring-framework/tree/'+rules.sourceCommit,['licenses/SPRING-LICENSE.txt','licenses/UPSTREAM-NOTICES.txt']);
  component('dokka','2.1.0','Apache-2.0','https://github.com/Kotlin/dokka/tree/905286d0d31f143bf0627656db1f14ea56fa42d3',[prefix+'DOKKA-LICENSE.txt',prefix+'DOKKA-NOTICE.txt']);
  component('prism','1.29.0','MIT','https://github.com/PrismJS/prism/tree/v1.29.0',[prefix+'PRISM-LICENSE.txt']);
  const legal='api/javadoc-api/legal/';
  component('jdk','25.0.4.1+1','LicenseRef-JDK-retained-terms-not-a-license-for-Spring-content','https://github.com/adoptium/temurin25-binaries',[legal+'LICENSE',legal+'ADDITIONAL_LICENSE_INFO',legal+'ASSEMBLY_EXCEPTION']);
  component('jquery','3.7.1','MIT','https://github.com/jquery/jquery/tree/3.7.1',[legal+'jquery.md']);
  component('jquery-ui','1.14.1','MIT','https://github.com/jquery/jquery-ui/tree/1.14.1',[legal+'jqueryUI.md']);
  component('dejavu','2.37','LicenseRef-DejaVu-Bitstream-Arev','https://github.com/dejavu-fonts/dejavu-fonts/tree/version_2_37',[legal+'dejavufonts.md']);
  component('crux-adaptations','1','LicenseRef-Unspecified-Crux-adaptations','https://github.com/zacharyhuo/crux-docset',['NOTICES.txt']);
  for(const f of rules.staticFiles) {
    if(!safe(f.path)||!hash(f.sha256)||expected.has(f.path)||!Array.isArray(f.components)||!f.components.length||f.components.some(id=>!components.has(id)))throw Error('Invalid static asset rule or unknown owner');
    expected.set(f.path,f);
  }
  for(const font of catalog.fonts) {
    const f=expected.get(font.file), id=`${font.component}@${font.version}`;
    if(!f||f.sha256!==font.sha256||!f.components.includes(id)||!components.has(id))throw Error('Font evidence mismatch');
  }
  const files=[],groups={}; let bytes=0,entries=0;
  async function walk(relative='') {
    if(relative.split('/').length>32)throw Error('Notice tree depth limit');
    for(const name of (await readdir(path.join(documents,relative))).sort()) {
      const file=relative?relative+'/'+name:name;
      if(++entries>30000||!safe(file))throw Error('Notice tree path/count limit');
      const absolute=path.join(documents,file),stat=await lstat(absolute);
      if(stat.isSymbolicLink())throw Error('Notice tree symlink rejected');
      if(stat.isDirectory()){await walk(file);continue;}
      if(!stat.isFile()||stat.size>16*1024**2||(bytes+=stat.size)>512*1024**2)throw Error('Notice tree file/size limit');
      const content=await readFile(absolute), checksum=sha(content);
      if(content.length!==stat.size)throw Error('Notice input changed');
      if(file.endsWith('.html')) {
        const group=htmlGroup(file); (groups[group]??=[]).push(file);
        files.push({path:file,sha256:checksum,components:htmlOwners[group],provenance:'mixed-generated-content-not-license-conclusion'});
      } else {
        const rule=expected.get(file);
        if(!rule)throw Error(`Unknown Spring asset: ${file}`);
        if(rule.sha256!==checksum)throw Error(`Spring asset checksum mismatch: ${file}`);
        files.push({path:file,sha256:checksum,components:[...rule.components],provenance:rule.provenance});
      }
    }
  }
  await walk();
  const observed=new Map(files.map(f=>[f.path,f]));
  for(const file of expected.keys())if(!observed.has(file))throw Error(`Missing Spring asset: ${file}`);
  if(Object.keys(groups).length!==Object.keys(rules.htmlGroups).length)throw Error('Unexpected Spring HTML groups');
  for(const [group,paths] of Object.entries(groups)) {
    const rule=rules.htmlGroups[group];
    if(!rule||paths.length!==rule.count||sha(JSON.stringify(paths.sort()))!==rule.pathsSha256)throw Error(`Spring HTML inventory mismatch: ${group}`);
  }
  // Notices inherited from upstream remain in place, byte-for-byte; add explicit
  // ownership for them rather than replacing them with generic license labels.
  for(const c of components.values())for(const file of c.notices) {
    if(!pending.has(file)&&!observed.has(file))throw Error(`Missing required notice: ${file}`);
    const existing=observed.get(file);if(existing&&!existing.components.includes(c.id))existing.components.push(c.id);
  }
  for(const [file,text] of pending) {
    const owners=[...components.values()].filter(c=>c.notices.includes(file)).map(c=>c.id);
    if(!owners.length)throw Error('Orphan notice text');
    files.push({path:file,sha256:sha(text),components:owners});
  }
  const index='Crux offline third-party notice evidence. NOT redistribution approval.\n'+
    'Spring documentation, generated templates and Crux adaptations have distinct provenance.\n'+
    'Prism resources are the Dokka-patched 1.29.0 copies, not pristine upstream bundles.\n'+
    [...components.values()].map(c=>`${c.id} ${c.version}\nSource: ${c.source}\nDeclared terms: ${c.license}\nNotices: ${c.notices.join(', ')}\n`).join('\n');
  pending.set(prefix+'INDEX.txt',index);
  files.push({path:prefix+'INDEX.txt',sha256:sha(index),components:['crux-adaptations']});
  // Both destinations are exclusive. Failure leaves a quarantined, incomplete
  // candidate, never overwrites a previous audit or published artifact.
  await mkdir(output);
  await mkdir(path.join(documents,prefix));
  for(const [file,text] of pending) await writeFile(path.join(documents,file),text,{flag:'wx'});
  const manifest={schemaVersion:1,qualification:'generated-provenance-not-release-approved',components:[...components.values()],files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
  const manifestPath=path.join(output,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  const releaseAudit=await auditAssets(documents,manifestPath);
  // Every component MUST still require independent review. Other errors (even
  // those beyond the bounded error preview) fail local integrity qualification.
  const integrityPassed=releaseAudit.errorCount===components.size&&releaseAudit.errors.every(e=>e.startsWith('Component requires review:'));
  const report={schemaVersion:1,integrityPassed,releaseQualified:false,files:files.length,components:components.size,addedNoticeFiles:pending.size,releaseAudit};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(!integrityPassed)throw Error('Spring packaged asset integrity audit failed');
  return report;
}
