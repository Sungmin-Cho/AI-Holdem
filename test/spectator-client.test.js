import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual SSE reset adapter, rather than a duplicate implementation.
const source=fs.readFileSync(new URL('../server/public/app.js',import.meta.url),'utf8');
const adapter=source.slice(source.indexOf('function applyMessage(m) {'),source.indexOf("if (!token) showBootError"));

test('seat-scoped recovery snapshot updates action authority as well as the screen',()=>{
  const calls=[];
  const context={revision:1,booted:true,renderSnapshot:snap=>calls.push(['render',snap.view]),
    actionController:{observe:(view,meta)=>calls.push(['observe',view,meta.revision])},setConn:()=>{},render:()=>{throw Error('not a delta');}};
  vm.runInNewContext(adapter+'\nthis.deliver=applyMessage;',context);
  const view={viewer:'h1',legal:{decisionId:'new-turn'}};
  context.deliver({revision:2,snapshot:{revision:2,view}});
  assert.deepEqual(calls,[['render',view],['observe',view,2]]);
  assert.equal(context.revision,2);
  context.deliver({revision:1,snapshot:{view:{viewer:'h1'}}});
  assert.equal(calls.length,2);
});

test('spectator reset does not restore a disconnected action controller',()=>{
  const context={revision:1,booted:true,actionController:{observe:()=>{throw Error('observer cannot act');}},setConn:()=>{},render:()=>{}};
  context.renderSnapshot=()=>{context.actionController=null;};
  vm.runInNewContext(adapter+'\nthis.deliver=applyMessage;',context);
  context.deliver({revision:2,snapshot:{revision:2,view:{viewer:null,holeCardsByPlayerId:{}}}});
  assert.equal(context.actionController,null);
  assert.equal(context.revision,2);
});

test('spectator snapshot resultHold reaches the shared result builder and current countdown',async()=>{
  const {buildHandResult,handResultFrame}=await import('../server/public/hand-result.js');
  const snapshot={revision:2,view:{viewer:null,holeCardsByPlayerId:{p1:['As','Ah']},handNo:1,handInProgress:false,board:[],seats:[]},
    log:[{type:'hand_start',handNo:1},{type:'pot_award',potIndex:0,amount:100,winners:[{playerId:'p1',share:100}]}],
    resultHold:{handNo:1,startAt:new Date(1000).toISOString(),until:new Date(4500).toISOString(),runoutStreets:0,runoutStepMs:0}};
  let painted;
  const context={revision:1,booted:true,actionController:null,setConn:()=>{},render:()=>{},renderSnapshot:snap=>{
    const result=buildHandResult({log:snap.log,view:snap.view,viewer:null});
    painted={result,frame:handResultFrame({result,hold:snap.resultHold,log:snap.log,view:snap.view,now:2500})};
  }};
  vm.runInNewContext(adapter+'\nthis.deliver=applyMessage;',context);context.deliver({revision:2,snapshot});
  assert.equal(painted.result.myNet,null);assert.equal(painted.frame.remainingSeconds,2);assert.equal(painted.frame.visible,true);
  assert.equal(JSON.stringify(painted.result).includes('As'),false);
});
