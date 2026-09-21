import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createOwnedTempDir} from './helpers/owned-fixtures.mjs';
import {skipOnWin32} from './helpers/platform.js';
import {openContained} from '../tools/training-store.js';

const record=(handNo,start={user:100,p1:100},end={user:110,p1:90})=>({
  handNo,startStacks:start,endStacks:end,pots:[{amount:40,winners:[{playerId:'user',share:40}]}],
  holes:{user:['As','Kh']},showdown:{secret:'SHOWDOWN_SENTINEL'},actions:[{note:'NOTE_SENTINEL'}],decisions:[{policy:'POLICY_SENTINEL'}],
});
const state=(lastHand,mode='cash-training')=>({handNo:lastHand?.handNo??1,lastHand,gameOver:true,result:'completed',
  config:{mode,startStack:100},seats:[{playerId:'user',name:'나',kind:'human',stack:80,out:false},{playerId:'p1',name:'상대',kind:'ai',stack:120,out:false}]});
function fixture(records) {
  const root=createOwnedTempDir('summary');fs.mkdirSync(path.join(root,'hands'));
  for(const row of records)fs.writeFileSync(path.join(root,'hands',`hand-${String(row.handNo).padStart(4,'0')}.json`),JSON.stringify(row));
  return root;
}
async function cache(options){return (await import('../tools/session-summary.js')).createSessionSummaryCache(options);}
test('cash summary adds completed hand deltas including an unrestored final hand, with closed public fields',async()=>{
  const a=record(1),b=record(2,{user:100,p1:100},{user:80,p1:120}),root=fixture([a,b]),builder=await cache();
  const result=await builder.get({gameId:'a',sessionDir:root,state:state(b)});
  assert.equal(result.complete,true);assert.equal(result.handCount,2);
  assert.deepEqual(result.players.map(p=>p.net),[-10,10]);assert.deepEqual(result.players.map(p=>p.name),['나','상대']);
  assert.deepEqual(Object.keys(result).sort(),['complete','handCount','hands','mode','players','schemaVersion','startStack']);
  for(const row of result.players)assert.deepEqual(Object.keys(row).sort(),['finalStack','kind','name','net','out','playerId']);
  for(const row of result.hands)assert.deepEqual(Object.keys(row).sort(),['handNo','net','potTotal','winners']);
  for(const sentinel of ['As','Kh','SHOWDOWN_SENTINEL','NOTE_SENTINEL','POLICY_SENTINEL','holes','decisions'])assert.equal(JSON.stringify(result).includes(sentinel),false);
});
test('tournament and abort summary excludes unfinished bets and handles a busted seat absent from later starts',async()=>{
  const a=record(1,{user:100,p1:100},{user:200,p1:0}),b=record(2,{user:200},{user:200,p1:0}),root=fixture([a,b]);
  const input={...state(b,'tournament'),handNo:3,result:'abort',seats:[{playerId:'user',name:'나',kind:'human',stack:175,out:false},{playerId:'p1',name:'상대',kind:'ai',stack:0,out:true}]};
  const result=await (await cache()).get({gameId:'a',sessionDir:root,state:input});
  assert.equal(result.handCount,2);assert.deepEqual(result.players.map(p=>p.net),[100,-100]);
  assert.equal(result.hands[1].net.p1,undefined);
});
test('first hand abort has zero completed hands and zero completed-play net',async()=>{
  const result=await (await cache()).get({gameId:'a',sessionDir:fixture([]),state:{...state(null),result:'abort'}});
  assert.equal(result.handCount,0);assert.equal(result.complete,true);assert.deepEqual(result.hands,[]);assert.deepEqual(result.players.map(p=>p.net),[0,0]);
});
test('missing last archive uses lastHand once; an existing archive takes precedence',async()=>{
  const a=record(1),root=fixture([]),builder=await cache();
  let result=await builder.get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(result.hands.length,1);assert.equal(result.complete,true);
  fs.writeFileSync(path.join(root,'hands','hand-0001.json'),JSON.stringify({...a,endStacks:{user:120,p1:80}}));
  result=await builder.get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(result.players[0].net,20);assert.equal(result.hands.length,1);
});
test('missing, corrupt and oversized archives produce null session nets, never partial sums',async()=>{
  for(const kind of ['missing','corrupt','oversized']) {
    const b=record(2),root=fixture([b]);
    if(kind!=='missing')fs.writeFileSync(path.join(root,'hands','hand-0001.json'),kind==='corrupt'?'bad json':' '.repeat(256*1024+1));
    const result=await (await cache()).get({gameId:'a',sessionDir:root,state:state(b)});
    assert.equal(result.complete,false);assert.deepEqual(result.players.map(p=>p.net),[null,null]);assert.deepEqual(result.hands.map(h=>h.handNo),[2]);
  }
});
test('archive count cap cannot report a complete partial sum',async()=>{
  const last=record(1001),result=await (await cache()).get({gameId:'a',sessionDir:fixture([]),state:state(last)});
  assert.equal(result.complete,false);assert.equal(result.handCount,1001);assert.ok(result.hands.length<=1000);assert.equal(result.players[0].net,null);
});
test('cache reuses unchanged archives, rereads replacements, and clears when game changes',async()=>{
  const a=record(1),root=fixture([a]);let reads=0;
  const builder=await cache({openFile:(...args)=>{reads++;return openContained(...args);}});
  await builder.get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(reads,1);
  await builder.get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(reads,1);
  fs.writeFileSync(path.join(root,'hands','hand-0001.json'),JSON.stringify({...a,endStacks:{user:130,p1:70},extra:'changed'}));
  const changed=await builder.get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(reads,2);assert.equal(changed.players[0].net,30);
  await builder.get({gameId:'b',sessionDir:root,state:state(a)});assert.equal(reads,3);assert.equal(builder.peek('a'),null);
});
test('cold builds yield after at most 25 records and concurrent callers share one flight',async()=>{
  const rows=Array.from({length:51},(_,i)=>record(i+1)),root=fixture(rows);let reads=0,batch=0,yields=0;
  const builder=await cache({openFile:(...args)=>{reads++;assert.ok(++batch<=25);return openContained(...args);},yieldTurn:async()=>{yields++;batch=0;await new Promise(setImmediate);}});
  const input={gameId:'a',sessionDir:root,state:state(rows.at(-1))};
  const first=builder.get(input),second=builder.get(input);assert.equal(first,second);await first;assert.equal(reads,51);assert.ok(yields>=2);
});
test('symlink archives cannot bypass contained reads or become a cached success',async t=>{
  if(skipOnWin32(t,'symlink fixtures require POSIX privilege semantics'))return;
  const a=record(1),root=fixture([]),target=path.join(root,'outside.json');fs.writeFileSync(target,JSON.stringify(a));
  fs.symlinkSync(target,path.join(root,'hands','hand-0001.json'));
  const result=await (await cache()).get({gameId:'a',sessionDir:root,state:state(a)});assert.equal(result.complete,false);assert.equal(result.players[0].net,null);
});
