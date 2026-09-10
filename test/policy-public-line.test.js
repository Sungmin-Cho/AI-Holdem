import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicLine,hasPublicDraw} from '../training/policies/public-line.js';
import {distributionV2} from '../training/policies/strategy-v2.js';
import {policyById,resolveStoredPolicy} from '../training/policies/catalog.js';
import {configDigestOf} from '../training/policies/contracts.js';
import {createGame,startHand,applyAction,legalFor} from '../engine/hand.js';
import {snapshotDecision} from '../engine/decision.js';

test('actual six-seat engine snapshot preserves a heads-up continuation line after four folds',()=>{
  let state=startHand(createGame({aiCount:5})).state;
  const actor=legalFor(state).toAct;
  state=applyAction(state,actor,'raise',150).state;
  const opponent=Object.keys(state.hand.bets).find(id=>id!==actor&&state.hand.bets[id]===50);
  while(state.hand.street==='preflop') {
    const legal=legalFor(state);
    state=applyAction(state,legal.toAct,legal.toAct===opponent?'call':'fold').state;
  }
  assert.equal(legalFor(state).toAct,opponent);
  state=applyAction(state,opponent,'check').state;
  const legal=legalFor(state),snapshot=snapshotDecision(state,actor,null,{blinds:[25,50],legal});
  assert.equal(snapshot.publicSeats.filter(row=>row.folded).length,4);
  assert.equal(publicLine(snapshot).eligible,true);
  assert.equal(publicLine(snapshot).reason,'initiative');
});

export function lineSnapshot(over={}) {
  return {schemaVersion:1,actorId:'user',decisionId:'d-1-flop-1',street:'flop',position:'BTN',
    holeCards:['6h','5h'],board:['Kh','8h','2c'],blinds:[25,50],potBefore:300,
    actorBet:0,currentBet:0,toCall:0,effectiveStack:5000,
    publicSeats:[{playerId:'user',position:'BTN'},{playerId:'p1',position:'BB'}],
    priorActions:[{playerId:'user',street:'preflop',action:'raise',amount:125},
      {playerId:'p1',street:'preflop',action:'call',amount:125},
      {playerId:'p1',street:'flop',action:'check',amount:0}],...over};
}
const legal={canCheck:true,canRaise:true,callAmount:0,minRaiseTo:50,maxRaiseTo:5000};
test('public line denies multiway, unknown positions, raises against us and contradictory previous aggression',()=>{
  assert.equal(publicLine(lineSnapshot()).eligible,true);
  const missing=lineSnapshot({priorActions:undefined});
  const multi=lineSnapshot(); multi.publicSeats.push({playerId:'p2',position:'CO'});
  const raised=lineSnapshot(); raised.priorActions.push({playerId:'p1',street:'flop',action:'raise',amount:100});
  const lost=lineSnapshot({street:'turn',board:['Kh','8h','2c','3d'],priorActions:[
    {playerId:'user',street:'flop',action:'raise',amount:100},
    {playerId:'p1',street:'flop',action:'raise',amount:300},
    {playerId:'user',street:'flop',action:'call',amount:300},
    {playerId:'p1',street:'turn',action:'check',amount:0}]});
  for(const snap of [missing,multi,raised,lost,lineSnapshot({position:'unknown'}),
    lineSnapshot({toCall:100,currentBet:100}),lineSnapshot({toCall:undefined})]) {
    assert.equal(publicLine(snap).eligible,false);
    assert.equal(distributionV2(snap,legal,policyById('maniac-v2')).filter(row=>row.action==='raise').length,0);
  }
});
test('draw/value share identical size support and conditional mixture, without hidden-state input',()=>{
  const draw=lineSnapshot(), value=lineSnapshot({holeCards:['Ks','Kd']});
  assert.equal(hasPublicDraw(draw),true);
  const raises=snap=>distributionV2(snap,legal,policyById('tag-v2')).filter(row=>row.action==='raise');
  const d=raises(draw),v=raises(value);
  assert.ok(d.length>=2); assert.ok(d.every(row=>row.reasonCode.startsWith('v2-bluff:initiative')));
  assert.ok(v.every(row=>row.reasonCode.startsWith('v2-value:')));
  assert.deepEqual(d.map(row=>row.amount),v.map(row=>row.amount));
  const mix=rows=>rows[0].frequency/rows.reduce((s,row)=>s+row.frequency,0);
  assert.ok(Math.abs(mix(d)-mix(v))<1e-12);
  assert.deepEqual(raises({...draw,deck:['Ac'],opponentHoleCards:[['As','Ad']],result:'win'}),d);
});
test('checked-to probes require position and prior check-through on later streets',()=>{
  const flop=lineSnapshot({priorActions:[{playerId:'p1',street:'flop',action:'check'}]});
  assert.equal(publicLine(flop).reason,'checked-to-probe');
  const turn=lineSnapshot({street:'turn',priorActions:[{playerId:'p1',street:'flop',action:'check'},
    {playerId:'user',street:'flop',action:'check'},{playerId:'p1',street:'turn',action:'check'}]});
  assert.equal(publicLine(turn).reason,'checked-to-probe');
  turn.priorActions[0].action='raise';turn.priorActions[1].action='call';
  assert.equal(publicLine(turn).eligible,false);
  const folded=lineSnapshot({street:'turn',priorActions:[{playerId:'user',street:'flop',action:'raise'},
    {playerId:'p1',street:'flop',action:'call'},{playerId:'p2',street:'flop',action:'call'},
    {playerId:'p2',street:'turn',action:'fold'},{playerId:'p1',street:'turn',action:'check'}]});
  folded.publicSeats.push({playerId:'p2',position:'SB',folded:true});
  assert.equal(publicLine(folded).eligible,false);
});
test('public straight draws include open ends, gutshots and the wheel',()=>{
  for(const [holeCards,board] of [[['6c','7d'],['8h','9s','Kc']],[['6c','8d'],['9h','Ts','Kc']],
    [['Ad','2c'],['3h','4s','Kh']]]) assert.equal(hasPublicDraw(lineSnapshot({holeCards,board})),true);
  assert.equal(hasPublicDraw(lineSnapshot({holeCards:['2c','7d'],board:['Kh','9s','4c']})),false);
});
test('2.1.0 stored policy rolls forward while rejecting a forged old digest',()=>{
  const old={...policyById('tag-v2'),policyVersion:'2.1.0'};old.configDigest=configDigestOf(old);
  assert.equal(resolveStoredPolicy(old).config.policyVersion,'2.2.0');
  assert.throws(()=>resolveStoredPolicy({...old,configDigest:'0'.repeat(64)}));
});
