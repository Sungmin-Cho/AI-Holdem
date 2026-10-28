import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGameLoop,parseGameLoopArgs,prepareGameSession,initializePreparedSession} from '../tools/game-loop.js';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';

test('CLI accepts explicit pace and rejects unknown presets', () => {
  assert.equal(parseGameLoopArgs(['--pace','normal']).pace,'normal');
  assert.equal(parseGameLoopArgs(['--result-hold-sec','0']).resultHoldSec,0);
  assert.equal(parseGameLoopArgs(['--result-hold-sec','30']).resultHoldSec,30);
  assert.equal(Object.hasOwn(parseGameLoopArgs([]),'resultHoldSec'),false);
  for(const bad of ['31','-1','2.5','x'])assert.throws(()=>parseGameLoopArgs(['--result-hold-sec',bad]),{code:'USAGE'});
  assert.throws(()=>parseGameLoopArgs(['--pace','unexpected']),{code:'USAGE'});
  assert.equal(parseGameLoopArgs([]).pace,undefined);
});

for (const scenario of [{pace:'normal'}, {pace:'instant'}, {}, {pace:'instant',resultHoldSec:4}, {pace:'normal',resultHoldSec:0}, {pace:'normal',error:'LOCK_TIMEOUT'}, {pace:'normal',error:'ATTEMPT_PENDING'}, {pace:'normal',error:'BAD_ATTEMPT'}]) {
test(`pace ${scenario.pace ?? 'legacy'}${scenario.resultHoldSec!==undefined?` result ${scenario.resultHoldSec}s`:''} preserves publish timing with ${scenario.error ?? 'no retry'}`, {timeout:process.platform==='win32'?300000:60000}, async t => {
  const root=createOwnedTempDir('holdem-pace-loop');
  let clock=Date.now();const waits=[],publishes=[];let injected=false;
  const {loop}=await prepareGameSession({gameDir:root,port:0,pace:scenario.pace,...(scenario.resultHoldSec!==undefined?{resultHoldSec:scenario.resultHoldSec}:{}),opponentRuntime:'policy'}, {resolver:async()=>({player:null,upper:null,notices:[]}),loopOptions:{
    waitMs:0,now:()=>new Date(clock),
    onPublishInvoke:args=>{
      publishes.push([...args]);
      if (scenario.error && !injected && args.includes('--result-hold')) {
        injected=true;clock+=2000;
        throw Object.assign(new Error('injected publish failure'),{code:scenario.error});
      }
    },
    paceSleep:async(ms,{signal,kind})=>{
      assert.equal(signal.aborted,false);
      const snapshot=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json')));
      waits.push({ms,kind,hold:snapshot.resultHold,handNo:snapshot.view.handNo});
      if(kind==='result') {
        assert.equal(snapshot.view.handInProgress,false);
        assert.equal(Date.parse(snapshot.resultHold.until)-clock,ms);
      }
      clock+=ms;
    },
  }});
  t.after(()=>loop.requestStop());
  await loop.bootstrap({ai:1,mode:'cash-training',hands:2,stackBb:100,opponentRuntime:'policy'});
  let posting = false;
  const timer = setInterval(async () => {
    if (posting) return;
    posting = true;
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json')));
      const legal = snap.view?.legal;
      if (snap.view?.toAct === 'user' && legal?.decisionId) {
        const lock = JSON.parse(fs.readFileSync(path.join(root,'lock.json')));
        await fetch(`http://127.0.0.1:${lock.port}/api/action`, {method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({token:lock.sessionToken,decisionId:legal.decisionId,requestId:randomUUID(),action:legal.canCheck?'check':'fold'})});
      }
    } catch {} finally {posting = false;}
  },20);
  t.after(()=>clearInterval(timer));
  try {await loop.run();} finally {clearInterval(timer);}

  const holds=waits.filter(w=>w.kind==='result');
  const holdMs=scenario.resultHoldSec!==undefined?scenario.resultHoldSec*1000:scenario.pace==='normal'?3500:0;
  const runoutMs=scenario.pace==='normal'?800:0;
  const expectedHold=holdMs>0 && scenario.error!=='BAD_ATTEMPT';
  assert.equal(holds.length,expectedHold?1:0);
  const allHoldArgs=publishes.filter(args=>args.includes('--result-hold')).map(args=>args[args.indexOf('--result-hold')+1]);
  const holdArgs=allHoldArgs.filter(arg=>arg.split('|')[0]==='1');
  // The hand that ends the game (hand 2) is held too, so the table shows it before the
  // final screen, but the loop neither sleeps on it (one 'result' wait, hand 1's) nor
  // lets a skip claim it.
  const finalHoldArgs=[...new Set(allHoldArgs.filter(arg=>arg.split('|')[0]==='2'))];
  assert.equal(allHoldArgs.length,holdArgs.length+allHoldArgs.filter(arg=>arg.split('|')[0]==='2').length);
  const finalSnapshot=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json')));
  assert.equal(finalSnapshot.view.gameOver,true);
  assert.ok(finalHoldArgs.length<=1,'one absolute deadline for the last hand');
  if (holdMs>0) assert.equal(finalHoldArgs.length,1,'the game-ending hand is held');
  if (finalHoldArgs.length) {
    const [,startAt,until,stepMs,streets]=finalHoldArgs[0].split('|');
    assert.equal(Date.parse(until)-Date.parse(startAt),holdMs+runoutMs*Number(streets));
    assert.equal(Number(stepMs),runoutMs);
    assert.deepEqual(finalSnapshot.resultHold,{handNo:2,startAt,until,runoutStepMs:Number(stepMs),runoutStreets:Number(streets)},
      'finalization keeps the last hand\'s hold');
  } else assert.equal(finalSnapshot.resultHold,null);
  assert.deepEqual(loop.skipHandResult(2),{skipped:false});
  if (expectedHold) {
    assert.equal(holds[0].hold.handNo,1);
    assert.equal(Date.parse(holds[0].hold.until)-Date.parse(holds[0].hold.startAt),holdMs+runoutMs*holds[0].hold.runoutStreets);
    assert.ok(holdArgs.length>0);
    assert.equal(new Set(holdArgs).size,1,'retry preserves the original absolute deadline');
    if(scenario.error && scenario.error!=='ATTEMPT_PENDING')assert.ok(holdArgs.length>=2);
    if(scenario.error==='ATTEMPT_PENDING')assert.ok(publishes.some(args=>args.includes('--retry')));
  } else if(scenario.error==='BAD_ATTEMPT') {
    assert.equal(holdArgs.length,1);
    const index=publishes.findIndex(args=>args.includes('--result-hold'));
    assert.ok(publishes[index+1].includes('--view-only'));
    assert.equal(publishes[index+1].includes('--result-hold'),false);
  } else {
    assert.equal(holdArgs.length,0);
    // Only the policy action interval can wait without a result hold.
    assert.equal(waits.filter(w=>w.kind!=='policy').length,0);
    if(scenario.pace!=='normal')assert.equal(waits.length,0);
  }
  for(const args of publishes.filter(args=>args.includes('--view-only')))assert.equal(args.includes('--result-hold'),false);
  assert.deepEqual(loop.skipHandResult(1),{skipped:false});
});
}

