import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,promisify} from 'node:util';
import {createOwnedTempDir,registerOwnedProcess} from './helpers/owned-fixtures.mjs';
import {createGameLoop,initializePreparedSession} from '../tools/game-loop.js';
const WIN32_SCALE=process.platform==='win32'?6:1;
const TIMEOUT=20_000*WIN32_SCALE;
const ENGINE=path.resolve('engine/cli.js');
const SERVER=path.resolve('server/server.js');
const execFileAsync=promisify(execFile);
const read=file=>JSON.parse(fs.readFileSync(file));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function engine(root,args) {
  const {stdout}=await execFileAsync(process.execPath,[ENGINE,...args,'--game-dir',root],{encoding:'utf8',timeout:5_000});
  return JSON.parse(stdout.trim());
}
async function seedCompletedAndActiveHand(root) {
  // The first hand is completed by legal check/call actions, rather than a
  // hand-shaped JSON fixture.  The second remains active after one actual action.
  let remaining=128;
  while(!read(path.join(root,'state.json')).lastHand) {
    assert.ok(remaining-->0,'check/call hand seed did not complete');
    const legal=await engine(root,['legal']);
    if(legal.handOver) await engine(root,['step','--new-hand']);
    else {
      assert.equal(typeof legal.toAct,'string','legal actor is required while hand remains live');
      await engine(root,['step',legal.toAct,legal.canCheck?'check':'call','--expect-version',String(legal.stateVersion)]);
    }
  }
  await engine(root,['step','--new-hand']);
  const legal=await engine(root,['legal']);
  await engine(root,['step',legal.toAct,legal.canCheck?'check':'call','--expect-version',String(legal.stateVersion)]);
  const seeded=read(path.join(root,'state.json'));
  assert.ok(seeded.lastHand?.actions?.length>0,'a real completed hand is required');
  assert.ok(seeded.hand?.actions?.length>0,'a real in-progress hand action is required');
  return seeded;
}
async function startRelay(root,token) {
  const child=registerOwnedProcess(spawn(process.execPath,[SERVER,'--game-dir',root,'--port','0','--token',token],{stdio:'ignore'}),'#197 recovery relay');
  const deadline=Date.now()+5_000*WIN32_SCALE;
  try {
    while(Date.now()<deadline) {
      if(child.exitCode!==null||child.signalCode!==null) throw new Error('relay exited before owning lock');
      try {
        const lock=read(path.join(root,'lock.json'));
        const health=await fetch(`http://127.0.0.1:${lock.port}/api/health`);
        if(lock.serverPid===child.pid&&health.ok&&(await health.json()).ok===true)return child;
      } catch {/* relay is still starting */}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('relay did not become healthy');
  } catch(error) {
    await stopChild(child);
    throw error;
  }
}
async function stopChild(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2_000*WIN32_SCALE))]);
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
}
async function fixture(t,{large=false}={}) {
  const root=createOwnedTempDir('unverified-exit');
  await initializePreparedSession(root,{ai:1,mode:'cash-training',hands:20,opponentRuntime:'policy'});
  const engine=read(path.join(root,'state.json'));
  const file=path.join(root,'loop-state.json');
  const state={phase:'playing',sessionToken:engine.sessionToken,gameEpoch:sha(engine.sessionToken),
    pendingDecision:{schemaVersion:1,gameEpoch:'foreign',generation:'RAW_INFINITY',status:'retry_authorized',
      freshAuthorization:{source:'app',requestId:'unconsumed'}}};
  const raw=Buffer.from(JSON.stringify(state).replace('"RAW_INFINITY"','1e400')+(large?' '.repeat(2*1024*1024):''));
  fs.writeFileSync(file,raw);
  let calls=0;
  const loops=[];
  const loop=(opts={})=>{const l=createGameLoop({gameDir:root,resolver:async()=>{calls++;throw new Error('UNEXPECTED_RESOLVER');},opts:{port:0,...opts}});loops.push(l);return l;};
  t.after(async()=>{for(const l of loops)await l.requestStop().catch(()=>{});});
  return {root,file,engine,raw,loop,calls:()=>calls};
}
test('#197 preserves original invalid bytes before resume cleanup, then aborts without resolving a runtime',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  await assert.rejects(f.loop().resume(),{code:'BAD_PLAYER_RECOVERY'});
  assert.deepEqual(fs.readFileSync(path.join(f.root,'loop-state.unverified.json')),f.raw);
  const result=await f.loop({abortUnrecoverable:{operationId:'exit-1'}}).resume();
  assert.equal(result.code,'GAME_ENDED');
  const engine=read(path.join(f.root,'state.json'));
  for(const key of ['seats','lastHand','config','sessionToken','policySeed'])assert.deepEqual(engine[key],f.engine[key],key);
  assert.equal(engine.gameOver,true);assert.equal(engine.result,'abort');assert.equal(engine.hand,null);
  assert.equal(engine.abortOperationId,'exit-1');
  const state=read(f.file);
  assert.equal(state.phase,'aborted');assert.equal(state.pendingDecision,undefined);assert.equal(state.aborting,undefined);
  assert.equal(state.abandonedPendingDecision.sha256,sha(f.raw));
  assert.equal(state.abandonedPendingDecision.unverifiedSnapshot,true);
  assert.deepEqual(fs.readFileSync(path.join(f.root,state.abandonedPendingDecision.sidecar)),f.raw);
  assert.equal(f.calls(),0);assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),false);
  const preserved=fs.readFileSync(path.join(f.root,state.abandonedPendingDecision.sidecar));
  assert.equal((await f.loop({abortUnrecoverable:{operationId:'exit-2'}}).resume()).code,'GAME_ENDED');
  assert.deepEqual(fs.readFileSync(path.join(f.root,state.abandonedPendingDecision.sidecar)),preserved);
  assert.equal(read(path.join(f.root,'state.json')).abortOperationId,'exit-1');
});
test('#197 identity rejection and snapshot publication failure never rewrite loop bytes',{timeout:TIMEOUT},async t=>{
  for(const mode of ['identity','snapshot-failure','large'])await t.test(mode,async st=>{
    const f=await fixture(st,{large:mode==='large'});
    if(mode==='identity'){const state=read(f.file);state.gameEpoch='wrong';fs.writeFileSync(f.file,JSON.stringify(state));}
    if(mode==='snapshot-failure')fs.mkdirSync(path.join(f.root,'loop-state.unverified.json'));
    const before=fs.readFileSync(f.file);
    const loop=f.loop();
    await assert.rejects(loop.resume(),{code:mode==='identity'?'LOOP_STATE_IDENTITY_MISMATCH':'BAD_PLAYER_RECOVERY'});
    await loop.requestStop();
    if(mode==='large')assert.deepEqual(fs.readFileSync(path.join(f.root,'loop-state.unverified.json')),before);
    else assert.deepEqual(fs.readFileSync(f.file),before);
  });
});
test('#197 snapshot failure keeps raw bytes but records a later owned cleanup failure',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  fs.mkdirSync(path.join(f.root,'loop-state.unverified.json'));
  const loop=f.loop();
  const before=fs.readFileSync(f.file), lockDir=path.join(f.root,'loop.lock.d');
  const originalRmdir=fs.rmdirSync;
  let injected=false;
  fs.rmdirSync=function(target,...args){
    if(!injected&&target===lockDir){
      injected=true;
      throw Object.assign(new Error('fixture cleanup rmdir failure'),{code:'FIXTURE_RMDIR_FAIL'});
    }
    return originalRmdir.call(this,target,...args);
  };
  try {
    await assert.rejects(loop.resume(),{code:'FIXTURE_RMDIR_FAIL'});
  } finally {
    fs.rmdirSync=originalRmdir;
  }
  assert.equal(injected,true);
  assert.deepEqual(fs.readFileSync(f.file),before);
  const events=fs.readFileSync(path.join(f.root,'loop.log'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some(event=>event.event==='cleanup-failed'&&event.code==='FIXTURE_RMDIR_FAIL'));
  if(fs.existsSync(lockDir))fs.rmdirSync(lockDir);
});
test('#197 failed engine end leaves a verifiable checkpoint and resumed abort is idempotent',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  await assert.rejects(f.loop({abortUnrecoverable:{operationId:'crash-end'},onEngineInvoke:args=>{
    if(args[0]==='end')throw Object.assign(new Error('injected'),{code:'END_REJECTED'});
  }}).resume(),{code:'END_REJECTED'});
  const state=read(f.file);
  assert.deepEqual(state.aborting,{operationId:'crash-end',mode:'abort'});
  assert.equal(state.pendingDecision,undefined);
  const next=f.loop();
  await assert.rejects(next.run(),{code:'BAD_LOOP_PHASE'});
  assert.equal((await next.resume()).code,'GAME_ENDED');
  assert.equal(f.calls(),0);
});
test('#197 a conflicting sidecar is never overwritten',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  const sidecar=path.join(f.root,'loop-state.abandoned.collision.json');
  fs.writeFileSync(sidecar,'different');
  await assert.rejects(f.loop({abortUnrecoverable:{operationId:'collision'}}).resume(),{code:'ABANDON_SIDECAR_CONFLICT'});
  assert.equal(fs.readFileSync(sidecar,'utf8'),'different');
  assert.equal(read(path.join(f.root,'state.json')).gameOver,false);
  assert.deepEqual(fs.readFileSync(f.file),f.raw);
});

