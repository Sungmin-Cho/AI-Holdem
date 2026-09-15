import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createOwnedTempDir} from '../test/helpers/owned-fixtures.mjs';
const baseline=fs.realpathSync(process.env.HOLDEM_BASELINE);
const commit=execFileSync('git',['-C',baseline,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(commit,'ddcabe22f82b2fb5fc6d9a2d423b754f33b627ff');
const load=rel=>import(pathToFileURL(path.join(baseline,rel)).href);
const {createGameLoop,initializePreparedSession}=await load('tools/game-loop.js');
const {createSessionManager}=await load('tools/session-manager.js');
const {prepareSession,commitSession}=await load('engine/session-catalog.js');
const {sealPreparation}=await load('tools/session-preparation.js');
const {resolveSessionReference}=await load('tools/reference-source.js');
const {normalizeSetup}=await load('shared/game-setup.js');
const {inspectStudyService,stopStudyService}=await load('tools/study-service.js');
const read=file=>JSON.parse(fs.readFileSync(file));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const epoch=token=>createHash('sha256').update(token).digest('hex');
const resolver=async()=>({player:null,upper:null,notices:[]});
const results=[];
async function stopStudy(root){const s=await inspectStudyService(root);if(s.status==='running')await stopStudyService(root,{expectedInstanceId:s.instanceId});}
async function seedStore(t){
  const root=createOwnedTempDir('old-recovery-store');
  const reservation={gameId:randomUUID(),selectionVersion:1};
  const p=prepareSession(root,reservation);
  const setup=normalizeSetup({aiCount:1,opponentRuntime:'policy'});
  const initialized=await initializePreparedSession(p.stagingDir,{ai:1,mode:'cash-training',hands:20,opponentRuntime:'policy'});
  resolveSessionReference(p.stagingDir,{createNew:true});sealPreparation(p,initialized);
  const current=commitSession(root,p);
  write(path.join(current.sessionDir,'.app-setup.json'),setup);
  const engine=read(path.join(current.sessionDir,'state.json'));engine.button=0;write(path.join(current.sessionDir,'state.json'),engine);
  write(path.join(current.sessionDir,'loop-state.json'),{phase:'playing',sessionToken:engine.sessionToken,gameEpoch:epoch(engine.sessionToken),opponentRuntime:'policy'});
  t.after(()=>stopStudy(root));
  return {root,current,setup};
}
function checkpoint(gameDir){
  const raw=fs.readFileSync(path.join(gameDir,'loop-state.json'));
  const operationId='old-exit',sidecar='loop-state.abandoned.old-exit.json';
  fs.writeFileSync(path.join(gameDir,sidecar),raw);
  write(path.join(gameDir,'loop-state.json'),{...JSON.parse(raw),aborting:{operationId,mode:'abort'},
    abandonedPendingDecision:{operationId,mode:'abort',sidecar,sha256:epoch(raw),unverifiedSnapshot:false,reason:'BAD_PLAYER_RECOVERY'}});
}
function accepted(root,current,setup,kind,extra={}){
  const body={requestId:randomUUID(),kind,expectedInstanceId:'capture',expectedAppRevision:0,
    expectedGameId:current.gameId,expectedSelectionVersion:current.selectionVersion};
  const row={...body,setup,payload:JSON.stringify(body),status:'accepted',...extra};
  fs.mkdirSync(path.join(root,'.app','commands'),{recursive:true});
  write(path.join(root,'.app','commands',body.requestId+'.json'),row);return row;
}
test('capture actual ddcabe2 legacy-loop and managed recovery compatibility',{timeout:180000},async t=>{
  for(const kind of ['snapshot-only','fresh-authorization','checkpoint-playing'])await t.test('legacy-'+kind,async st=>{
    const gameDir=createOwnedTempDir('old-recovery-legacy');
    const loop=createGameLoop({gameDir,resolver,opts:{port:0,waitMs:0,opponentRuntime:'policy'}});
    await loop.bootstrap({ai:1,stack:100,opponentRuntime:'policy'});await loop.requestStop();
    const engine=read(path.join(gameDir,'state.json'));engine.button=0;write(path.join(gameDir,'state.json'),engine);
    const file=path.join(gameDir,'loop-state.json');
    if(kind==='snapshot-only')fs.writeFileSync(path.join(gameDir,'loop-state.unverified.json'),'unverified raw evidence');
    if(kind==='fresh-authorization')write(file,{...read(file),pendingDecision:{schemaVersion:1,gameEpoch:epoch(engine.sessionToken),
      generation:1,status:'retry_authorized',closeConfirmed:true,decisionId:'d-1-preflop-0',playerId:'p1',stateVersion:engine.stateVersion,
      freshAuthorization:{source:'app',requestId:'old-grant'}}});
    if(kind==='checkpoint-playing')checkpoint(gameDir);
    let actions=0;
    const resumed=createGameLoop({gameDir,resolver,opts:{port:0,waitMs:0,opponentRuntime:'policy',onEngineInvoke:args=>{if(args[0]==='step'&&args.includes('--expect-version'))actions++;}}});
    st.after(()=>resumed.requestStop());
    await resumed.resume();
    if(kind==='checkpoint-playing'){
      const running=resumed.run();running.catch(()=>{});
      const until=Date.now()+10000;
      while(actions===0&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
      await resumed.requestStop();await running.catch(error=>{if(error.code!=='STOPPING')throw error;});
      assert.ok(actions>0);
    }
    const state=read(file);
    results.push({case:kind,entrypoint:'legacy-loop-api',phase:state.phase,actions,
      freshAuthorizationRetained:!!state.pendingDecision?.freshAuthorization,abortingRetained:!!state.aborting});
  });
  for(const scenario of ['checkpoint-playing','aborted-no-row','aborted-end','aborted-restart','restart-reservation','restart-staging','restart-committed'])await t.test('app-'+scenario,async st=>{
    const f=await seedStore(st);checkpoint(f.current.sessionDir);
    if(scenario!=='checkpoint-playing')execFileSync(process.execPath,[path.join(baseline,'engine/cli.js'),'end','--result','abort','--operation-id','old-exit','--game-dir',f.current.sessionDir]);
    let row;
    if(scenario!=='aborted-no-row'){
      const kind=scenario==='checkpoint-playing'?'resume':scenario==='aborted-end'?'end':'restart';
      const extra={};
      if(scenario.startsWith('restart-'))extra.reservation={gameId:randomUUID(),selectionVersion:2};
      if(['restart-staging','restart-committed'].includes(scenario)){
        const p=prepareSession(f.root,extra.reservation);
        const initialized=await initializePreparedSession(p.stagingDir,{ai:1,mode:'cash-training',hands:20,opponentRuntime:'policy'});
        resolveSessionReference(p.stagingDir,{createNew:true});sealPreparation(p,initialized);
        if(scenario==='restart-committed')commitSession(f.root,p);
      }
      row=accepted(f.root,f.current,f.setup,kind,extra);
    }
    const manager=createSessionManager({storeDir:f.root,resolver});st.after(()=>manager.close());
    await manager.initialize();const s=manager.snapshot();
    const currentEngine=read(path.join(manager.current.sessionDir,'state.json'));
    results.push({case:scenario,entrypoint:'managed-initialize',state:s.state,receiptStatus:row?manager.receipt(row.requestId).status:null,
      newGame:s.gameId!==f.current.gameId,currentEngineAborted:currentEngine.result==='abort',actions:(currentEngine.hand?.actions??[]).length});
    assert.equal(s.state,scenario==='aborted-no-row'||scenario==='aborted-end'?'ended':'paused');
  });
  console.log('COMPATIBILITY_CAPTURE '+JSON.stringify({baselineCommit:commit,cases:results}));
});
