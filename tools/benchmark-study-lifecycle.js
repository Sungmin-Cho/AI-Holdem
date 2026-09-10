#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const implementation=path.resolve(option('--implementation','.'));
const out=path.resolve(option('--out','study-lifecycle.json'));
const label=option('--label','candidate');
const repeats=Number(option('--repeats','3')),warm=Number(option('--warm','10'));
if(!Number.isSafeInteger(repeats)||repeats<1||repeats>10||!Number.isSafeInteger(warm)||warm<1||warm>100) throw new Error('invalid sample count');
const diagnostics=fs.mkdtempSync(path.join(os.tmpdir(),'holdem-proof-benchmark-'));
process.env.AI_HOLDEM_PLATFORM_DIAGNOSTICS=diagnostics;
const load=relative=>import(pathToFileURL(path.join(implementation,relative)).href);
const platform=await load('shared/platform-files.js');
const state=await load('engine/state.js');
const serviceApi=await load('tools/study-service.js');
const {ensureStudyService,inspectStudyService,stopStudyService}=serviceApi;
const proofFile=path.join(diagnostics,'proofs.jsonl');
const proofs=()=>fs.existsSync(proofFile)?fs.readFileSync(proofFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const rows=[];
async function measured(operation,rep,sample,fn) {
  const before=proofs().length,started=performance.now();
  let value,error;
  try {value=await fn();} catch(e){error=e;}
  const ms=performance.now()-started;
  const events=proofs().slice(before).map(row=>({kind:row.kind,ms:row.ms,status:row.status,timedOut:row.timedOut,
    phase:row.phase,side:row.pid===process.pid?'client':'service'}));
  rows.push({operation,rep,sample,ms,ok:!error,code:error?.code??(error?'ERROR':null),
    censored:!!error,proofs:events});
  if(error) throw error;
  return value;
}
let failed=false;
for(let rep=0;rep<repeats;rep++) {
  const root=path.join(os.tmpdir(),`holdem-lifecycle-${randomUUID()}`);
  let owner,service,child,childClosed=false,stopped=false;
  try {
    await measured('prepare-private-store',rep,0,()=>platform.createPrivateDirectory(root));
    owner=await measured('acquire-parent-lock',rep,0,()=>state.acquireOwnedLock(root,'loop.lock.d'));
    const options={parentIdentity:{pid:owner.pid,startTime:owner.startTime},onChild(value){
      child=value;child.once('close',()=>{childClosed=true;});
    }};
    service=await measured('cold-ensure',rep,0,()=>ensureStudyService(root,options));
    const request=async(route,bad=false)=>{
      const token=new URLSearchParams(new URL(service.studyUrl).hash.slice(1)).get('token');
      const response=await fetch(`http://127.0.0.1:${service.port}${route}`,{headers:{'x-drill-token':bad?'wrong-token':token},
        signal:AbortSignal.timeout(serviceApi.HTTP_WAIT_MS)});
      assert.equal(response.status,bad?401:200);await response.arrayBuffer();
    };
    await measured('bad-token',rep,0,()=>request('/api/health',true));
    // Explicit warmup, excluded from the steady-operation rows but retained.
    await measured('warmup-http',rep,0,()=>request('/api/summary'));
    for(let sample=0;sample<warm;sample++) {
      await measured('warm-ensure',rep,sample,async()=>assert.equal((await ensureStudyService(root,options)).instanceId,service.instanceId));
      await measured('inspect',rep,sample,async()=>assert.equal((await inspectStudyService(root)).instanceId,service.instanceId));
      await measured('http-summary',rep,sample,()=>request('/api/summary'));
    }
    await measured('stop',rep,0,async()=>{
      assert.equal((await stopStudyService(root,{expectedInstanceId:service.instanceId})).stopped,true);
      assert.equal(state.ownedIdentityStatus(service.pid,service.startTime),'dead');
      assert.equal(fs.existsSync(path.join(root,'.training','study-service.json')),false);
      assert.equal(fs.existsSync(path.join(root,'.training','study.lock.d')),false);
      stopped=true;
    });
  } catch {failed=true;}
  finally {
    if(service&&!stopped) {
      try {await measured('cleanup-stop',rep,0,async()=>{
        await stopStudyService(root,{expectedInstanceId:service.instanceId});
        assert.equal(state.ownedIdentityStatus(service.pid,service.startTime),'dead');stopped=true;
      });} catch {failed=true;}
    }
    if(child&&!service&&!childClosed) {
      try {await measured('cleanup-startup-child',rep,0,async()=>{
        // This is the exact ChildProcess spawned for this private fixture, not
        // a PID inferred from a descriptor. Never signal an unrelated service.
        child.ref();
        const closed=new Promise(resolve=>child.once('close',resolve));
        if(!child.kill('SIGTERM')&&!childClosed) throw new Error('child signal failed');
        let timer;
        try {await Promise.race([closed,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('child close unconfirmed')),10000);
        })]);} finally {clearTimeout(timer);child.unref();}
        assert.equal(childClosed,true);stopped=true;
      });} catch {failed=true;child.unref();}
    }
    if(owner) state.releaseOwnedLock(owner);
    // Only a confirmed stopped lifecycle authorizes deleting its owned fixture.
    if(stopped) fs.rmSync(root,{recursive:true});
  }
}
const quantile=(values,q)=>values.sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]??null;
const summary=Object.fromEntries([...new Set(rows.map(row=>row.operation))].map(operation=>{
  const group=rows.filter(row=>row.operation===operation),ok=group.filter(row=>row.ok);
  return [operation,{n:group.length,successes:ok.length,failures:group.length-ok.length,
    medianMs:quantile(ok.map(row=>row.ms),0.5),p95Ms:quantile(ok.map(row=>row.ms),0.95),
    proofCalls:group.reduce((s,row)=>s+row.proofs.length,0),
    cumulativeProofMs:group.reduce((s,row)=>s+row.proofs.reduce((n,p)=>n+p.ms,0),0)}];
}));
const sha=execFileSync('git',['-C',implementation,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
let powershell=null;
if(process.platform==='win32') powershell=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8'}).trim();
const result={schemaVersion:1,label,sha,platform:process.platform,release:os.release(),arch:process.arch,node:process.version,powershell,
  image:process.env.ImageVersion??null,repeats,warm,passed:!failed,
  methodology:'Fresh private store/service coldness, not cold OS; sequential operation windows include concurrent service checkpoint proofs. Proof cumulative time is not request wall time. Failed rows remain censored in denominators.',summary,rows};
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2));
process.stdout.write(JSON.stringify({label,sha,passed:result.passed,summary})+'\n');
process.exitCode=failed?1:0;
