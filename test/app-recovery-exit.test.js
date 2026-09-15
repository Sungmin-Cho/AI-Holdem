import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createSessionManager} from '../tools/session-manager.js';
import * as contract from '../shared/session-control-contract.js';
import {prepareGameSession,createGameLoop} from '../tools/game-loop.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareSession,commitSession} from '../engine/session-catalog.js';
import {initializePreparedSession} from '../tools/game-loop.js';
import {resolveSessionReference} from '../tools/reference-source.js';
import {sealPreparation} from '../tools/session-preparation.js';
import {setupToArgs} from '../shared/game-setup.js';

const TIMEOUT=process.platform==='win32'?300000:30000;
const body=(manager,kind)=>{const s=manager.snapshot();return {requestId:randomUUID(),kind,
  expectedInstanceId:s.instanceId,expectedAppRevision:s.appRevision,
  expectedGameId:s.gameId,expectedSelectionVersion:s.selectionVersion};};
const settle=async(manager,id)=>{
  const until=Date.now()+TIMEOUT;
  while(Date.now()<until){const row=manager.receipt(id);if(row.status!=='accepted')return row;await new Promise(r=>setTimeout(r,20));}
  throw new Error('receipt timeout');
};
const read=file=>JSON.parse(fs.readFileSync(file));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const engineEnd=async(root,operationId)=>promisify(execFile)(process.execPath,[path.resolve('engine/cli.js'),
  'end','--result','abort','--operation-id',operationId,'--game-dir',root]);
async function stagePreparedRestart(root,row,{commit=false}={}) {
  const prepared=prepareSession(root,row.reservation);
  const initialized=await initializePreparedSession(prepared.stagingDir,setupToArgs(row.setup,root));
  resolveSessionReference(prepared.stagingDir,{createNew:true});
  sealPreparation(prepared,initialized);
  return commit?commitSession(root,prepared):prepared;
}
function assertParkedFreshGame(manager,oldGameId) {
  assert.equal(manager.snapshot().state,'paused');
  assert.notEqual(manager.snapshot().gameId,oldGameId);
  const dir=manager.current.sessionDir;
  const engine=read(path.join(dir,'state.json')),loop=read(path.join(dir,'loop-state.json'));
  assert.equal(engine.hand,null,'parked recovery must not enter a hand');
  assert.equal(engine.lastHand,null,'parked recovery must make zero decisions');
  assert.equal(loop.pendingDecision,undefined,'parked recovery must not create a decision');
  assert.deepEqual(loop.metrics??[],[],'parked recovery must not record a decision metric');
}
async function damagedStore(t,{phase='playing',gameOver=false}={}) {
  const root=createOwnedTempDir('app-recovery-exit');
  let calls=0;
  const resolver=async()=>{calls++;return {player:null,upper:null,notices:[]};};
  let manager=createSessionManager({storeDir:root,resolver});
  t.after(()=>manager.close());
  await manager.initialize();
  const start={...body(manager,'start'),setup:{aiCount:1,opponentRuntime:'policy'}};
  manager.command(start);assert.equal((await settle(manager,start.requestId)).status,'succeeded');
  const pause=body(manager,'pause');manager.command(pause);await settle(manager,pause.requestId);
  const gameDir=manager.current.sessionDir;
  await manager.close();
  const engineFile=path.join(gameDir,'state.json');
  if(gameOver){const engine=read(engineFile);write(engineFile,{...engine,gameOver:true,result:'win',hand:null,lastHand:engine.lastHand??{handNo:0}});}
  const loopFile=path.join(gameDir,'loop-state.json');
  write(loopFile,{...read(loopFile),phase,pendingDecision:{schemaVersion:1,gameEpoch:'foreign',generation:1,status:'running'}});
  manager=createSessionManager({storeDir:root,resolver});
  await manager.initialize();
  assert.equal(manager.snapshot().error,'SESSION_RECOVERABLE');
  const resume=body(manager,'resume');manager.command(resume);
  assert.equal((await settle(manager,resume.requestId)).error,'BAD_PLAYER_RECOVERY');
  return {manager,root,gameDir,resolver,calls:()=>calls};
}

test('#197 recovery exit gate follows engine/loop phases and exposes the wired exit commands',{timeout:TIMEOUT},async t=>{
  assert.deepEqual(contract.ABORTABLE_ERROR_CODES,['BAD_PLAYER_RECOVERY']);
  assert.equal(Object.isFrozen(contract.ABORTABLE_ERROR_CODES),true);
  for(const [phase,gameOver,mode] of [['playing',false,'abort'],['playing',true,'finalize'],['finalizing',true,'finalize']])await t.test(`${phase}-${gameOver}`,async st=>{
    const {manager}=await damagedStore(st,{phase,gameOver});
    assert.equal(manager.snapshot().state,'error');
    assert.deepEqual(manager.snapshot().recoveryExit,{mode});
    assert.deepEqual(manager.snapshot().allowedCommands,['resume','end','restart']);
  });
});

