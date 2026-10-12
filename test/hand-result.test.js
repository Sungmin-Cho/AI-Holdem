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
  const {key,...result}=buildHandResult(fixture());
  assert.equal(typeof key,'string');
  assert.deepEqual(result,{handNo:3,viewer:'user',kind:'showdown',pots:[{potIndex:0,amount:300,winners:[{playerId:'user',share:300}],note:null,versus:null}],
    winners:[{playerId:'user',total:300,handName:'원페어',cards:null}],board:{flop:[],turn:[],river:[]},runout:[],blinds:null,myNet:100});
  const text=JSON.stringify(result);
  for(const privateValue of ['As','Ah','Kh','9s','holeCardsByPlayerId','myCards','mucks'])assert.equal(text.includes(privateValue),false);
});

test('side pots and split awards retain separate shares and winner totals',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  input.log.push({type:'pot_award',potIndex:1,amount:400,winners:[{playerId:'user',share:200},{playerId:'p2',share:200}]});
  const result=buildHandResult(input);
  assert.equal(result.pots.length,2);assert.deepEqual(result.winners,[{playerId:'user',total:500,handName:'원페어',cards:null},{playerId:'p2',total:200,handName:null,cards:null}]);
  assert.deepEqual(result.pots.map(pot=>pot.note),[null,'같은 족보로 분할'],'a rebuilt side pot has no known contenders; a split needs none');
});

