import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seatPresentation, participantSummary, mobileSeatSlot} from '../server/public/seat-format.js';
test('elimination comes from explicit engine state, never a zero stack', () => {
  const view={handInProgress:true,toAct:'p1',mode:'tournament'};
  assert.equal(seatPresentation(view,{playerId:'p1',out:false,stack:0,allIn:true}).status,'올인');
  const out=seatPresentation(view,{playerId:'p1',out:true,allIn:true,isButton:true,bet:50});
  assert.equal(out.status,'탈락');assert.equal(out.active,false);assert.equal(out.showBacks,false);assert.equal(out.showButton,false);assert.equal(out.showBet,false);
  assert.equal(seatPresentation({...view,handInProgress:false},{out:false,folded:true,allIn:true}).status,'플레이 중');
  assert.equal(seatPresentation(view,{stack:0}).status,'상태 확인 불가');
  assert.equal(seatPresentation({street:'preflop'},{isButton:true}).showButton,true);
  assert.equal(seatPresentation({handInProgress:false},{isButton:true}).showButton,false);
});
test('a fold stays marked through the result and clears with the next hand; all-in does not linger', () => {
  for (const mode of ['tournament','cash-training']) {
    const ended={handNo:4,handInProgress:false,mode};
    const folded=seatPresentation(ended,{playerId:'p1',out:false,folded:true});
    assert.equal(folded.status,'폴드');assert.equal(folded.folded,true);assert.equal(folded.showBacks,false);
    assert.equal(seatPresentation({...ended,gameOver:true},{playerId:'p1',out:false,folded:true}).status,'폴드');
    const allIn=seatPresentation(ended,{playerId:'p1',out:false,allIn:true,stack:0});
    assert.equal(allIn.status,'플레이 중');assert.equal(allIn.allIn,false);
    assert.equal(seatPresentation({handNo:5,handInProgress:true,street:'preflop',mode},{playerId:'p1',out:false,folded:false}).status,'플레이 중');
  }
  assert.equal(seatPresentation({handNo:4,handInProgress:false,mode:'tournament'},{playerId:'p1',out:true,folded:true}).status,'탈락');
  assert.equal(seatPresentation({handNo:0,handInProgress:false},{playerId:'p1',out:false,folded:true}).folded,false);
});
test('cash and legacy participant counts do not guess tournament survival', () => {
  const seats=[{out:false},{out:true}];
  assert.equal(participantSummary({seats}),'남은 인원 1 / 2');
  assert.equal(participantSummary({mode:'cash-training',seats}),'참가자 2명');
  assert.equal(participantSummary({seats:[{}]}),'참가자 1명 · 상태 확인 불가');
  assert.equal(seatPresentation({mode:'cash-training',handInProgress:false},{stack:0}).status,'플레이 중');
});
test('mobile slots preserve every seat including hero, 2 through 9 players', () => {
  for(let n=2;n<=9;n++){
    const slots=Array.from({length:n},(_,i)=>mobileSeatSlot(i,n));
    assert.equal(new Set(slots.map(p=>`${p.x},${p.y}`)).size,n);
    assert.equal(new Set(slots.map(p=>p.slot)).size,n);
    assert.deepEqual(slots[0],{x:50,y:100,slot:'H'});
  }
  // The scrolling tablet layout reads these coordinates (table.css, 601–800px
  // stage): the phone redesign must not move them.
  const coords=n=>Array.from({length:n},(_,i)=>{const {x,y}=mobileSeatSlot(i,n);return `${x},${y}`;}).join(' ');
  assert.equal(coords(9),'50,100 0,78 0,54 0,29 28,4 72,4 100,29 100,54 100,78');
  assert.equal(coords(8),'50,100 0,78 0,54 0,29 50,4 100,29 100,54 100,78');
  assert.equal(coords(6),'50,100 0,78 0,29 50,4 100,29 100,78');
  // The phone layout (table-mobile.css) places seats by these names.
  const names=n=>Array.from({length:n},(_,i)=>mobileSeatSlot(i,n).slot).join(' ');
  assert.equal(names(2),'H TC');
  assert.equal(names(6),'H L3 L1 TC R1 R3');
  assert.equal(names(9),'H L3 L2 L1 T1 T2 R1 R2 R3');
});

test('blind markers follow actual posts, including heads-up, busted seats and short all-ins', async () => {
  const {createGame,startHand,applyAction,legalFor}=await import('../engine/hand.js');
  const {userView}=await import('../engine/views.js');
  const {blindPositions}=await import('../server/public/seat-format.js');
  for (const n of [2,6,9]) {
    let state=createGame({aiCount:n-1});state.button=0;
    if(n===6){state.seats[2].out=true;state.seats[2].stack=0;}
    state=startHand(state).state;
    const expectedPosts=state.hand.posts.map(p=>p.playerId);
    let roles=blindPositions(userView(state));
    assert.equal(roles[expectedPosts[0]],n===2?'D/SB':'SB');
    assert.equal(roles[expectedPosts[1]],'BB');
    while(state.hand?.street==='preflop') {
      const legal=legalFor(state);
      state=applyAction(state,legal.toAct,legal.canCheck?'check':'call').state;
    }
    assert.deepEqual(blindPositions(userView(state)),roles,'positions survive the street change and cleared bets');
  }
  let short=createGame({aiCount:2});short.button=2;short.seats[1].stack=10;
  short=startHand(short).state;
  assert.equal(short.hand.posts[0].amount,10);
  assert.equal(blindPositions(userView(short))[short.hand.posts[0].playerId],'SB');
  assert.deepEqual(blindPositions({...userView(short),handInProgress:false}),{});
  assert.deepEqual(blindPositions({street:'preflop',seats:[{isButton:true},{out:false}]}),{});
});

