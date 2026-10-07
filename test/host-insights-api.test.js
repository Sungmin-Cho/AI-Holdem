import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {startAppServer} from '../tools/app-server.js';
import {createRoomManager} from '../tools/room-manager.js';
import {createGame, startHand, applyAction, legalFor} from '../engine/hand.js';
import {hudFromState, revealFromPlayers} from '../tools/host-insights.js';

const gameId='00000000-0000-4000-8000-000000000019',epoch='cd'.repeat(32);

// One engine hand where the user folds while a check is free (a process check).
function playedHand() {
  const game=createGame({aiCount:2,startStack:2000,levelEvery:50});
  game.button=1;
  let state=startHand(game).state;
  while(!legalFor(state).handOver){
    const legal=legalFor(state);
    const action=legal.toAct==='user'&&legal.canCheck?'fold':legal.canCheck?'check':'call';
    state=applyAction(state,legal.toAct,action).state;
  }
  return state;
}

async function fixture(t) {
  const root=createOwnedTempDir('insights-api'),room=createRoomManager({storeDir:root});
  room.open({totalSeats:3});const guest=room.join({code:room.load().joinCode,name:'Guest',addr:'1'});
  const state=playedHand();
  state.seats[1].name='Alice';state.seats[2].name='Bob';
  fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(state));
  fs.mkdirSync(path.join(root,'hands'));
  fs.writeFileSync(path.join(root,'hands','hand-0001.json'),JSON.stringify(state.lastHand));
  fs.writeFileSync(path.join(root,'players.json'),JSON.stringify([
    {playerId:'user',name:'Host',kind:'human'},
    {playerId:'p1',name:'Alice',archetype:'LAG'},
    {playerId:'p2',name:'Bob',archetype:'Nit'},
  ]));
  let phase='playing';
  const writeLoop=()=>fs.writeFileSync(path.join(root,'loop-state.json'),JSON.stringify({phase,lastPublishId:0}));
  writeLoop();
  const manager={room,current:{gameId,sessionDir:root},snapshot:()=>({gameId,gameEpoch:epoch,state:'playing'})};
  const app=await startAppServer({manager,token:'host',storeDir:root,publicPort:0});t.after(()=>app.close());
  const headers={authorization:'Bearer host','x-game-epoch':epoch};
  return {app,root,state,guest,headers,setPhase:value=>{phase=value;writeLoop();}};
}

test('host learning aids are authenticated, bound to the current game and epoch, and absent for participants',async t=>{
  const f=await fixture(t);
  for(const kind of ['hud','report','reveal']){
    const url=f.app.origin+`/api/game/${gameId}/${kind}`;
    assert.equal((await fetch(url)).status,401,kind);
    assert.equal((await fetch(url,{headers:{...f.headers,'x-game-epoch':'old'}})).status,409,kind);
    assert.equal((await fetch(url.replace(gameId,'00000000-0000-4000-8000-000000000018'),{headers:f.headers})).status,409,kind);
    assert.equal((await fetch(url,{method:'POST',headers:f.headers})).status,405,kind);
    // The participant listener has no such route, with or without the host token.
    const participantUrl=f.app.publicOrigin+`/api/p/game/${gameId}/${kind}`;
    assert.notEqual((await fetch(participantUrl,{headers:{authorization:`Bearer ${f.guest.participantToken}`,'x-game-epoch':epoch}})).status,200,kind);
    assert.notEqual((await fetch(f.app.publicOrigin+`/api/game/${gameId}/${kind}`,{headers:f.headers})).status,200,kind);
  }
});

test('the HUD returns the engine counts the AI players read, for every seat',async t=>{
  const f=await fixture(t);
  const body=await (await fetch(f.app.origin+`/api/game/${gameId}/hud`,{headers:f.headers})).json();
  assert.deepEqual(body,hudFromState(f.state));
  assert.deepEqual(body.players.map(row=>row.playerId),['user','p1','p2']);
  assert.ok(body.players.every(row=>row.sample===1));
  assert.deepEqual(Object.keys(body.players[1]).sort(),['af','name','pfr','playerId','sample','vpip']);
});

test('the report lists deterministic process checks over completed hands',async t=>{
  const f=await fixture(t);
  const body=await (await fetch(f.app.origin+`/api/game/${gameId}/report`,{headers:f.headers})).json();
  assert.equal(body.hands,1);
  assert.equal(body.unreadable,0);
  assert.ok(body.decisions>=1);
  assert.ok(body.checks.some(line=>/체크할 수 있는데 폴드한 결정 1회\(핸드 1\)/.test(line)),body.checks.join('\n'));
});

test('identities are revealed only after the final review is published, and only for AI seats',async t=>{
  const f=await fixture(t),url=f.app.origin+`/api/game/${gameId}/reveal`;
  for(const phase of ['playing','finalizing','review_generated']){
    f.setPhase(phase);
    const res=await fetch(url,{headers:f.headers});
    assert.equal(res.status,409,phase);assert.equal((await res.json()).code,'REVEAL_NOT_READY');
  }
  for(const phase of ['review_published','done']){
    f.setPhase(phase);
    const body=await (await fetch(url,{headers:f.headers})).json();
    assert.deepEqual(body,{schemaVersion:1,players:[{playerId:'p1',name:'Alice',archetype:'LAG'},{playerId:'p2',name:'Bob',archetype:'Nit'}]});
  }
  assert.deepEqual(revealFromPlayers([{playerId:'h1',kind:'human',archetype:'TAG'}]).players,[]);
});
