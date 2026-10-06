import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
async function fixture(t){const cwd=await mkdtemp(path.join(tmpdir(),'crux-process-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return {command:process.execPath,cwd,env:{PATH:'/usr/bin:/bin'},stage:'probe',timeoutMs:3000};}
async function run(input){const m=await import('../src/spring/process.js').catch(()=>({}));assert.equal(typeof m.runSpringCommand,'function');return m.runSpringCommand(input);}
test('records real command output and does not inherit the parent environment',async t=>{
  const input=await fixture(t);process.env.CRUX_PROCESS_TEST_SENTINEL='parent-only';t.after(()=>delete process.env.CRUX_PROCESS_TEST_SENTINEL);
  const result=await run({...input,args:['-e','console.log(process.env.CRUX_PROCESS_TEST_SENTINEL ?? "isolated");console.error("diagnostic")']});
  assert.equal(result.code,0);const log=await readFile(path.join(input.cwd,'probe.log'),'utf8');assert.match(log,/isolated/);assert.match(log,/diagnostic/);assert.doesNotMatch(log,/parent-only/);
});
test('timeout terminates a stopped descendant in a separate session before returning',async t=>{
  const input=await fixture(t), pidFile=path.join(input.cwd,'descendant.pid');
  let pid;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}});
  const childCode=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.kill(process.pid,'SIGSTOP');setInterval(()=>{},1000)`;
  const parentCode=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`;
  await assert.rejects(run({...input,args:['-e',parentCode],timeoutMs:1000}),/timeout/);
  pid=Number(await readFile(pidFile,'utf8'));
  let running=true;
  for(let i=0;i<30;i++){
    const rows=execFileSync('/bin/ps',['-axo','pid=,stat='],{encoding:'utf8'}).trim().split('\n');
    const row=rows.map(s=>s.trim().split(/\s+/)).find(s=>Number(s[0])===pid);
    running=!!row&&!row[1].startsWith('Z');if(!running)break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(running,false,'owned detached descendant must not outlive timeout cleanup');
});
test('nonzero status and timeout retain failure evidence rather than reporting success',async t=>{
  for(const [stage,args,timeoutMs,pattern] of [['exit',['-e','process.exit(23)'],3000,/23/],['timeout',['-e','setInterval(()=>{},1000)'],100,/timeout/],['limit',['-e','console.log("x".repeat(10000))'],3000,/limit/]]){
    const input=await fixture(t);await assert.rejects(run({...input,stage,args,timeoutMs,maxBytes:100}),pattern);
    const report=JSON.parse(await readFile(path.join(input.cwd,stage+'-result.json')));assert.equal(report.passed,false);
  }
});
