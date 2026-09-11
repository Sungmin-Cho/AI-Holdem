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
    assert.deepEqual(slots[0],{x:50,y:100});
  }
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