test('a skip cannot claim the game-ending hand\'s hold, which only the table waits on',{timeout:60000},async t=>{
  const root=createOwnedTempDir('holdem-final-hold');
  let clock=Date.now(),loopRef=null;const claims=[],waits=[];
  const {loop}=await prepareGameSession({gameDir:root,port:0,pace:'normal',opponentRuntime:'policy'}, {resolver:async()=>({player:null,upper:null,notices:[]}),loopOptions:{
    waitMs:0,now:()=>new Date(clock),
    // The hold is registered before the publisher runs: a skip here is what a click
    // during the publish would do. Hand 1's claim is the control.
    onPublishInvoke:args=>{
      const at=args.indexOf('--result-hold');
      if(at>=0){const handNo=Number(args[at+1].split('|')[0]);claims.push({handNo,...loopRef.skipHandResult(handNo)});}
    },
    paceSleep:async(ms,{kind})=>{waits.push(kind);clock+=ms;},
  }});
  loopRef=loop;
  t.after(()=>loop.requestStop());
  await loop.bootstrap({ai:1,mode:'cash-training',hands:2,stackBb:100,opponentRuntime:'policy'});
  let posting=false;
  const timer=setInterval(async()=>{
    if(posting)return;posting=true;
    try {
      const snap=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json'))),legal=snap.view?.legal;
      if(snap.view?.toAct==='user' && legal?.decisionId) {
        const lock=JSON.parse(fs.readFileSync(path.join(root,'lock.json')));
        await fetch(`http://127.0.0.1:${lock.port}/api/action`,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({token:lock.sessionToken,decisionId:legal.decisionId,requestId:randomUUID(),action:legal.canCheck?'check':'fold'})});
      }
    } catch {} finally {posting=false;}
  },20);
  t.after(()=>clearInterval(timer));
  try {await loop.run();} finally {clearInterval(timer);}
  assert.deepEqual(claims,[{handNo:1,skipped:true},{handNo:2,skipped:false}]);
  assert.equal(waits.filter(kind=>kind==='result').length,0,'the skipped hold and the final one: no result wait');
  const snapshot=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json')));
  assert.equal(snapshot.view.gameOver,true);assert.equal(snapshot.resultHold.handNo,2);
});

