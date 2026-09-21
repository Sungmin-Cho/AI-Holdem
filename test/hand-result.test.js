import test from 'node:test';
import assert from 'node:assert/strict';

const fixture=()=>({
  log:[{type:'hand_start',handNo:3},{type:'showdown',reveals:[{playerId:'user',cards:['As','Ah'],handName:'원페어'}],mucks:['p2']},
    {type:'pot_award',potIndex:0,amount:300,winners:[{playerId:'user',share:300}]}],
  view:{handNo:3,handInProgress:false,gameOver:false,mode:'cash-training',viewer:'user',sessionNet:{user:150},
    seats:[{playerId:'user',kind:'human',stack:1150},{playerId:'p2',kind:'ai',stack:850}],
    holeCardsByPlayerId:{p2:['Kh','9s']},pots:[{potIndex:0,amount:300,winners:[{playerId:'user',share:300}]}]},
  viewer:'user',prior:{handNo:3,sessionNet:{user:50},handStartStack:1050},
});

test('hand result selects only public awards and revealed hand names, with cash net',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');
  const result=buildHandResult(fixture());
  assert.deepEqual(result,{handNo:3,kind:'showdown',pots:[{potIndex:0,amount:300,winners:[{playerId:'user',share:300}]}],
    winners:[{playerId:'user',total:300,handName:'원페어'}],myNet:100});
  const text=JSON.stringify(result);
  for(const privateValue of ['As','Ah','Kh','9s','holeCardsByPlayerId','cards','mucks'])assert.equal(text.includes(privateValue),false);
});

test('side pots and split awards retain separate shares and winner totals',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  input.log.push({type:'pot_award',potIndex:1,amount:400,winners:[{playerId:'user',share:200},{playerId:'p2',share:200}]});
  const result=buildHandResult(input);
  assert.equal(result.pots.length,2);assert.deepEqual(result.winners,[{playerId:'user',total:500,handName:'원페어'},{playerId:'p2',total:200,handName:null}]);
});

test('fold completion uses awards, never treats an uncalled return as another win',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  input.log=input.log.filter(event=>event.type!=='showdown');
  input.log.splice(1,0,{type:'uncalled_return',playerId:'user',amount:900});
  const result=buildHandResult(input);assert.equal(result.kind,'uncontested');
  assert.deepEqual(result.winners,[{playerId:'user',total:300,handName:null}]);
});

test('unknown baseline and spectators omit net; tournament uses captured hand-start stack',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  assert.equal(buildHandResult({...input,prior:null}).myNet,null);
  assert.equal(buildHandResult({...input,viewer:null}).myNet,null);
  assert.equal(buildHandResult({...input,prior:{...input.prior,handNo:2}}).myNet,null);
  assert.equal(buildHandResult({...input,view:{...input.view,mode:'tournament'}}).myNet,100);
  assert.equal(buildHandResult({...input,view:{...input.view,handInProgress:true}}),null);
  assert.equal(buildHandResult({...input,view:{...input.view,gameOver:true}}),null);
  assert.equal(buildHandResult({...input,log:[{type:'hand_start',handNo:3}]}),null);
});