test('#197 terminal checkpoint requires the same engine operation and a closed audit record',{timeout:TIMEOUT},async t=>{
  for(const kind of ['operation-conflict','event','at','pending','timestamp'])await t.test(kind,async st=>{
    const f=await fixture(st);
    await assert.rejects(f.loop({abortUnrecoverable:{operationId:'operation-a'},onEngineInvoke:args=>{
      if(args[0]==='end')throw Object.assign(new Error('checkpoint cut'),{code:'CHECKPOINT_CUT'});
    }}).resume(),{code:'CHECKPOINT_CUT'});
    if(kind==='operation-conflict')await engine(f.root,['end','--result','abort','--operation-id','operation-b']);
    else {
      const state=read(f.file);
      if(kind==='pending')state.pendingDecision={schemaVersion:1,generation:1,status:'running'};
      else if(kind==='timestamp')state.abandonedPendingDecision.abandonedAt='not-a-time';
      else state.abandonedPendingDecision[kind]='forged';
      fs.writeFileSync(f.file,JSON.stringify(state));
    }
    const before=fs.readFileSync(f.file),engineBefore=fs.readFileSync(path.join(f.root,'state.json'));
    const sidecar=read(f.file).abandonedPendingDecision.sidecar,sidecarBefore=fs.readFileSync(path.join(f.root,sidecar));
    await assert.rejects(f.loop().resume(),{code:'BAD_ABORT_CHECKPOINT'});
    assert.deepEqual(fs.readFileSync(f.file),before);
    assert.deepEqual(fs.readFileSync(path.join(f.root,'state.json')),engineBefore);
    assert.deepEqual(fs.readFileSync(path.join(f.root,sidecar)),sidecarBefore);
    assert.equal(f.calls(),0);
  });
});

