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

test('a finished game shows the spectator the last showdown from its public reveals',()=>{
  const start=source.indexOf('function seatCards('),end=source.indexOf('\nfunction ',start+1);
  const node=()=>({items:[],append(...items){this.items.push(...items);}});
  const context={el:()=>node(),cardNode:code=>code,isSpectating:()=>true,viewerId:()=>null,seatPresentation:()=>({showBacks:false})};
  vm.runInNewContext(source.slice(start,end)+'\nthis.seatCards=seatCards;',context);
  const revealed={p1:{playerId:'p1',cards:['As','Kd']}},mucks=new Set(['p2']);
  const finished={viewer:null,gameOver:true,holeCardsByPlayerId:{}};
  assert.deepEqual(context.seatCards({playerId:'p1'},finished,revealed,mucks).items,['As','Kd']);
  assert.deepEqual(context.seatCards({playerId:'p2'},finished,revealed,mucks).items,[],'a muck stays unseen');
  const live={viewer:null,gameOver:false,holeCardsByPlayerId:{p1:['As','Kd'],p2:['7c','2d']}};
  assert.deepEqual(context.seatCards({playerId:'p2'},live,revealed,mucks).items,['7c','2d'],'live play shows every hand as before');
  // The reveals come from the current hand only: a later hand, or a reused
  // number's new hand, never carries an earlier showdown.
  const from=source.indexOf('function revealedCards()'),to=source.indexOf('\nfunction ',from+1);
  const ui={view:{handNo:5},log:[]};vm.runInNewContext(source.slice(from,to)+'\nthis.revealedCards=revealedCards;',Object.assign(context,{ui}));
  const showdown={type:'showdown',reveals:[{playerId:'p1',cards:['As','Kd']}],mucks:['p2']};
  ui.log=[{type:'hand_start',handNo:5},showdown];
  assert.deepEqual(Object.keys(context.revealedCards().map),['p1']);
  ui.log=[{type:'hand_start',handNo:5},showdown,{type:'hand_start',handNo:6}];ui.view={handNo:6};
  assert.deepEqual(Object.keys(context.revealedCards().map),[],'the next hand starts with nothing revealed');
  ui.log=[{type:'hand_start',handNo:5},showdown,{type:'hand_start',handNo:5}];ui.view={handNo:5};
  assert.deepEqual(Object.keys(context.revealedCards().map),[],'a reused number\'s new hand starts with nothing revealed');
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
