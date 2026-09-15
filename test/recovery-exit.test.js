import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createGameLoop,initializePreparedSession} from '../tools/game-loop.js';
const TIMEOUT=process.platform==='win32'?120000:20000;
const read=file=>JSON.parse(fs.readFileSync(file));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
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
});
