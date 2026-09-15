import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createSessionManager} from '../tools/session-manager.js';
import * as contract from '../shared/session-control-contract.js';

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
  if(gameOver)write(engineFile,{...read(engineFile),gameOver:true,result:'win'});
  const loopFile=path.join(gameDir,'loop-state.json');
  write(loopFile,{...read(loopFile),phase,pendingDecision:{schemaVersion:1,gameEpoch:'foreign',generation:1,status:'running'}});
  manager=createSessionManager({storeDir:root,resolver});
  await manager.initialize();
  assert.equal(manager.snapshot().error,'SESSION_RECOVERABLE');
  const resume=body(manager,'resume');manager.command(resume);
  assert.equal((await settle(manager,resume.requestId)).error,'BAD_PLAYER_RECOVERY');
  return {manager,root,gameDir,resolver,calls:()=>calls};
}

test('#197 S6 recovery exit gate follows engine/loop phases without exposing commands yet',{timeout:TIMEOUT},async t=>{
  assert.deepEqual(contract.ABORTABLE_ERROR_CODES,['BAD_PLAYER_RECOVERY']);
  assert.equal(Object.isFrozen(contract.ABORTABLE_ERROR_CODES),true);
  for(const [phase,gameOver,mode] of [['playing',false,'abort'],['playing',true,'finalize'],['finalizing',true,'finalize']])await t.test(`${phase}-${gameOver}`,async st=>{
    const {manager}=await damagedStore(st,{phase,gameOver});
    assert.equal(manager.snapshot().state,'error');
    assert.deepEqual(manager.snapshot().recoveryExit,{mode});
    assert.deepEqual(manager.snapshot().allowedCommands,['resume']);
  });
});
