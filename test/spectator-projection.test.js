import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createGame,startHand,applyAction,legalFor} from '../engine/hand.js';
import {newDeck} from '../engine/cards.js';
import {viewFor,spectatorView} from '../engine/views.js';
import {saveState,writeJsonAtomic} from '../engine/state.js';
import {startServer,loadUiState,publicSnapshot} from '../server/server.js';
import {viewerRole,SPECTATOR_ID} from '../shared/viewer-access.js';
import {startAppServer} from '../tools/app-server.js';
import {createRoomManager} from '../tools/room-manager.js';
import {createOwnedTempDir,registerOwnedServer} from './helpers/owned-fixtures.mjs';

const TOKEN='spectator-relay-token';
function game() {
  const state=createGame({aiCount:1,participants:[{playerId:'h1',name:'Guest',participantId:'guest'}],hostName:'Host',names:['AI']});
  state.sessionToken=TOKEN;state.button=2;
  return startHand(state,{deck:newDeck()}).state;
}

async function fixture(t,{fault}={}) {
  const dir=createOwnedTempDir('spectator-relay');
  const state=game();saveState(dir,state);
  writeJsonAtomic(path.join(dir,'players.json'),state.seats.map((s,i)=>({...s,seat:i,...(s.playerId==='h1'?{participantId:'guest'}:{})})));
  const relay=await startServer({gameDir:dir,port:0,token:TOKEN,publishCheckpoint:stage=>fault?.(stage)});
  registerOwnedServer(relay.server,'spectator-relay');t.after(()=>relay.close());
  const request=async(endpoint,{seat='user',body,headers={}}={})=>{
    const response=await fetch(`http://127.0.0.1:${relay.port}/api/${endpoint}?token=${TOKEN}`,{
      method:body?'POST':'GET',headers:{'x-seat':seat,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  // The relay initializes hint evidence with asynchronous file reads. This
  // in-process fixture must let that reader close before its synchronous engine
  // writes: Windows otherwise holds state.json open while renameSync retries
  // block the same event loop needed to finish the reader. A host snapshot waits
  // for initialization (no timer guess or weakening of atomic state writes).
  assert.equal((await request('snapshot')).status,200);
  let publishId=0;
  const publish=async(engine=state,events=[])=>{
    saveState(dir,engine);
    const views=Object.fromEntries(['user','h1'].map(id=>[id,viewFor(engine,id)]));
    return request('publish',{body:{token:TOKEN,publishId:++publishId,viewFor:'user',view:views.user,views,events}});
  };
  return {dir,state,relay,request,publish};
}

test('in-process fixture drains asynchronous startup readers before atomic engine writes',async t=>{
  const opened=new Set();
  let observedOpen;
  const startupRead=new Promise(resolve=>{observedOpen=resolve;});
  const realOpen=fs.promises.open.bind(fs.promises);
  const realRename=fs.renameSync.bind(fs);
  t.mock.method(fs.promises,'open',async(file,...args)=>{
    const handle=await realOpen(file,...args);
    if(path.basename(String(file))==='state.json') {
      const key=path.resolve(String(file));opened.add(key);observedOpen();
      const close=handle.close.bind(handle);
      handle.close=async()=>{await delay(100);try{return await close();}finally{opened.delete(key);}};
    }
    return handle;
  });
  t.mock.method(fs,'renameSync',(from,to)=>{
    if(opened.has(path.resolve(to)))throw Object.assign(Error('Windows reader sharing violation'),{code:'EPERM'});
    return realRename(from,to);
  });
  const f=await fixture(t);
  await startupRead;
  assert.equal(opened.size,0,'fixture readiness includes closing the hint startup reader');
  assert.equal((await f.publish()).status,200);
  assert.equal((await f.publish()).status,200);
});

test('spectator projection includes folded holes, never private state or future cards',()=>{
  const state=game();state.hand.folded.push('h1');
  const view=spectatorView(state);
  assert.deepEqual(view.holeCardsByPlayerId,state.hand.holes);
  assert.deepEqual(view.myCards,[]);assert.equal(view.viewer,null);
  for(const key of ['legal','deck','seed','sessionToken','hint','coach'])assert.equal(key in view,false,key);
  assert.deepEqual(view.board,[]);
  const next=structuredClone(state);delete next.hand.holes.h1;next.seats[1].out=true;
  assert.equal('h1' in spectatorView(next).holeCardsByPlayerId,false);
});

test('only settled tournament elimination changes viewer role; game over wins',()=>{
  const state=game();state.seats[0].stack=0;
  assert.equal(viewerRole(viewFor(state,'user'),'user'),'player');
  state.seats[0].out=true;
  assert.equal(viewerRole(viewFor(state,'user'),'user'),'spectator');
  state.config.mode='cash-training';
  assert.equal(viewerRole(viewFor(state,'user'),'user'),'player');
  state.gameOver=true;
  assert.equal(viewerRole(viewFor(state,'user'),SPECTATOR_ID),'finished');
});

test('full cards only reach observer snapshot/SSE and do not persist in host history',async t=>{
  const f=await fixture(t);assert.equal((await f.publish()).status,200);
  const observer=await f.request('snapshot',{seat:SPECTATOR_ID});
  assert.equal(observer.status,200);assert.deepEqual(observer.body.view.holeCardsByPlayerId,f.state.hand.holes);
  for(const seat of ['user','h1']) {
    const snap=await f.request('snapshot',{seat});
    assert.equal('holeCardsByPlayerId' in snap.body.view,false);
    assert.deepEqual(snap.body.view.myCards,f.state.hand.holes[seat]);
  }
  assert.equal((await f.request('action-status',{seat:SPECTATOR_ID})).status,403);
  assert.equal((await f.request('action',{seat:SPECTATOR_ID,body:{token:TOKEN,action:'fold',decisionId:'d-1-preflop-0'}})).status,403);
  const controller=new AbortController();t.after(()=>controller.abort());
  const response=await fetch(`http://127.0.0.1:${f.relay.port}/api/events?token=${TOKEN}&after=999999`,{headers:{'x-seat':SPECTATOR_ID},signal:controller.signal});
  const reader=response.body.getReader();let text='';
  while(!text.includes('holeCardsByPlayerId'))text+=new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes('snapshot'));controller.abort();
  const raw=JSON.parse(fs.readFileSync(path.join(f.dir,'ui-snapshot.json'),'utf8'));
  assert.ok(raw.projectionAnchor);
  for(const card of f.state.hand.holes.h1)assert.equal(JSON.stringify(raw).includes(JSON.stringify(card)),false);
  assert.equal(JSON.stringify(raw).includes('holeCardsByPlayerId'),false);
});

test('exact durable anchor restores spectators; ahead engine and legacy snapshots fail closed',async t=>{
  const f=await fixture(t);await f.publish();
  const restored=loadUiState(f.dir,TOKEN);
  assert.deepEqual(publicSnapshot(restored,null,SPECTATOR_ID).view.holeCardsByPlayerId,f.state.hand.holes);
  const next=applyAction(f.state,legalFor(f.state).toAct,'fold').state;saveState(f.dir,next);
  assert.equal(publicSnapshot(loadUiState(f.dir,TOKEN),null,SPECTATOR_ID).code,'VIEW_NOT_READY');
  const file=path.join(f.dir,'ui-snapshot.json');const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  delete raw.projectionAnchor;fs.writeFileSync(file,JSON.stringify(raw));saveState(f.dir,f.state);
  assert.equal(publicSnapshot(loadUiState(f.dir,TOKEN),null,SPECTATOR_ID).code,'VIEW_NOT_READY');
});

test('failed publication never exposes a candidate observer snapshot or replay frame',async t=>{
  let fail=false;const f=await fixture(t,{fault:stage=>{if(fail&&stage==='before-ui-commit')throw Error('fault');}});
  await f.publish();fail=true;
  const next=applyAction(f.state,legalFor(f.state).toAct,'fold').state;
  assert.equal((await f.publish(next)).status,500);
  assert.equal((await f.request('snapshot',{seat:SPECTATOR_ID})).status,503);
  const player=await f.request('snapshot');assert.equal(player.status,200);
  assert.equal(player.body.view.seats.some(s=>s.folded),false);
  const raw=JSON.parse(fs.readFileSync(path.join(f.dir,'ui-snapshot.json'),'utf8'));
  assert.equal(raw.projectionAnchor.stateVersion,f.state.stateVersion);
});

test('eliminated host loop identity probe survives a failed commit and permits retry',async t=>{
  let fail=false;const f=await fixture(t,{fault:stage=>{if(fail&&stage==='before-ui-commit')throw Error('fault');}});
  f.state.seats[0].out=true;await f.publish();fail=true;
  assert.equal((await f.publish()).status,500);
  assert.equal((await f.request('snapshot')).status,503);
  const probe=await f.request('snapshot',{headers:{'x-loop-probe':'1'}});
  assert.equal(probe.status,200);assert.ok(Array.isArray(probe.body.coach));
  assert.equal(probe.body.view.holeCardsByPlayerId,undefined);
  fail=false;assert.equal((await f.publish()).status,200);
  assert.equal((await f.request('snapshot')).body.viewerRole,'spectator');
});

for(const viewless of [false,true]) {
  test(`recovery clears rejected projection before ${viewless?'viewless':'invalid'} retry`,async t=>{
    let fail=false;
    const f=await fixture(t,{fault:stage=>{if(fail&&stage==='before-ui-commit')throw Error('fault');}});
    await f.publish();fail=true;
    const next=applyAction(f.state,legalFor(f.state).toAct,'fold').state;
    assert.equal((await f.publish(next)).status,500);fail=false;
    const retried=await f.request('publish',{body:{token:TOKEN,publishId:viewless?2:0,events:[]}});
    assert.equal(retried.status,viewless?200:400);
    const observer=await f.request('snapshot',{seat:SPECTATOR_ID});
    assert.equal(observer.status,503);
    assert.equal(observer.body.code,'VIEW_NOT_READY');
    assert.equal(observer.body.view,null);
    assert.equal((await f.publish(next)).status,200);
    assert.equal((await f.request('snapshot',{seat:SPECTATOR_ID})).status,200);
  });
}

for (const stage of ['after-ui-commit','after-receipt-commit']) {
  test(`app role and leave authority wait for confirmed publish after ${stage}`,async t=>{
    let fail=false;
    const f=await fixture(t,{fault:at=>{if(fail&&at===stage)throw Error('fault');}});
    const room=createRoomManager({storeDir:f.dir});room.open({totalSeats:3});
    const guest=room.join({code:room.load().joinCode,name:'Guest',addr:'1'});
    room.lockForStart({requestId:'start'});room.bind('game-a',[{participantId:guest.participantId,playerId:'h1'}]);
    const manager={room,current:{gameId:'game-a',sessionDir:f.dir},session:null,snapshot:()=>({state:'paused',gameId:'game-a',gameEpoch:'epoch'})};
    const app=await startAppServer({manager,storeDir:f.dir,token:'host-token',port:0,publicPort:0});
    registerOwnedServer(app.server,'role-authority-app');t.after(()=>app.close());
    const participant=async endpoint=>{
      const response=await fetch(`http://127.0.0.1:${app.publicPort}/api/p/${endpoint}`,{method:endpoint==='leave'?'POST':'GET',headers:{authorization:`Bearer ${guest.participantToken}`}});
      return {status:response.status,body:await response.json()};
    };
    await f.publish();writeJsonAtomic(path.join(f.dir,'loop-state.json'),{lastPublishId:1});
    assert.equal((await participant('state')).body.me.viewerRole,'player');
    fail=true;const next=structuredClone(f.state);next.seats.find(s=>s.playerId==='h1').out=true;next.stateVersion++;
    assert.equal((await f.publish(next)).status,500);
    assert.notEqual((await participant('state')).body.me.viewerRole,'spectator');
    assert.equal((await participant('leave')).status,409);
    assert.equal(room.authenticate(guest.participantToken).playerId,'h1');
    fail=false;assert.equal((await f.request('publish',{body:{token:TOKEN,publishId:2,view:viewFor(next,'user')}})).status,200);
    writeJsonAtomic(path.join(f.dir,'loop-state.json'),{lastPublishId:2});
    assert.equal((await participant('state')).body.me.viewerRole,'spectator');
    assert.equal((await f.request('publish',{body:{token:TOKEN,publishId:3,events:[]}})).status,200);
    assert.equal((await participant('state')).body.me.viewerRole,'spectator','viewless publication keeps the confirmed view authority');
    assert.equal((await participant('leave')).status,200);
    assert.throws(()=>room.authenticate(guest.participantToken),{code:'UNAUTHORIZED'});
  });
  test(`post-commit guest stream recovers its private snapshot after ${stage}`,async t=>{
    let fail=false;
    const f=await fixture(t,{fault:at=>{if(fail&&at===stage)throw Error('fault');}});
    await f.publish();
    const controller=new AbortController();t.after(()=>controller.abort());
    const timer=setTimeout(()=>controller.abort(),process.platform==='win32'?30000:5000);t.after(()=>clearTimeout(timer));
    const response=await fetch(`http://127.0.0.1:${f.relay.port}/api/events?token=${TOKEN}`,{headers:{'x-seat':'h1'},signal:controller.signal});
    const reader=response.body.getReader();let text='';
    while(!text.includes('id: 1'))text+=new TextDecoder().decode((await reader.read()).value);
    fail=true;
    const step=applyAction(f.state,legalFor(f.state).toAct,'fold');
    assert.equal((await f.publish(step.state,step.events)).status,500);
    fail=false;
    assert.equal((await f.request('publish',{body:{token:TOKEN,publishId:2,view:viewFor(step.state,'user')}})).status,200);
    text='';while(!text.includes('"snapshot"'))text+=new TextDecoder().decode((await reader.read()).value);
    const payload=JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)).snapshot;
    assert.deepEqual(payload.view,viewFor(step.state,'h1'));
    assert.equal(payload.view.holeCardsByPlayerId,undefined);
    assert.deepEqual(payload.log,step.events);
    controller.abort();
  });
  test(`durable publication recovers observer delivery after ${stage}`,async t=>{
    let fail=false;
    const f=await fixture(t,{fault:at=>{if(fail&&at===stage)throw Error('fault');}});
    await f.publish();
    const controller=new AbortController();t.after(()=>controller.abort());
    const response=await fetch(`http://127.0.0.1:${f.relay.port}/api/events?token=${TOKEN}`,{headers:{'x-seat':SPECTATOR_ID},signal:controller.signal});
    const reader=response.body.getReader();
    await reader.read();
    fail=true;
    const next=applyAction(f.state,legalFor(f.state).toAct,'fold').state;
    assert.equal((await f.publish(next)).status,500);
    assert.equal((await f.request('snapshot',{seat:SPECTATOR_ID})).status,503);
    fail=false;
    // Retrying the same publishId recovers the durable state and must wake an
    // already-open observer stream even though the publication is a duplicate.
    assert.equal((await f.request('publish',{body:{token:TOKEN,publishId:2,view:viewFor(next,'user')}})).status,200);
    const chunk=await reader.read();
    assert.match(new TextDecoder().decode(chunk.value),/"snapshot"/);
    assert.equal((await f.request('snapshot',{seat:SPECTATOR_ID})).body.view.seats.some(s=>s.folded),true);
    controller.abort();
  });
}

for(const seat of ['user','h1']) {
  test(`open ${seat} stream switches on settled elimination, with terminal precedence`,async t=>{
    const f=await fixture(t);await f.publish();
    const controller=new AbortController();t.after(()=>controller.abort());
    const response=await fetch(`http://127.0.0.1:${f.relay.port}/api/events?token=${TOKEN}`,{headers:{'x-seat':seat},signal:controller.signal});
    const reader=response.body.getReader();await reader.read();
    const next=structuredClone(f.state);next.seats.find(s=>s.playerId===seat).out=true;next.stateVersion++;
    await f.publish(next);
    let text='';while(!text.includes('holeCardsByPlayerId'))text+=new TextDecoder().decode((await reader.read()).value);
    assert.match(text,/"viewerRole":"spectator"/);
    assert.equal((await f.request('action-status',{seat})).status,403);
    next.gameOver=true;next.hand=null;next.phase='idle';next.result='abort';next.stateVersion++;
    const terminal=await f.publish(next);assert.equal(terminal.status,200,JSON.stringify(terminal.body));
    assert.equal((await f.request('snapshot',{seat})).body.viewerRole,'finished');
    assert.deepEqual((await f.request('snapshot',{seat:SPECTATOR_ID})).body.view.holeCardsByPlayerId,{});
    controller.abort();
  });
}