async function managedPaceFixture(t, targetKind, {multi=false,afterHand=0,beforeWait=null,publishFailure=false}={}) {
  const root=createOwnedTempDir('holdem-pace-controls');
  let clock=Date.now(),first=true,enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const waits=[];
  const loop=createGameLoop({gameDir:root,resolver:async()=>({player:null,upper:null,notices:[]}),opts:{
    port:0,controlProtocolVersion:1,opponentRuntime:'policy',pace:'normal',now:()=>new Date(clock),
    onPublishInvoke:args=>{
      if(publishFailure && args.includes('--result-hold')) {
        const handNo=Number(args[args.indexOf('--result-hold')+1].split('|')[0]);
        enteredResolve({handNo});
        throw Object.assign(Error('publisher retry exhausted'),{code:'LOCK_TIMEOUT'});
      }
      if(!['publish-skip','publish-pause'].includes(beforeWait) || !first || !args.includes('--result-hold'))return;
      first=false;
      const handNo=Number(args[args.indexOf('--result-hold')+1].split('|')[0]);
      enteredResolve({handNo,operation:beforeWait==='publish-skip'?loop.skipHandResult(handNo):loop.pause()});
    },
    onCoachInvoke:args=>{
      if(!['skip','pause'].includes(beforeWait) || !first || !args.includes('heartbeat'))return;
      const snapshot=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json')));
      if(!snapshot.resultHold || snapshot.view?.handInProgress)return;
      first=false;
      const handNo=snapshot.resultHold.handNo;
      const operation=beforeWait==='skip'?loop.skipHandResult(handNo):loop.pause();
      enteredResolve({handNo,operation});
    },
    paceSleep:async(ms,{signal,kind})=>{
      const state=JSON.parse(fs.readFileSync(path.join(root,'state.json')));
      waits.push({kind,handNo:state.handNo,ms});
      if(!beforeWait && first && kind===targetKind && state.handNo>afterHand) {
        first=false;
        await new Promise(resolve=>{
          signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();
          enteredResolve({signal,handNo:state.handNo,expire:()=>{clock+=ms;resolve();}});
        });
      } else clock+=ms;
    },
  }});
  const setup={ai:2,mode:'cash-training',hands:beforeWait?3:2,stackBb:100,opponentRuntime:'policy'};
  const preinitialized=multi?await initializePreparedSession(root,{...setup,participants:[{playerId:'h1',name:'게스트',participantId:'guest'}]}):undefined;
  await loop.bootstrap({...setup,preinitialized});
  let posting=false;
  const sent=new Set();
  const timer=setInterval(async()=>{
    if(posting)return;posting=true;
    try {
      const snap=JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json'))),actor=snap.view?.toAct;
      const lock=JSON.parse(fs.readFileSync(path.join(root,'lock.json')));
      const seatSnapshot=multi&&actor==='h1'?await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${encodeURIComponent(lock.sessionToken)}`,{headers:{'x-seat':actor}}).then(r=>r.json()):snap;
      const legal=seatSnapshot.view?.legal;
      if((actor==='user'||multi&&actor==='h1') && legal?.decisionId && !sent.has(legal.decisionId)) {
        const response=await fetch(`http://127.0.0.1:${lock.port}/api/action`,{method:'POST',headers:{'content-type':'application/json','x-seat':actor},
          body:JSON.stringify({token:lock.sessionToken,decisionId:legal.decisionId,requestId:randomUUID(),action:legal.canCheck?'check':'fold'})});
        if(response.ok)sent.add(legal.decisionId);
      }
    } catch {} finally {posting=false;}
  },20);
  const running=loop.run();running.catch(()=>{});
  t.after(async()=>{clearInterval(timer);await loop.requestStop();await running.catch(error=>{if(!publishFailure || error.code!=='LOCK_TIMEOUT')throw error;});});
  return {root,loop,running,entered,waits};
}

