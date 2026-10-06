import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(t, target = 'docs') {
  const root = await mkdtemp(path.join(tmpdir(), 'crux-spring-source-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const repo=path.join(root,'repo'); await mkdir(repo);
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  git(['init','-q']); await mkdir(path.join(repo,'docs'));
  await writeFile(path.join(repo,'gradle.properties'),'version=7.0.9\n');
  await writeFile(path.join(repo,'docs','page.txt'),'original content\n');
  await symlink(target,path.join(repo,'examples'));
  git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  return {root,repo,commit:git(['rev-parse','HEAD'])};
}
async function materialize(args) {
  const m=await import('../src/spring/source.js').catch(()=>({}));
  assert.equal(typeof m.materializeSpringSource,'function','source materializer exists');
  return m.materializeSpringSource(args);
}
test('materializes committed bytes, not dirty worktree, and records the complete tree',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.repo,'docs/page.txt'),'dirty');
  const destination=path.join(f.root,'source');
  const result=await materialize({...f,repositoryDirectory:f.repo,destination,version:'7.0.9'});
  assert.equal(await readFile(path.join(destination,'docs/page.txt'),'utf8'),'original content\n');
  assert.equal(await readlink(path.join(destination,'examples')),'docs');
  assert.equal(result.files,3);assert.match(result.treeSha256,/^[a-f0-9]{64}$/);
  assert.equal(result.commit,f.commit);
  await assert.rejects(materialize({...f,repositoryDirectory:f.repo,destination,version:'7.0.9'}),/exist/i);
});
for(const target of ['../outside','/tmp','missing','examples']) test(`rejects unsafe link ${target}`,async t=>{
  const f=await fixture(t,target);
  await assert.rejects(materialize({...f,repositoryDirectory:f.repo,destination:path.join(f.root,'source'),version:'7.0.9'}),/link/i);
});
test('rejects version and commit mismatches before publishing a successful tree',async t=>{
  const f=await fixture(t);
  await assert.rejects(materialize({...f,repositoryDirectory:f.repo,destination:path.join(f.root,'source'),version:'7.0.10'}),/version/i);
  await assert.rejects(materialize({...f,repositoryDirectory:f.repo,destination:path.join(f.root,'other'),version:'7.0.9',commit:'HEAD'}),/commit/i);
});
