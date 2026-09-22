import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {createGameLoop,prepareGameSession} from '../tools/game-loop.js';
import {createJevRuntime} from '../tools/jev-runtime.js';
import {validJevPending} from '../shared/jev-pending.js';
import {JEV_CONFIG} from '../shared/opponent-runtime.js';
const SCALE=process.platform==='win32'?10:1;
const read=(dir,file)=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
const resolver=async({need})=>{assert.equal(need,'upper-only');return {player:null,upper:null,notices:[]};};
async function wait(fn,ms=10000){const end=Date.now()+ms*SCALE;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw new Error('wait timeout');}
function fakeClient(calls){return {async systemOne({state,questions}){calls.push(state);const keys=Object.keys(questions.action.criteria);const choice=keys.includes('check')?'check':keys.includes('call')?'call':keys[0];return {model:JEV_CONFIG.model,answers:{action:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,Number(k===choice)]))}}};}};}
async function drive(dir,loop){const running=loop.run();running.catch(()=>{});const sent=new Set();await wait(async()=>{
 const ls=read(dir,'loop-state.json');if(ls.phase==='done')return true;if(ls.pendingDecision?.status==='recovery_required')throw new Error(JSON.stringify(ls.pendingDecision));
 try { const lock=read(dir,'lock.json');const res=await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`);const snap=await res.json();const legal=snap.view?.legal;
 if(legal?.toAct==='user'&&!sent.has(legal.decisionId)){sent.add(legal.decisionId);await fetch(`http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decisionId:legal.decisionId,action:legal.canCheck?'check':'call'})});}
 } catch(error) {if(!read(dir,'state.json').gameOver)throw error;await running;return true;}
 return read(dir,'loop-state.json').phase==='done';
 },30000);await running;}
