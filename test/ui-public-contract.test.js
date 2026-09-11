import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startServer} from '../server/server.js';
import {startAppService} from '../tools/app-service.js';
import {applyAction,legalFor,createGame,startHand} from '../engine/hand.js';
import {userView,turnSummary} from '../engine/views.js';
import {newDeck} from '../engine/cards.js';
import {fixedDeck,setup3} from './helpers/fixtures.js';
import {createBrowserWorkspace} from './helpers/learning-browser-fixture.mjs';

test('real all-in settlement yields public out only after the hand, including simultaneous busts',()=>{
  let state=createGame({aiCount:2,startStack:100});state.button=2;
  const prefix=['7s','2c','As','8s','3d','Ah','Ks','Kd','Kh','9c','6d'];
  state=startHand(state,{deck:[...prefix,...newDeck().filter(c=>!prefix.includes(c))]}).state;
  state=applyAction(state,'user','raise',100).state;
  assert.equal(userView(state).seats[0].out,false);
  assert.equal(userView(state).seats[0].allIn,true);
  assert.equal(userView(state).seats[0].stack,0);
  while(!legalFor(state).handOver){const legal=legalFor(state);state=applyAction(state,legal.toAct,legal.canCheck?'check':'call').state;}
  const view=userView(state);
  assert.equal(view.handInProgress,false);
  assert.ok(view.seats.some(s=>s.out));
  assert.deepEqual(view.seats.map(s=>s.out),state.seats.map(s=>s.out));
  assert.deepEqual(view.pots,state.lastHand.pots);
  assert.equal(view.pots.reduce((sum,p)=>sum+p.amount,0),300);
});
test('cash settlement clears old status without classifying reset stacks as profit',()=>{
  let state=createGame({mode:'cash-training',aiCount:2,startStack:5000,levelEvery:null,handLimit:2});
  state=startHand(state,{deck:fixedDeck()}).state;
  while(!legalFor(state).handOver){const legal=legalFor(state);state=applyAction(state,legal.toAct,'fold').state;}
  const view=userView(state);assert.equal(view.handInProgress,false);assert.ok(view.seats.every(s=>!s.out));
  assert.ok(view.seats.every(s=>s.stack===5000));assert.ok(view.sessionNet);
});
test('new public fields survive relay persistence/reload; new assets respect app allowlist',async()=>{
  const workspace=createBrowserWorkspace();let relay,app;
  try{
    const state=setup3(5000,5000,5000);state.seats[1].out=true;const view=userView(state);
    const prompt=turnSummary(state,'user');assert.ok(!prompt.includes('handInProgress'));assert.ok(!prompt.includes('out:'));
    relay=await startServer({gameDir:workspace.root,port:0,token:'ui-contract-fixture'});
    const post=await fetch(`http://127.0.0.1:${relay.port}/api/publish`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'ui-contract-fixture',publishId:1,view})});assert.equal(post.status,200);
    await relay.close();relay=null;
    relay=await startServer({gameDir:workspace.root,port:0,token:'ui-contract-fixture'});
    const snap=await fetch(`http://127.0.0.1:${relay.port}/api/snapshot?token=ui-contract-fixture`).then(r=>r.json());
    assert.deepEqual(snap.view,view);
    app=await startAppService(workspace.root,{resolver:async()=>({player:null,upper:null,notices:[]})});
    for(const asset of ['/design-tokens.css','/table-design.css','/chip-format.js','/shared/game-setup.js','/shared/player-budget.js'])assert.equal((await fetch(app.origin+asset)).status,200,asset);
    assert.equal((await fetch(app.origin+'/shared/platform-files.js')).status,404);
    const css=await fetch(app.origin+'/design-tokens.css');assert.match(css.headers.get('content-type'),/css/);
    assert.ok([...fs.readFileSync('server/public/design-tokens.css')].every(n=>n<128));
  }finally{await app?.close();await relay?.close();workspace.close();}
});