for(const kind of ['result','policy']) {
  test(`pause during ${kind} wait parks before another step; resume does not repeat the hold`,{timeout:60000},async t=>{
    const f=await managedPaceFixture(t,kind);const waiting=await f.entered;
    const before=fs.readFileSync(path.join(f.root,'state.json'),'utf8');
    assert.deepEqual(f.loop.skipHandResult(waiting.handNo+100),{skipped:false});
    assert.equal(waiting.signal.aborted,false);
    await f.loop.pause();
    assert.equal(waiting.signal.aborted,true);
    assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),before);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),before);
    await f.loop.resumePlay();await f.running;
    if(kind==='result')assert.equal(f.waits.filter(w=>w.kind==='result' && w.handNo===waiting.handNo).length,1);
  });
  test(`stop during ${kind} wait prevents a further engine step`,{timeout:60000},async t=>{
    const f=await managedPaceFixture(t,kind);const waiting=await f.entered;
    const before=fs.readFileSync(path.join(f.root,'state.json'),'utf8');
    await f.loop.requestStop();await f.running;
    assert.equal(waiting.signal.aborted,true);
    assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),before);
  });
}

test('skip ends only the matching active result hold and is stale after the next hand', {timeout:60000},async t=>{
  const f=await managedPaceFixture(t,'result');const waiting=await f.entered;
  assert.deepEqual(f.loop.skipHandResult(waiting.handNo),{skipped:true});
  assert.equal(waiting.signal.aborted,true);
  await f.running;
  assert.deepEqual(f.loop.skipHandResult(waiting.handNo),{skipped:false});
});


test('two human seats cannot skip the active result wait or advance early',{timeout:60000},async t=>{
  const f=await managedPaceFixture(t,'result',{multi:true}),waiting=await f.entered;
  assert.deepEqual(f.loop.skipHandResult(waiting.handNo),{skipped:false});
  assert.equal(waiting.signal.aborted,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state.json'))).handNo,waiting.handNo);
  waiting.expire();await f.running;
});

test('old result skip cannot cancel next-hand policy interval',{timeout:60000},async t=>{
  const f=await managedPaceFixture(t,'policy',{afterHand:1}),waiting=await f.entered;
  assert.equal(waiting.handNo,2);
  assert.deepEqual(f.loop.skipHandResult(1),{skipped:false});
  assert.equal(waiting.signal.aborted,false);
  waiting.expire();await f.running;
});

for(const operation of ['skip','pause']) {
  test(`${operation} during hand-end heartbeat acts before result wait registration`,{timeout:60000},async t=>{
    const f=await managedPaceFixture(t,'result',{beforeWait:operation});
    const entered=await f.entered;
    if(operation==='skip')assert.deepEqual(entered.operation,{skipped:true});
    else {
      await entered.operation;
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state.json'))).handNo,entered.handNo);
      await f.loop.resumePlay();
    }
    await f.running;
    assert.equal(f.waits.some(w=>w.kind==='result' && w.handNo===entered.handNo),false);
  });
}

test('skip before hand-end publisher ACK survives result wait registration', {timeout:60000},async t=>{
 const f=await managedPaceFixture(t,'result',{beforeWait:'publish-skip'});
 const entered=await f.entered;
 assert.deepEqual(entered.operation,{skipped:true});
 await f.running;
 assert.equal(f.waits.some(w=>w.kind==='result'&&w.handNo===entered.handNo),false);
});

test('failed repeated publisher recovery clears the registered hold', {timeout:60000},async t=>{
 const f=await managedPaceFixture(t,'result',{publishFailure:true});
 const entered=await f.entered;
 await assert.rejects(f.running,{code:'LOCK_TIMEOUT'});
 assert.deepEqual(f.loop.skipHandResult(entered.handNo),{skipped:false});
});
test('pause before hand-end publisher ACK survives result wait registration', {timeout:60000},async t=>{
 const f=await managedPaceFixture(t,'result',{beforeWait:'publish-pause'});
 const entered=await f.entered;
 await entered.operation;
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state.json'))).handNo,entered.handNo);
 await f.loop.resumePlay();await f.running;
 assert.equal(f.waits.some(w=>w.kind==='result'&&w.handNo===entered.handNo),false);
});