test('table-wide JEV plays a full hand, no CLI sessions, private diagnostics only', {timeout:45000*SCALE},async t=>{
 const dir=createOwnedTempDir('jev-full-hand'),calls=[];
 const loop=createGameLoop({gameDir:dir,resolver,opts:{port:0,waitMs:40,opponentRuntime:'jev',jevPreflight:async()=>{},createJevRuntime:options=>createJevRuntime({...options,client:fakeClient(calls)})}});
 t.after(()=>loop.requestStop());await loop.bootstrap({ai:2,mode:'cash-training',stackBb:100,blinds:'25/50',hands:1});
 assert.deepEqual(read(dir,'state.json').config.jev,JEV_CONFIG);assert.equal(fs.existsSync(path.join(dir,'.player-sessions.json')),false);
 await drive(dir,loop);assert.ok(calls.length>=2);assert.ok(new Set(calls.map(s=>s.actor)).size>=2);
 const state=read(dir,'loop-state.json');assert.equal(state.phase,'done');assert.ok(state.jevDiagnostics.entries.length>0);assert.ok(state.metrics.every(m=>!m.probabilities&&!m.confidence));
 assert.equal(state.pendingDecision,undefined);
});
test('loop-state loss restores pinned JEV without SDK preflight or player warmup', {timeout:15000*SCALE},async t=>{
 const dir=createOwnedTempDir('jev-resume');execFileSync(process.execPath,['engine/cli.js','init','--ai','1','--opponent-runtime','jev','--game-dir',dir]);
 const loop=createGameLoop({gameDir:dir,resolver,opts:{port:0,jevPreflight:()=>{throw new Error('must not preflight');}}});t.after(()=>loop.requestStop());
 assert.equal((await loop.resume()).opponentRuntime,'jev');
});
test('JEV preflight failure precedes store creation and reservation',async()=>{
 const parent=createOwnedTempDir('jev-preflight'),dir=path.join(parent,'store');let reserved=false;
 await assert.rejects(prepareGameSession({storeDir:dir,opponentRuntime:'jev',ai:2},{loopOptions:{jevPreflight:async()=>{throw Object.assign(new Error('missing'),{code:'JEV_API_KEY_MISSING'});}},onReserve:()=>{reserved=true;}}),{code:'JEV_API_KEY_MISSING'});
 assert.equal(reserved,false);assert.equal(fs.existsSync(dir),false);
});
test('pending v3 accepts running without retryable but rejects CLI fields and malformed recovery',()=>{
 const p={schemaVersion:3,runtime:'jev',executionKind:'http',gameEpoch:'e',decisionId:'d',playerId:'p',stateVersion:2,generation:1,status:'running',budget:{softMs:25,hardMs:300},startedAt:new Date().toISOString()};
 assert.ok(validJevPending(p));assert.equal(validJevPending({...p,diagnostics:{}}),false);assert.equal(validJevPending({...p,status:'recovery_required'}),false);assert.ok(validJevPending({...p,status:'recovery_required',retryable:true}));
 assert.equal(validJevPending({...p,status:'recovery_required',retryable:true,closeConfirmed:true,proposedAction:{action:'call'}}),false);
 assert.equal(validJevPending({...p,proposedAction:null}),false);
});
async function aiFirst(t,client,{softMs=100,hardMs=3000,graceMs=2000,loopOpts={},beforeRun}={}){
 const dir=createOwnedTempDir('jev-recovery');const loop=createGameLoop({gameDir:dir,resolver,opts:{port:0,waitMs:5000,opponentRuntime:'jev',controlProtocolVersion:1,playerBudget:{softMs:softMs*SCALE,hardMs:hardMs*SCALE},jevPreflight:async()=>{},createJevRuntime:options=>createJevRuntime({...options,client,graceMs}),...loopOpts}});
 t.after(()=>loop.requestStop());await loop.bootstrap({ai:1,stack:5000});const engine=read(dir,'state.json');engine.button=0;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(engine));
 beforeRun?.(dir,loop);const running=loop.run();running.catch(()=>{});return {dir,loop,running};
}
test('soft wait interrupt pauses, requires explicit retry, fresh session denied and retry is exactly once', {timeout:20000*SCALE},async t=>{
 let calls=0;const seen=[];const client={systemOne(request,{signal}){calls++;if(calls===1)return new Promise((r,j)=>signal.addEventListener('abort',()=>j(new Error('secret')),{once:true}));return fakeClient(seen).systemOne(request);}};
 const {dir,loop,running}=await aiFirst(t,client,{softMs:500,hardMs:4000});
 await wait(()=>calls===1);const p=loop.pendingDecision;
 assert.deepEqual(await loop.interruptDecision(p),{interrupted:false});await wait(()=>loop.pendingDecision?.softWait);
 assert.deepEqual(await loop.interruptDecision(p),{interrupted:true});await wait(()=>loop.playState==='paused');
 assert.equal(loop.pendingDecision.retryable,true);assert.equal(validJevPending(loop.pendingDecision),true);
 await assert.rejects(loop.resumePlay(),{code:'PLAYER_RECOVERY_REQUIRED'});
 await assert.rejects(loop.retryDecision(p.decisionId,{freshAuthorization:{source:'app',requestId:'x'}}),{code:'BAD_FRESH_AUTHORIZATION'});
 await loop.retryDecision(p.decisionId);await wait(()=>!loop.pendingDecision);
 assert.equal(calls,2);assert.equal(read(dir,'state.json').hand.actions.filter(a=>a.decisionId===p.decisionId).length,1);
 await loop.requestStop();await running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
});
test('hard deadline preserves recoverable request, stop abort never applies response', {timeout:20000*SCALE},async t=>{
 const client={systemOne(request,{signal}){return new Promise((r,j)=>signal.addEventListener('abort',()=>j(new Error('raw-secret')),{once:true}));}};
 const {loop,running,dir}=await aiFirst(t,client,{softMs:20,hardMs:200});await wait(()=>loop.pendingDecision?.status==='recovery_required');
 assert.equal(loop.pendingDecision.code,'JEV_TIMEOUT');assert.equal(loop.pendingDecision.closeConfirmed,true);assert.equal(loop.pendingDecision.retryable,true);
 assert.equal(read(dir,'state.json').hand.actions.length,0);await loop.requestStop();await running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
});
test('late settle repairs only closure and never applies revoked response', {timeout:20000*SCALE},async t=>{
 let release;const client={systemOne(request){return new Promise(resolve=>{release=()=>fakeClient([]).systemOne(request).then(resolve);});}};
 const {loop,running,dir}=await aiFirst(t,client,{softMs:20,hardMs:3000,graceMs:30});await wait(()=>release&&loop.pendingDecision?.softWait);
 const p=loop.pendingDecision;assert.deepEqual(await loop.interruptDecision(p),{interrupted:false});
 assert.equal(loop.pendingDecision.status,'unsafe');assert.equal(loop.pendingDecision.closeConfirmed,false);
 await assert.rejects(loop.retryDecision(p.decisionId));await assert.rejects(loop.endGame('end'));
 await release();await wait(()=>loop.pendingDecision?.status==='recovery_required');assert.equal(loop.pendingDecision.retryable,true);
 assert.equal(read(dir,'state.json').hand.actions.length,0);await loop.requestStop();await running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
});

