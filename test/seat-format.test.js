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