test('fold completion uses awards, never treats an uncalled return as another win',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');const input=fixture();
  input.log=input.log.filter(event=>event.type!=='showdown');
  input.log.splice(1,0,{type:'uncalled_return',playerId:'user',amount:900});
  const result=buildHandResult(input);assert.equal(result.kind,'uncontested');
  assert.deepEqual(result.winners,[{playerId:'user',total:300,handName:null,cards:null}]);
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

// A three-way showdown on a full board: p1 wins with the king kicker over p2.
const showdownFixture=({p3='reveal'}={})=>{
  const board=['Ah','9d','7c','4s','2h'];
  const reveals=[{playerId:'p1',cards:['As','Kd'],handName:'원페어'},{playerId:'p2',cards:['Ac','Qd'],handName:'원페어'}];
  if(p3==='reveal')reveals.push({playerId:'p3',cards:['Jc','Jd'],handName:'원페어'});
  return {
    log:[{type:'hand_start',handNo:5},{type:'action',playerId:'p1',action:'raise',amount:40},
      {type:'street',street:'flop',board:board.slice(0,3)},{type:'action',playerId:'p1',action:'check'},
      {type:'street',street:'turn',board:board.slice(0,4)},{type:'action',playerId:'p1',action:'check'},
      {type:'street',street:'river',board},{type:'action',playerId:'p1',action:'check'},
      {type:'showdown',reveals,mucks:p3==='muck'?['p3']:[]},
      {type:'pot_award',potIndex:0,amount:120,winners:[{playerId:'p1',share:120}]}],
    view:{handNo:5,handInProgress:false,gameOver:false,mode:'tournament',viewer:'user',board,myCards:['8c','8d'],
      seats:[{playerId:'user',kind:'human',stack:900},{playerId:'p1',kind:'ai',stack:1120},{playerId:'p2',kind:'ai',stack:960},{playerId:'p3',kind:'ai',stack:960}],
      holeCardsByPlayerId:{p3:['Tc','Td']},pots:[{potIndex:0,amount:120,eligible:['p1','p2','p3'],winners:[{playerId:'p1',share:120}]}]},
    viewer:'user',prior:null,
  };
};

test('showdown result carries the winner’s best five, the board by street and what decided the pot',async()=>{
  const {buildHandResult}=await import('../server/public/hand-result.js');
  const result=buildHandResult(showdownFixture());
  assert.deepEqual(result.winners,[{playerId:'p1',total:120,handName:'원페어',cards:['As','Ah','Kd','9d','7c']}]);
  assert.deepEqual(result.board,{flop:['Ah','9d','7c'],turn:['4s'],river:['2h']});
  assert.deepEqual(result.runout,[]);
  assert.equal(result.pots[0].note,'키커 K > Q');assert.equal(result.pots[0].versus,'p2','the strongest tabled loser');
  // Only the board and the tabled showdown cards may appear; never the viewer's
  // own unrevealed cards, a spectator's private hole cards, or a muck.
  const cards=JSON.stringify(result).match(/"[2-9TJQKA][shdc]"/g).map(text=>JSON.parse(text));
  const publicCards=new Set(['Ah','9d','7c','4s','2h','As','Kd','Ac','Qd','Jc','Jd']);
  assert.ok(cards.every(card=>publicCards.has(card)),cards.join(' '));
  for(const secret of ['8c','8d','Tc','Td','holeCardsByPlayerId','myCards','mucks'])assert.equal(JSON.stringify(result).includes(secret),false,secret);
});

test('a pot names its deciding rank only when every contender is tabled',async()=>{
  const {buildHandResult,summarizeHand}=await import('../server/public/hand-result.js');
  const mucked=showdownFixture({p3:'muck'});
  assert.equal(buildHandResult(mucked).pots[0].note,null,'a mucked contender could have been the real runner-up');
  const single=showdownFixture();
  assert.equal(summarizeHand(single.log,5).pots[0].note,'키커 K > Q','one pot: the showdown players are its contenders');
  const split=showdownFixture();
  split.log=split.log.map(event=>event.type==='showdown'?{...event,reveals:[event.reveals[0],{playerId:'p2',cards:['Ad','Kc'],handName:'원페어'}]}
    :event.type==='pot_award'?{...event,winners:[{playerId:'p1',share:60},{playerId:'p2',share:60}]}:event);
  split.view.pots=[{potIndex:0,amount:120,eligible:['p1','p2'],winners:[]}];
  assert.equal(buildHandResult(split).pots[0].note,'같은 족보로 분할');
  const wrongName=showdownFixture();
  wrongName.log=wrongName.log.map(event=>event.type==='showdown'?{...event,reveals:event.reveals.map(row=>row.playerId==='p1'?{...row,handName:'투페어'}:row)}:event);
  const dropped=buildHandResult(wrongName);
  assert.equal(dropped.winners[0].cards,null,'a client evaluation that disagrees with the engine is not shown');
  assert.equal(dropped.pots[0].note,null);
});

test('board scope, runout streets and the latest finished hand come from that hand’s events',async()=>{
  const {summarizeHand,latestFinishedHand}=await import('../server/public/hand-result.js');
  const folded=[{type:'hand_start',handNo:7,blinds:[10,20]},{type:'action',playerId:'p1',action:'raise',amount:40},
    {type:'street',street:'flop',board:['Ks','7d','2c']},{type:'action',playerId:'p1',action:'raise',amount:60},
    {type:'action',playerId:'p2',action:'fold'},{type:'pot_award',potIndex:0,amount:100,winners:[{playerId:'p1',share:100}]}];
  assert.deepEqual(summarizeHand(folded,7).board,{flop:['Ks','7d','2c'],turn:[],river:[]});
  assert.equal(summarizeHand(folded,7).kind,'uncontested');
  const allIn=[{type:'hand_start',handNo:8,blinds:[25,50]},{type:'action',playerId:'p1',action:'raise',amount:900,allIn:true},
    {type:'action',playerId:'p2',action:'call',amount:900},
    {type:'street',street:'flop',board:['Ks','7d','2c']},{type:'street',street:'turn',board:['Ks','7d','2c','5h']},
    {type:'street',street:'river',board:['Ks','7d','2c','5h','9s']},
    {type:'showdown',reveals:[{playerId:'p1',cards:['As','Ad'],handName:'원페어'},{playerId:'p2',cards:['Kh','Qd'],handName:'원페어'}],mucks:[]},
    {type:'pot_award',potIndex:0,amount:1800,winners:[{playerId:'p1',share:1800}]}];
  assert.deepEqual(summarizeHand(allIn,8).runout,['flop','turn','river']);
  assert.equal(summarizeHand(allIn,8).pots[0].note,'페어 A > K');
  const log=[...folded,...allIn,{type:'hand_start',handNo:9},{type:'blinds_posted',sb:5,bb:10}];
  assert.equal(latestFinishedHand(log).handNo,8);
  assert.equal(latestFinishedHand(log).myNet,null);
  assert.equal(summarizeHand(log,7).pots[0].amount,100,'an earlier hand is sliced to its own events');
  assert.deepEqual([summarizeHand(log,7).blinds,summarizeHand(log,8).blinds],[[10,20],[25,50]],'each hand keeps its own blinds');
  // Blinds-only all-in: no action at all, every street is a runout.
  const posted=[{type:'hand_start',handNo:10,blinds:[50,100]},{type:'blinds_posted',sb:50,bb:100},
    ...allIn.filter(event=>event.type!=='hand_start'&&event.type!=='action')];
  assert.deepEqual(summarizeHand(posted,10).runout,['flop','turn','river']);
  assert.equal(latestFinishedHand([{type:'hand_start',handNo:1}]),null);
});

test('the latest result follows the log across missed hands and game over, and keeps the viewer’s net from the hand-end view',async()=>{
  const {trackLatestResult}=await import('../server/public/hand-result.js');
  const input=fixture();
  const end=trackLatestResult(null,input);
  assert.equal(end.handNo,3);assert.equal(end.myNet,100);assert.equal(end.fromView,true);
  const next={...input.view,handNo:4,handInProgress:true};
  const log=[...input.log,{type:'hand_start',handNo:4,blinds:[50,100]}];
  assert.equal(trackLatestResult(end,{...input,log,view:next}),end,'the next hand keeps the same object');
  // Reconnect two hands later with a stale cache: rebuilt from the log, no net.
  const later=[...log,{type:'pot_award',potIndex:0,amount:200,winners:[{playerId:'p2',share:200}]},{type:'hand_start',handNo:5}];
  const rebuilt=trackLatestResult(end,{...input,log:later,view:{...input.view,handNo:5,handInProgress:true}});
  assert.equal(rebuilt.handNo,4);assert.equal(rebuilt.myNet,null);assert.deepEqual(rebuilt.blinds,[50,100]);
  // The final hand: game over still yields that hand's complete result.
  const over=trackLatestResult(end,{...input,view:{...input.view,gameOver:true}});
  assert.equal(over,end,'the same hand-end result');
  const fresh=trackLatestResult(null,{...input,view:{...input.view,gameOver:true}});
  assert.equal(fresh.myNet,100,'game over keeps the viewer’s net for the last hand');
  // A log-only result is upgraded once the hand-end view arrives.
  const logOnly=trackLatestResult(null,{...input,view:{...input.view,handNo:2}});
  assert.equal(logOnly.myNet,null);
  assert.equal(trackLatestResult(logOnly,input).myNet,100);
  assert.equal(trackLatestResult(null,{...input,log:[{type:'hand_start',handNo:1}]}),null);
});

test('a hand never borrows another hand\u2019s events: missing boundaries refuse, reused numbers stay apart',async()=>{
  const {summarizeHand,latestFinishedHand,trackLatestResult}=await import('../server/public/hand-result.js');
  const handA=[{type:'hand_start',handNo:7,blinds:[10,20]},{type:'street',street:'flop',board:['Ks','7d','2c']},
    {type:'action',playerId:'p1',action:'raise',amount:60},{type:'action',playerId:'p2',action:'fold'},
    {type:'pot_award',potIndex:0,amount:100,winners:[{playerId:'p1',share:100}]},{type:'bust',playerId:'p2'},{type:'narration',text:'x'}];
  const handB=[{type:'street',street:'flop',board:['Ah','9d','7c']},{type:'action',playerId:'p3',action:'check'},
    {type:'showdown',reveals:[{playerId:'p3',cards:['As','Kd'],handName:'원페어'}],mucks:[]},
    {type:'pot_award',potIndex:0,amount:400,winners:[{playerId:'p3',share:400}]}];
  assert.equal(summarizeHand(handA,7).pots[0].amount,100,'bust and narration may follow the awards');
  // B's hand_start is missing: A's awards are followed by more play.
  const broken=[...handA,...handB];
  assert.equal(summarizeHand(broken,7),null);
  assert.equal(latestFinishedHand(broken),null);
  assert.equal(trackLatestResult(null,{log:broken,view:null,viewer:'user',prior:null}),null);
  // A reused number: the finished first 7 stays readable while the second 7 plays.
  const reused=[...handA,{type:'hand_start',handNo:7,blinds:[25,50]},{type:'action',playerId:'p3',action:'call',amount:50}];
  assert.equal(latestFinishedHand(reused).pots[0].amount,100);
  assert.equal(summarizeHand(reused,7),null,'the current 7 has not finished');
  const first=trackLatestResult(null,{log:reused,view:{handNo:7,handInProgress:true,viewer:'user'},viewer:'user',prior:null});
  assert.equal(first.pots[0].amount,100);
  // When the second 7 finishes, the cache moves to it.
  const second=[...reused,...handB.slice(2)];
  const moved=trackLatestResult(first,{log:second,view:{handNo:7,handInProgress:false,viewer:'user',seats:[]},viewer:'user',prior:null});
  assert.equal(moved.pots[0].amount,400);assert.notEqual(moved.key,first.key);assert.deepEqual(moved.blinds,[25,50]);
});

test('a viewer change rebuilds the cached results without the previous viewer\u2019s net',async()=>{
  const {trackLatestResult,updateHandResult}=await import('../server/public/hand-result.js');
  const input=fixture();
  const mine=trackLatestResult(null,input);assert.equal(mine.myNet,100);
  const watching={...input,view:{...input.view,viewer:null},viewer:null};
  const spectator=trackLatestResult(mine,watching);
  assert.notEqual(spectator,mine);assert.equal(spectator.myNet,null);assert.equal(spectator.viewer,null);
  const live=updateHandResult(null,input);assert.equal(live.myNet,100);
  assert.equal(updateHandResult(live,watching).myNet,null);
});

test('a side pot\u2019s reason compares only that pot\u2019s contenders',async()=>{
  const {buildHandResult,summarizeHand}=await import('../server/public/hand-result.js');
  // p2 (short, trips) wins the main pot; the side pot is between the user and p4 only.
  const board=['Ah','9d','7c','4s','2h'];
  const log=[{type:'hand_start',handNo:61,blinds:[25,50]},{type:'action',playerId:'user',action:'raise',amount:5000,allIn:true},
    {type:'action',playerId:'p2',action:'call',amount:300,allIn:true},{type:'action',playerId:'p4',action:'call',amount:700,allIn:true},
    {type:'street',street:'flop',board:board.slice(0,3)},{type:'street',street:'turn',board:board.slice(0,4)},{type:'street',street:'river',board},
    {type:'showdown',reveals:[{playerId:'user',cards:['As','Kd'],handName:'원페어'},{playerId:'p2',cards:['9h','9c'],handName:'트리플'},{playerId:'p4',cards:['Ac','Qd'],handName:'원페어'}],mucks:[]},
    {type:'pot_award',potIndex:0,amount:975,winners:[{playerId:'p2',share:975}]},{type:'pot_award',potIndex:1,amount:800,winners:[{playerId:'user',share:800}]}];
  const view={handNo:61,handInProgress:false,gameOver:false,mode:'tournament',viewer:'user',board,
    seats:[{playerId:'user',kind:'human',stack:5100},{playerId:'p2',kind:'ai',stack:975},{playerId:'p4',kind:'ai',stack:0}],
    pots:[{potIndex:0,amount:975,eligible:['user','p2','p4']},{potIndex:1,amount:800,eligible:['user','p4']}]};
  const result=buildHandResult({log,view,viewer:'user',prior:null});
  assert.deepEqual(result.pots.map(pot=>[pot.note,pot.versus]),[[null,null],['키커 K > Q','p4']],
    'the main pot is decided by category; the side pot ignores p2, who is not in it');
  assert.deepEqual(result.runout,['flop','turn','river']);
  assert.deepEqual(summarizeHand(log,61).pots.map(pot=>pot.note),[null,null],'from the log alone the side pot\u2019s contenders are unknown');
});
