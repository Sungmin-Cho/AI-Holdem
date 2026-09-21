import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {startAppServer} from '../tools/app-server.js';
import {createRoomManager} from '../tools/room-manager.js';
const gameId='00000000-0000-4000-8000-000000000009',epoch='ab'.repeat(32);
async function fixture(t,{initial='playing',mode='cash-training',summaryCache}={}) {
 const root=createOwnedTempDir('summary-api'),room=createRoomManager({storeDir:root});
 room.open({totalSeats:2});const guest=room.join({code:room.load().joinCode,name:'Guest',addr:'1'});
 room.lockForStart({requestId:'start-1'});room.bind(gameId,[{participantId:guest.participantId,playerId:'h1'}]);
 const state={handNo:2,gameOver:true,result:'abort',config:{mode,startStack:100},sessionNet:{user:20,h1:-20},
  seats:[{playerId:'user',name:'Host',kind:'human',stack:105},{playerId:'h1',name:'Guest',kind:'human',stack:75}],
  lastHand:{handNo:1,startStacks:{user:100,h1:100},endStacks:{user:120,h1:80},pots:[{amount:40,winners:[{playerId:'user',share:40}]}]}};
 fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(state));
 let status=initial;const manager={room,current:{gameId,sessionDir:root},snapshot:()=>({gameId,gameEpoch:epoch,state:status})};
 const app=await startAppServer({manager,token:'host',storeDir:root,publicPort:0,summaryCache});t.after(()=>app.close());
 const headers={authorization:'Bearer host','x-game-epoch':epoch};
 const participant={authorization:`Bearer ${guest.participantToken}`,'x-game-epoch':epoch};
 return {app,root,room,manager,state,guest,headers,participant,setStatus:value=>{status=value;}};
}
test('summary host route is local and gated, authenticated, epoch-bound and origin-protected',async t=>{
 const f=await fixture(t),url=f.app.origin+`/api/game/${gameId}/summary`;
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{...f.headers,origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(url,{headers:{...f.headers,'x-game-epoch':'old'}})).status,409);
 for(const status of ['playing','paused']){f.setStatus(status);assert.equal((await fetch(url,{headers:f.headers})).status,409);}
 for(const status of ['finalizing','completed','ended']){
  f.setStatus(status);const res=await fetch(url,{headers:f.headers});assert.equal(res.status,200);const body=await res.json();
  assert.equal(body.complete,true);assert.deepEqual(body.players.map(row=>row.net),[20,-20]);
 }
 assert.equal((await fetch(url,{method:'POST',headers:f.headers})).status,405);
});
test('participant summary keeps seat binding and per-token two second throttle; spectator may read',async t=>{
 const f=await fixture(t,{initial:'completed'}),url=f.app.publicOrigin+`/api/p/game/${gameId}/summary`;
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:{...f.participant,origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(url,{headers:f.participant})).status,200);
 const second=await fetch(url,{headers:f.participant});assert.equal(second.status,429);assert.equal((await second.json()).code,'RATE_LIMIT');
 const wrong=url.replace(gameId,'00000000-0000-4000-8000-000000000008');assert.equal((await fetch(wrong,{headers:f.participant})).status,409);
 const watch=f.room.join({code:f.room.load().joinCode,name:'Watcher',addr:'2',game:{state:'playing',gameId}});
 // A new member is unbound to this completed table and cannot impersonate its seats.
 const fresh=await fetch(url,{headers:{authorization:`Bearer ${watch.participantToken}`,'x-game-epoch':epoch}});
 assert.equal(fresh.status,200);
});
test('participant final never starts an archive build and uses completed cash net, omitting unverified tournament net',async t=>{
 for(const mode of ['cash-training','tournament']) {
  let reads=0;const summaryCache={get:()=>{reads++;return Promise.resolve(null);},peek:()=>null,clear(){}};
  const f=await fixture(t,{mode,summaryCache}),url=f.app.publicOrigin+'/api/p/state';f.setStatus('ended');
  // Server started while playing; no prebuild callback. If final triggered summary,
  // the missing early archive would instead mark it incomplete.
  f.state.handNo=3;f.state.lastHand.handNo=2;fs.writeFileSync(path.join(f.root,'state.json'),JSON.stringify(f.state));
  const json=await (await fetch(url,{headers:f.participant})).json();assert.equal(reads,0);assert.equal(json.game.final.stacks.length,2);
  if(mode==='cash-training')assert.deepEqual(json.game.final.stacks.map(row=>[row.net,row.rank]),[[20,1],[-20,2]]);
  else assert.ok(json.game.final.stacks.every(row=>!Object.hasOwn(row,'net')&&!Object.hasOwn(row,'rank')));
 }
});