test('#197 checkpoint re-entry repairs a missing abandonment audit event',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t), originalWrite=fs.writeSync;
  let injected=false;
  fs.writeSync=function(fd,data,...args){
    if(!injected&&typeof data==='string'&&data.includes('"event":"player-recovery-abandoned"')){
      injected=true;throw Object.assign(new Error('audit publication cut'),{code:'AUDIT_WRITE_CUT'});
    }
    return originalWrite.call(this,fd,data,...args);
  };
  try {await assert.rejects(f.loop({abortUnrecoverable:{operationId:'audit-cut'}}).resume(),{code:'AUDIT_WRITE_CUT'});}
  finally {fs.writeSync=originalWrite;}
  assert.equal(read(f.file).aborting.operationId,'audit-cut');
  assert.equal((await f.loop().resume()).code,'GAME_ENDED');
  const events=fs.readFileSync(path.join(f.root,'loop.log'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some(event=>event.event==='player-recovery-abandoned'&&event.operationId==='audit-cut'));
});

test('#197 stop during an owned engine end waits for the terminal checkpoint and lock release',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  let enter,release;
  const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const loop=f.loop({abortUnrecoverable:{operationId:'stop-end'},onEngineInvoke:async args=>{
    if(args[0]==='end'){enter();await gate;}
  }});
  const resuming=loop.resume();
  await entered;
  const stopping=loop.requestStop();
  assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),true);
  release();
  assert.equal((await resuming).code,'GAME_ENDED');await stopping;
  const bytes=fs.readFileSync(f.file);
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(fs.readFileSync(f.file),bytes);
  assert.equal(read(f.file).phase,'aborted');
  assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),false);
});
test('#197 all three interruption windows retain original bytes and the first engine operation',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  const sidecar=path.join(f.root,'loop-state.abandoned.windows.json');
  fs.writeFileSync(sidecar,f.raw); // sidecar published, checkpoint not yet published
  await assert.rejects(f.loop({abortUnrecoverable:{operationId:'windows'},onEngineInvoke:args=>{
    if(args[0]==='end')throw Object.assign(new Error('cut'),{code:'CUT'});
  }}).resume(),{code:'CUT'});
  const checkpoint=fs.readFileSync(f.file); // checkpoint published, engine not yet ended
  assert.equal((await f.loop().resume()).code,'GAME_ENDED');
  const engine=fs.readFileSync(path.join(f.root,'state.json'));
  fs.writeFileSync(f.file,checkpoint); // engine ended, terminal checkpoint not yet published
  assert.equal((await f.loop().resume()).code,'GAME_ENDED');
  assert.deepEqual(fs.readFileSync(sidecar),f.raw);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'state.json')),engine);
  assert.equal(read(f.file).aborting,undefined);
});
test('#197 finalize preserves terminal engine results and never asks for a player runtime',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  const engineFile=path.join(f.root,'state.json');
  fs.writeFileSync(engineFile,JSON.stringify({...f.engine,gameOver:true,result:'win',hand:null,lastHand:{handNo:0}}));
  const before=fs.readFileSync(engineFile);
  const needs=[];
  const loop=createGameLoop({gameDir:f.root,resolver:async({need})=>{needs.push(need);return {player:null,upper:null,notices:[]};},
    opts:{port:0,waitMs:0,abortUnrecoverable:{operationId:'finalize'}}});
  t.after(()=>loop.requestStop());
  await loop.resume();
  assert.equal(read(f.file).pendingDecision,undefined);
  const result=await loop.run();
  assert.equal(result.phase,'done');
  assert.deepEqual(fs.readFileSync(engineFile),before);
  assert.ok(needs.every(need=>need==='upper-only'));
  assert.equal(read(f.file).abandonedPendingDecision.mode,'finalize');
});
test('#197 abort preserves a real completed hand and active action while changing only engine abort fields',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  const before=await seedCompletedAndActiveHand(f.root);
  await assert.rejects(f.loop().resume(),{code:'BAD_PLAYER_RECOVERY'});
  assert.equal((await f.loop({abortUnrecoverable:{operationId:'audit-real-hand'}}).resume()).code,'GAME_ENDED');
  const after=read(path.join(f.root,'state.json'));
  const changed=Object.keys({...before,...after}).filter(key=>!isDeepStrictEqual(before[key],after[key])).sort();
  assert.deepEqual(changed,['abortOperationId','gameOver','hand','phase','result','stateVersion']);
  for(const key of ['seats','lastHand','config','sessionToken','policySeed'])assert.deepEqual(after[key],before[key],key);
  assert.equal(after.gameOver,true);assert.equal(after.result,'abort');assert.equal(after.phase,'idle');assert.equal(after.hand,null);
  assert.equal(after.abortOperationId,'audit-real-hand');assert.equal(after.stateVersion,before.stateVersion+1);
  const audit=read(path.join(f.root,'.aborted-hand.json'));
  assert.equal(audit.operationId,'audit-real-hand');
  assert.deepEqual(audit.hand,before.hand,'the audit carries every active-hand action');
  assert.equal(audit.completedHands,before.lastHand.handNo);
  assert.equal(audit.stateVersion,before.stateVersion);
});
test('#197 rejects tampered abort checkpoints and digests before an engine mutation',{timeout:TIMEOUT},async t=>{
  for(const [label,tamper] of [
    ['checkpoint-operation',state=>{state.aborting.operationId='different-operation';}],
    ['audit-digest',state=>{state.abandonedPendingDecision.sha256='0'.repeat(64);}],
  ])await t.test(label,async st=>{
    const f=await fixture(st);
    await assert.rejects(f.loop({abortUnrecoverable:{operationId:'checkpoint-source'},onEngineInvoke:args=>{
      if(args[0]==='end')throw Object.assign(new Error('cut after checkpoint'),{code:'END_REJECTED'});
    }}).resume(),{code:'END_REJECTED'});
    const state=read(f.file);tamper(state);fs.writeFileSync(f.file,JSON.stringify(state));
    const loopBytes=fs.readFileSync(f.file),engineBytes=fs.readFileSync(path.join(f.root,'state.json'));
    await assert.rejects(f.loop().resume(),{code:'BAD_ABORT_CHECKPOINT'});
    assert.deepEqual(fs.readFileSync(f.file),loopBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root,'state.json')),engineBytes);
    assert.equal(f.calls(),0);
  });
});
test('#197 requestStop waits through real relay adoption before releasing the terminal lock',{timeout:TIMEOUT},async t=>{
  const f=await fixture(t);
  const relay=await startRelay(f.root,f.engine.sessionToken);
  t.after(()=>stopChild(relay));
  let entered,release,listenerCalls=0;
  const adopted=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const loop=f.loop({abortUnrecoverable:{operationId:'relay-stop'},listenerOwnedBy:async()=>{
    if(++listenerCalls===1){entered();await gate;}
    return true;
  }});
  const resuming=loop.resume();
  await adopted;
  const stopping=loop.requestStop();
  assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),true,'end/adoption unit still owns the loop lock');
  release();
  assert.equal((await resuming).code,'GAME_ENDED');
  await stopping;
  assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),false);
  assert.notEqual(listenerCalls,0);
});