test('same-hand side frames preserve result identity and a new hand clears it',async()=>{
  const {updateHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  const result=updateHandResult(null,input);assert.ok(result);
  assert.equal(updateHandResult(result,{...input,log:[]}),result);
  assert.equal(updateHandResult(result,{...input,view:{...input.view,handInProgress:true}}),null);
  assert.equal(updateHandResult(result,{...input,view:{...input.view,handNo:4},log:[]}),null);
});

test('runout presentation uses absolute time and only this hand’s last N streets',async()=>{
  const {handResultFrame,buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  input.view.board=['2s','3h','4c','5d','6s'];
  input.log=[{type:'street',street:'river',board:['As','Ah','Kh','Ks','Qs']},input.log[0],
    {type:'street',street:'flop',board:['2s','3h','4c']},{type:'street',street:'turn',board:['2s','3h','4c','5d']},
    {type:'street',street:'river',board:input.view.board},...input.log.slice(1)];
  const hold={handNo:3,startAt:new Date(10000).toISOString(),until:new Date(15100).toISOString(),runoutStepMs:800,runoutStreets:2};
  const props={result:buildHandResult(input),hold,log:input.log,view:input.view};
  assert.deepEqual(handResultFrame({...props,now:10000}),{board:['2s','3h','4c'],visible:false,remainingSeconds:6});
  assert.deepEqual(handResultFrame({...props,now:10801}),{board:['2s','3h','4c','5d'],visible:false,remainingSeconds:5});
  assert.deepEqual(handResultFrame({...props,now:11600}),{board:input.view.board,visible:true,remainingSeconds:4});
  assert.deepEqual(handResultFrame({...props,now:16000}),{board:input.view.board,visible:true,remainingSeconds:null});
  assert.deepEqual(handResultFrame({...props,now:10000,reducedMotion:true}).board,input.view.board);
  assert.equal(handResultFrame({...props,hold:null,now:10000}).remainingSeconds,null);
  assert.equal(handResultFrame({...props,log:[],now:10801}).visible,false,'missing street log cannot shorten server result timing');
  assert.equal(handResultFrame({...props,hold:{...hold,handNo:2},now:10000}).visible,true);
});

test('hand baseline is known only before tournament actions; cash can reconnect mid-hand',async()=>{
  const {captureHandPrior}=await import('../server/public/hand-result.js');
  const view={handNo:2,viewer:'user',mode:'tournament',street:'preflop',handInProgress:true,seats:[{playerId:'user',stack:975,bet:25}]};
  const log=[{type:'hand_start',handNo:2},{type:'blinds_posted',posts:[]}];
  assert.deepEqual(captureHandPrior(null,{view,log,viewer:'user'}),{handNo:2,handStartStack:1000});
  assert.equal(captureHandPrior(null,{view,log:[...log,{type:'action'}],viewer:'user'}),null);
  assert.equal(captureHandPrior(null,{view:{...view,street:'flop'},log,viewer:'user'}),null);
  assert.equal(captureHandPrior(null,{view,log,viewer:null}),null);
  assert.deepEqual(captureHandPrior(null,{view:{...view,mode:'cash-training',sessionNet:{user:25}},log,viewer:'user'}),{handNo:2,sessionNet:{user:25}});
});

test('actual thinking painter announces transitions, not every second, and resets repeated AI turns',async()=>{
  const fs=await import('node:fs'),vm=await import('node:vm');
  const source=fs.readFileSync(new URL('../server/public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function paintThinking(view)'),end=source.indexOf('\nfunction paintHandResult',start);
  let now=0,announcements=0;const nodes=new Map();
  const node=id=>{if(!nodes.has(id)){let text='';nodes.set(id,{hidden:false,get textContent(){return text;},set textContent(value){text=value;if(id==='thinking-announcement')announcements++;}});}return nodes.get(id);};
  const context=vm.createContext({$:node,Date:{now:()=>now},thinkingTurn:null,ui:{log:[]},playerName:id=>id});
  vm.runInContext(source.slice(start,end),context);
  const ai={handNo:1,street:'flop',toAct:'p1',handInProgress:true,seats:[{playerId:'p1',kind:'ai'},{playerId:'user',kind:'human'}]};
  context.paintThinking(ai);assert.equal(announcements,1);now=5000;context.paintThinking(ai);assert.equal(announcements,1);assert.match(node('thinking').textContent,/5초/);
  now=25000;context.paintThinking(ai);assert.equal(announcements,2);context.paintThinking(ai);assert.equal(announcements,2);
  context.paintThinking({...ai,toAct:'user'});now=60000;context.paintThinking(ai);assert.match(node('thinking').textContent,/0초/);
  context.ui.log.push({type:'action'});now=90000;context.paintThinking(ai);assert.match(node('thinking').textContent,/0초/);
  const html=fs.readFileSync(new URL('../server/public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html.match(/<p[^>]*id="thinking"[^>]*>/)[0],/aria-live/);
});