test('engine actions and both table layouts advance clockwise; heads-up reverses the first actor after the flop', async () => {
  const {createGame,startHand,applyAction,legalFor}=await import('../engine/hand.js');
  const {ovalPoint}=await import('../server/public/seat-format.js');
  for(const n of [2,3,6,8,9]) {
    const points=Array.from({length:n},(_,i)=>ovalPoint(i,n,38,40));
    for(const layout of [points,Array.from({length:n},(_,i)=>mobileSeatSlot(i,n))]) {
      if(n>2) {
        const signedArea=layout.reduce((sum,p,i)=>{const q=layout[(i+1)%n];return sum+p.x*q.y-q.x*p.y;},0);
        assert.ok(signedArea>0,'positive area means clockwise with screen y increasing downward');
      }
    }
    let state=createGame({aiCount:n-1});state.button=0;state=startHand(state).state;
    const posts=state.hand.posts.map(p=>p.playerId);
    const bbIndex=state.seats.findIndex(s=>s.playerId===posts[1]);
    const expected=Array.from({length:n},(_,i)=>state.seats[(bbIndex+1+i)%n].playerId);
    const actual=[];
    while(state.hand?.street==='preflop') {
      const legal=legalFor(state);actual.push(legal.toAct);
      state=applyAction(state,legal.toAct,legal.canCheck?'check':'call').state;
    }
    assert.deepEqual(actual,expected);
    assert.equal(legalFor(state).toAct,n===2?posts[1]:posts[0]);
  }
});

test('last action badges track current street bets, raises and all-in, never blinds or card data',async()=>{
  const {lastActionsBySeat}=await import('../server/public/seat-format.js');
  const log=[{type:'hand_start',handNo:1},{type:'blinds_posted',posts:[{playerId:'user',amount:25},{playerId:'p1',amount:50}]}];
  assert.deepEqual(lastActionsBySeat(log),{},'posting a blind is not an action');
  log.push({type:'action',playerId:'user',action:'call',street:'preflop'});
  assert.deepEqual(lastActionsBySeat(log).user,{label:'콜',amount:null});
  log.push({type:'street',street:'flop',board:['As','Kh','Qc']});
  assert.deepEqual(lastActionsBySeat(log),{});
  log.push({type:'action',playerId:'user',action:'raise',street:'flop',amount:100});
  assert.deepEqual(lastActionsBySeat(log).user,{label:'벳',amount:100});
  log.push({type:'action',playerId:'p1',action:'raise',street:'flop',amount:300,allIn:true});
  assert.deepEqual(lastActionsBySeat(log).p1,{label:'올인',amount:300});
  log.push({type:'action',playerId:'user',action:'fold',street:'flop'});
  assert.deepEqual(lastActionsBySeat(log).user,{label:'폴드',amount:null});
  log.push({type:'hand_start',handNo:2});assert.deepEqual(lastActionsBySeat(log),{});
});

test('engine views keep a fold marked through the result for host, seat and spectator, and clear it next hand', async () => {
  const {createGame,startHand,applyAction,legalFor}=await import('../engine/hand.js');
  const {userView,viewFor,spectatorView}=await import('../engine/views.js');
  for (const mode of ['tournament','cash-training']) {
    let state=createGame({aiCount:3,mode,...(mode==='cash-training'?{levelEvery:null}:{})});
    state=startHand(state).state;
    const folder=legalFor(state).toAct;
    state=applyAction(state,folder,'fold').state;
    while(!legalFor(state).handOver){const legal=legalFor(state);state=applyAction(state,legal.toAct,legal.canCheck?'check':'call').state;}
    const finished=[userView(state),viewFor(state,state.seats[1].playerId),spectatorView(state)];
    for(const view of finished){
      assert.equal(view.handInProgress,false);
      const seat=view.seats.find(row=>row.playerId===folder);
      assert.equal(seatPresentation(view,seat).status,'폴드',`${mode} ${view.viewer}: the fold shows through the result`);
      for(const other of view.seats.filter(row=>row.playerId!==folder))assert.notEqual(seatPresentation(view,other).status,'폴드');
    }
    state=startHand(state).state;
    for(const view of [userView(state),viewFor(state,state.seats[1].playerId),spectatorView(state)])
      assert.notEqual(seatPresentation(view,view.seats.find(row=>row.playerId===folder)).status,'폴드','the next hand clears it');
  }
});