test('crashed HTTP without proposal recovers; uncertain engine proposal remains unsafe', {timeout:30000*SCALE},async t=>{
 for(const kind of ['running','unsafe','retry_authorized','proposed','applied'])await t.test(kind,async st=>{
  const dir=createOwnedTempDir('jev-crash');execFileSync(process.execPath,['engine/cli.js','init','--ai','1','--opponent-runtime','jev','--game-dir',dir]);
  let engine=read(dir,'state.json');engine.button=0;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(engine));
  const out=JSON.parse(execFileSync(process.execPath,['engine/cli.js','step','--new-hand','--game-dir',dir]));engine=read(dir,'state.json');
  const {gameEpochOf}=await import('../publish-contract.js');
  const pending={schemaVersion:3,runtime:'jev',executionKind:'http',gameEpoch:gameEpochOf(engine.sessionToken),decisionId:out.next.decisionId,playerId:out.next.toAct,stateVersion:out.stateVersion,generation:1,status:['proposed','applied'].includes(kind)?'running':kind,budget:{softMs:25,hardMs:300},startedAt:new Date().toISOString(),
   ...(kind==='unsafe'?{code:'JEV_REQUEST_CLOSE_UNCONFIRMED',retryable:false,closeConfirmed:false}:{}),...(kind==='retry_authorized'?{retryable:true,closeConfirmed:true}:{}),...(['proposed','applied'].includes(kind)?{proposedAction:{action:'call'},closeConfirmed:kind!=='applied'}:{})};
  if(kind==='applied')execFileSync(process.execPath,['engine/cli.js','step',pending.playerId,'call','--expect-version',String(pending.stateVersion),'--game-dir',dir]);
  fs.writeFileSync(path.join(dir,'loop-state.json'),JSON.stringify({phase:'playing',opponentRuntime:'jev',jev:JEV_CONFIG,sessionToken:engine.sessionToken,gameEpoch:pending.gameEpoch,pendingDecision:pending,metrics:[],notices:[]}));
  const loop=createGameLoop({gameDir:dir,resolver,opts:{port:0,controlProtocolVersion:1}});st.after(()=>loop.requestStop());await loop.resume();
  if(kind==='applied'){assert.equal(loop.pendingDecision,null);return;}
  assert.equal(loop.pendingDecision.status,kind==='proposed'?'unsafe':'recovery_required');assert.equal(loop.pendingDecision.retryable,kind!=='proposed');assert.ok(validJevPending(loop.pendingDecision));
 });
});
test('pause lets its owned JEV decision complete once; stop revokes a valid late response', {timeout:20000*SCALE},async t=>{
 for(const stopping of [false,true])await t.test(stopping?'stop':'pause',async st=>{
  let release;const client={systemOne(request){return new Promise(resolve=>{release=()=>fakeClient([]).systemOne(request).then(resolve);});}};
  const {loop,running,dir}=await aiFirst(st,client,{softMs:1000,hardMs:5000});await wait(()=>release);
  const id=loop.pendingDecision.decisionId;const pending=stopping?loop.requestStop():loop.pause();
  await release();await pending;
  const actions=read(dir,'state.json').hand.actions.filter(a=>a.decisionId===id);
  assert.equal(actions.length,stopping?0:1);
  if(!stopping){assert.equal(loop.playState,'paused');await loop.endGame('test-pause-end');}
  await running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
 });
});
test('unconfirmed stop holds ownership; trusted late settle repeats full cleanup and releases lock', {timeout:20000*SCALE},async t=>{
 let release;const client={systemOne(request){return new Promise(resolve=>{release=()=>fakeClient([]).systemOne(request).then(resolve);});}};
 const {loop,running,dir}=await aiFirst(t,client,{softMs:1000,hardMs:5000,graceMs:30});await wait(()=>release);
 await assert.rejects(loop.requestStop(),{code:'JEV_REQUEST_CLOSE_UNCONFIRMED'});
 assert.equal(fs.existsSync(path.join(dir,'loop.lock.d')),true);assert.equal(loop.pendingDecision.closeConfirmed,false);
 await release();await wait(()=>!fs.existsSync(path.join(dir,'loop.lock.d')));
 assert.equal(read(dir,'state.json').hand.actions.length,0);assert.equal(loop.pendingDecision.status,'recovery_required');
 assert.equal(read(dir,'loop-state.json').cleanupError,undefined);await running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
});
test('pending write failure makes zero provider calls and zero engine actions', {timeout:20000*SCALE},async t=>{
 let calls=0,restore;const client={systemOne(){calls++;throw new Error('must not call');}};
 const f=await aiFirst(t,client,{beforeRun(dir){const original=fs.renameSync;restore=()=>{fs.renameSync=original;};fs.renameSync=function(from,to,...rest){
  if(to===path.join(dir,'loop-state.json')&&read(path.dirname(from),path.basename(from)).pendingDecision?.status==='running'){restore();throw Object.assign(new Error('injected write failure'),{code:'EIO'});}
  return original.call(this,from,to,...rest);
 };}});
 try {await assert.rejects(f.running,{code:'EIO'});assert.equal(calls,0);assert.equal(read(f.dir,'state.json').hand.actions.length,0);}finally{restore();}
});
test('peek version mismatch clears only owned unstarted pending and resyncs without HTTP', {timeout:20000*SCALE},async t=>{
 let calls=0,loop,failed=false,synced=false;
 const f=await aiFirst(t,{systemOne(){calls++;throw new Error('must not call');}},{loopOpts:{onEngineInvoke(args){if(args[0]==='decision-peek'&&!failed){failed=true;assert.ok(validJevPending(loop.pendingDecision));throw Object.assign(new Error('injected stale peek'),{code:'VERSION_MISMATCH'});}},log(row){if(row.event==='version-resync'){synced=true;assert.equal(loop.pendingDecision,null);void loop.requestStop();}}},beforeRun(dir,value){loop=value;}});
 await f.running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});assert.equal(synced,true);assert.equal(calls,0);assert.equal(read(f.dir,'state.json').hand.actions.length,0);
});
test('engine commits then response is lost: resume reconciles proposal without another inference', {timeout:20000*SCALE},async t=>{
 const calls=[];let applied=false;
 const f=await aiFirst(t,fakeClient(calls),{loopOpts:{onEngineInvoke(args){if(args[0]==='step'&&args[1]==='p1'&&!applied){applied=true;execFileSync(process.execPath,['engine/cli.js',...args]);throw Object.assign(new Error('lost CLI response'),{code:'EIO'});}}}});
 await wait(()=>f.loop.pendingDecision?.status==='unsafe');assert.equal(calls.length,1);assert.equal(f.loop.pendingDecision.closeConfirmed,true);
 await f.loop.requestStop();await f.running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
 const restored=createGameLoop({gameDir:f.dir,resolver,opts:{port:0,controlProtocolVersion:1}});t.after(()=>restored.requestStop());await restored.resume();assert.equal(restored.pendingDecision,null);assert.equal(calls.length,1);assert.equal(read(f.dir,'state.json').hand.actions.length,1);
});
test('uncertain engine proposal can only end, without another provider call', {timeout:20000*SCALE},async t=>{
 const calls=[];const f=await aiFirst(t,fakeClient(calls),{loopOpts:{onEngineInvoke(args){if(args[0]==='step'&&args[1]==='p1')throw Object.assign(new Error('engine rejected before spawn'),{code:'EIO'});}}});
 await wait(()=>f.loop.pendingDecision?.status==='unsafe'&&f.loop.playState==='paused');assert.equal(f.loop.pendingDecision.code,'JEV_ENGINE_APPLY_UNCONFIRMED');
 await assert.rejects(f.loop.retryDecision(f.loop.pendingDecision.decisionId));await f.loop.endGame('uncertain-proposal-end');await f.running;
 assert.equal(calls.length,1);assert.equal(read(f.dir,'state.json').result,'abort');assert.equal(f.loop.pendingDecision,null);
});
test('corrupt optional diagnostics are quarantined without preventing owned stop', {timeout:20000*SCALE},async t=>{
 let release;const f=await aiFirst(t,{systemOne(request){return new Promise(resolve=>{release=()=>fakeClient([]).systemOne(request).then(resolve);});}},{softMs:1000,hardMs:5000});await wait(()=>release);
 const file=path.join(f.dir,'loop-state.json'),state=read(f.dir,'loop-state.json');state.jevDiagnostics={schemaVersion:999,entries:'bad',dropped:-1};fs.writeFileSync(file,JSON.stringify(state));
 const stopping=f.loop.requestStop();await release();await stopping;await f.running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
 assert.equal(fs.existsSync(path.join(f.dir,'loop.lock.d')),false);assert.deepEqual(read(f.dir,'loop-state.json').jevDiagnostics,{schemaVersion:1,entries:[],dropped:0,historyIncomplete:true});
});
test('compound stop failures remain visible and forbid automatic late-settlement cleanup', {timeout:20000*SCALE},async t=>{
 let release;const f=await aiFirst(t,{systemOne(request){return new Promise(resolve=>{release=()=>fakeClient([]).systemOne(request).then(resolve);});}},{softMs:1000,hardMs:5000,graceMs:30});await wait(()=>release);
 const original=fs.closeSync,logStat=fs.statSync(path.join(f.dir,'loop.log'));let failed=false;
 fs.closeSync=function(fd,...rest){const stat=fs.fstatSync(fd);if(!failed&&stat.ino===logStat.ino&&stat.dev===logStat.dev){failed=true;throw Object.assign(new Error('injected log close failure'),{code:'EIO'});}return original.call(this,fd,...rest);};
 try{await assert.rejects(f.loop.requestStop(),{code:'JEV_REQUEST_CLOSE_UNCONFIRMED'});}finally{fs.closeSync=original;}
 const cleanup=read(f.dir,'loop-state.json').cleanupError;assert.equal(cleanup.details.jevClosureOnly,false);assert.deepEqual(cleanup.details.stopFailures.map(e=>e.code),['JEV_REQUEST_CLOSE_UNCONFIRMED','EIO']);
 await release();await wait(()=>f.loop.pendingDecision?.status==='recovery_required');await new Promise(r=>setTimeout(r,100));
 assert.equal(fs.existsSync(path.join(f.dir,'loop.lock.d')),true);assert.deepEqual(read(f.dir,'loop-state.json').cleanupError,cleanup);
 await f.loop.requestStop();assert.equal(fs.existsSync(path.join(f.dir,'loop.lock.d')),false);
 const records=fs.readFileSync(path.join(f.dir,'loop.log'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(records.some(r=>r.event==='cleanup-failed'&&r.details?.stopFailures?.some(e=>e.code==='EIO')));
 await f.running.catch(e=>{if(!['STOPPING','CHILD_FAILED'].includes(e.code))throw e;});
});
