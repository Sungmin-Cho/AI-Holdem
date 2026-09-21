import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGameLoop,parseGameLoopArgs,prepareGameSession,initializePreparedSession} from '../tools/game-loop.js';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';

test('CLI accepts explicit pace and rejects unknown presets', () => {
  assert.equal(parseGameLoopArgs(['--pace','normal']).pace,'normal');
  assert.throws(()=>parseGameLoopArgs(['--pace','unexpected']),{code:'USAGE'});
  assert.equal(parseGameLoopArgs([]).pace,undefined);
});

for (const scenario of [{pace:'normal'}, {pace:'instant'}, {}, {pace:'normal',error:'LOCK_TIMEOUT'}, {pace:'normal',error:'ATTEMPT_PENDING'}, {pace:'normal',error:'BAD_ATTEMPT'}]) {
test(`pace ${scenario.pace ?? 'legacy'} preserves publish timing with ${scenario.error ?? 'no retry'}`, {timeout:process.platform==='win32'?300000:60000}, async t => {
  const root=createOwnedTempDir('holdem-pace-loop');
  let clock=Date.now();const waits=[],publishes=[];let injected=false;
  const {loop}=await prepareGameSession({gameDir:root,port:0,pace:scenario.pace,opponentRuntime:'policy'}, {resolver:async()=>({player:null,upper:null,notices:[]}),loopOptions:{
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
  const expectedHold=scenario.pace==='normal' && scenario.error!=='BAD_ATTEMPT';
  assert.equal(holds.length,expectedHold?1:0);
  const holdArgs=publishes.filter(args=>args.includes('--result-hold')).map(args=>args[args.indexOf('--result-hold')+1]);
  if (expectedHold) {
    assert.equal(holds[0].hold.handNo,1);
    assert.equal(Date.parse(holds[0].hold.until)-Date.parse(holds[0].hold.startAt),3500+800*holds[0].hold.runoutStreets);
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
    assert.equal(waits.length,0);
  }
  for(const args of publishes.filter(args=>args.includes('--view-only')))assert.equal(args.includes('--result-hold'),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'ui-snapshot.json'))).resultHold,null);
  assert.deepEqual(loop.skipHandResult(1),{skipped:false});
});
}

async function managedPaceFixture(t, targetKind, {multi=false,afterHand=0,beforeWait=null}={}) {
  const root=createOwnedTempDir('holdem-pace-controls');
  let clock=Date.now(),first=true,enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const waits=[];
  const loop=createGameLoop({gameDir:root,resolver:async()=>({player:null,upper:null,notices:[]}),opts:{
    port:0,controlProtocolVersion:1,opponentRuntime:'policy',pace:'normal',now:()=>new Date(clock),
    onCoachInvoke:args=>{
      if(!beforeWait || !first || !args.includes('heartbeat'))return;
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
  t.after(async()=>{clearInterval(timer);await loop.requestStop();await running;});
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