test('#197 explicit end and restart use a pinned recovery journal and preserve the old game',{timeout:TIMEOUT},async t=>{
  for(const kind of ['end','restart'])await t.test(kind,async st=>{
    const f=await damagedStore(st), manager=f.manager;
    const before=read(path.join(f.gameDir,'state.json')), oldId=manager.snapshot().gameId;
    const count=f.calls(), request=body(manager,kind);
    manager.command(request);assert.equal(manager.command(request).requestId,request.requestId);
    const receipt=await settle(manager,request.requestId);
    assert.equal(receipt.status,'succeeded');
    assert.equal(receipt.recovery.kind,'abort-unrecoverable');assert.equal(receipt.recovery.gameId,oldId);
    assert.equal(receipt.recovery.mode,'abort');
    const after=read(path.join(f.gameDir,'state.json'));
    assert.equal(after.result,'abort');
    for(const key of ['seats','lastHand','config','sessionToken','policySeed'])assert.deepEqual(after[key],before[key],key);
    if(kind==='end'){
      assert.equal(manager.snapshot().state,'ended');assert.equal(f.calls(),count);
      assert.throws(()=>manager.command(body(manager,'end')),{code:'INVALID_TRANSITION'});
    }else{
      assert.equal(manager.snapshot().state,'playing');assert.notEqual(manager.snapshot().gameId,oldId);
      assert.notEqual(read(path.join(manager.current.sessionDir,'state.json')).result,'abort');
    }
  });
});
test('#197 accepted recovery journals finish end or restart parked, never replaying the abandoned decision',{timeout:TIMEOUT},async t=>{
  for(const kind of ['end','restart'])await t.test(kind,async st=>{
    const f=await damagedStore(st), s=f.manager.snapshot(), request=body(f.manager,kind);
    const row={...request,setup:s.setup,payload:JSON.stringify(request),status:'accepted',
      recovery:{kind:'abort-unrecoverable',mode:'abort',gameId:s.gameId,selectionVersion:s.selectionVersion,gameEpoch:s.gameEpoch}};
    await f.manager.close();
    write(path.join(f.root,'.app','commands',request.requestId+'.json'),row);
    const restored=createSessionManager({storeDir:f.root,resolver:f.resolver});st.after(()=>restored.close());
    await restored.initialize();
    assert.equal(restored.receipt(request.requestId).status,'succeeded');
    assert.equal(restored.snapshot().state,kind==='end'?'ended':'paused');
    assert.equal(read(path.join(f.gameDir,'state.json')).result,'abort');
    if(kind==='restart')assert.notEqual(restored.snapshot().gameId,s.gameId);
  });
});
test('#197 preflight rejects stale selector or epoch before loop and reference writes',{timeout:TIMEOUT},async t=>{
  const f=await damagedStore(t), s=f.manager.snapshot();await f.manager.close();
  const names=['state.json','loop-state.json','reference-source.json'];
  const before=names.map(name=>fs.readFileSync(path.join(f.gameDir,name)));
  const expected={gameId:s.gameId,selectionVersion:s.selectionVersion,gameEpoch:s.gameEpoch};
  for(const change of [{gameId:'foreign'},{selectionVersion:s.selectionVersion+1},{gameEpoch:'foreign'}]){
    await assert.rejects(prepareGameSession({storeDir:f.root,resume:true,expectedCurrent:{...expected,...change}},
      {resolver:f.resolver,loopOptions:{abortUnrecoverable:{operationId:'stale'}}}),{code:'CURRENT_CHANGED'});
    names.forEach((name,i)=>assert.deepEqual(fs.readFileSync(path.join(f.gameDir,name)),before[i],name));
    assert.equal(fs.existsSync(path.join(f.root,'loop.lock.d')),false);
  }
});
test('#197 a validated abort checkpoint permits end after a different recovery error',{timeout:TIMEOUT},async t=>{
  const f=await damagedStore(t);await f.manager.close();
  const failed=createGameLoop({gameDir:f.gameDir,lockDir:f.root,opts:{abortUnrecoverable:{operationId:'engine-cut'},
    onEngineInvoke:args=>{if(args[0]==='end')throw Object.assign(new Error('cut'),{code:'ENGINE_CUT'});}}});
  t.after(()=>failed.requestStop());
  await assert.rejects(failed.resume(),{code:'ENGINE_CUT'});
  const restored=createSessionManager({storeDir:f.root,resolver:f.resolver});t.after(()=>restored.close());
  await restored.initialize();
  assert.equal(restored.snapshot().error,'SESSION_RECOVERABLE');
  assert.deepEqual(restored.snapshot().recoveryExit,{mode:'abort'});
  const request=body(restored,'end');restored.command(request);
  assert.equal((await settle(restored,request.requestId)).status,'succeeded');
  assert.equal(read(path.join(f.gameDir,'state.json')).abortOperationId,'engine-cut');
});
test('#197 resume of an already aborted target consumes GAME_ENDED without running after lock release',{timeout:TIMEOUT},async t=>{
  const f=await damagedStore(t);
  await promisify(execFile)(process.execPath,[path.resolve('engine/cli.js'),'end','--result','abort','--operation-id','external-end','--game-dir',f.gameDir]);
  const request=body(f.manager,'resume');f.manager.command(request);
  assert.equal((await settle(f.manager,request.requestId)).status,'succeeded');
  assert.equal(f.manager.snapshot().state,'ended');
  const before=fs.readFileSync(path.join(f.gameDir,'loop-state.json'));
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir,'loop-state.json')),before);
});
test('#197 finalize end retains the engine outcome and finishes with no player decision',{timeout:TIMEOUT},async t=>{
  const f=await damagedStore(t,{phase:'finalizing',gameOver:true});
  const before=fs.readFileSync(path.join(f.gameDir,'state.json'));
  const request=body(f.manager,'end');f.manager.command(request);
  const row=await settle(f.manager,request.requestId);
  assert.equal(row.status,'succeeded');assert.equal(row.recovery.mode,'finalize');
  assert.equal(f.manager.snapshot().state,'completed');
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir,'state.json')),before);
});
test('#197 accepted recovery restart converges each reservation crash window to a fresh parked game with zero decisions',{timeout:TIMEOUT},async t=>{
  for(const window of ['no-reservation','reservation-saved','staging-written','selector-committed'])await t.test(window,async st=>{
    const f=await damagedStore(st),before=f.manager.snapshot(),request=body(f.manager,'restart');
    const row={...request,setup:before.setup,payload:JSON.stringify(request),status:'accepted',
      recovery:{kind:'abort-unrecoverable',mode:'abort',gameId:before.gameId,selectionVersion:before.selectionVersion,gameEpoch:before.gameEpoch}};
    await f.manager.close();
    if(window!=='no-reservation') {
      row.reservation={gameId:randomUUID(),selectionVersion:before.selectionVersion+1};
      await engineEnd(f.gameDir,request.requestId);
    }
    if(window==='staging-written'||window==='selector-committed')await stagePreparedRestart(f.root,row,{commit:window==='selector-committed'});
    write(path.join(f.root,'.app','commands',request.requestId+'.json'),row);
    const restored=createSessionManager({storeDir:f.root,resolver:f.resolver});st.after(()=>restored.close());
    await restored.initialize();
    const receipt=restored.receipt(request.requestId);
    assert.equal(receipt.status,'succeeded');
    assertParkedFreshGame(restored,before.gameId);
    assert.equal(read(path.join(f.gameDir,'state.json')).result,'abort');
  });
});
test('#197 an accepted recovery row whose selector is actually committed elsewhere fails CURRENT_CHANGED without touching the replacement game',{timeout:TIMEOUT},async t=>{
  const f=await damagedStore(t),before=f.manager.snapshot(),request=body(f.manager,'restart');
  const row={...request,setup:before.setup,payload:JSON.stringify(request),status:'accepted',
    recovery:{kind:'abort-unrecoverable',mode:'abort',gameId:before.gameId,selectionVersion:before.selectionVersion,gameEpoch:before.gameEpoch}};
  await f.manager.close();
  const replacementRow={...row,reservation:{gameId:randomUUID(),selectionVersion:before.selectionVersion+1}};
  const replacement=await stagePreparedRestart(f.root,replacementRow,{commit:true});
  const loopFile=path.join(replacement.sessionDir,'loop-state.json');
  const replacementEngine=read(path.join(replacement.sessionDir,'state.json'));
  write(loopFile,{phase:'bootstrap',sessionToken:replacementEngine.sessionToken,
    gameEpoch:createHash('sha256').update(replacementEngine.sessionToken).digest('hex')});
  const names=['state.json','loop-state.json','reference-source.json'];
  const bytes=names.map(name=>fs.readFileSync(path.join(replacement.sessionDir,name)));
  write(path.join(f.root,'.app','commands',request.requestId+'.json'),row);
  const restored=createSessionManager({storeDir:f.root,resolver:f.resolver});t.after(()=>restored.close());
  await restored.initialize();
  const receipt=restored.receipt(request.requestId);
  assert.equal(receipt.status,'failed');assert.equal(receipt.error,'CURRENT_CHANGED');
  names.forEach((name,index)=>assert.deepEqual(fs.readFileSync(path.join(replacement.sessionDir,name)),bytes[index],name));
});
