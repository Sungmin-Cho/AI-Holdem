import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newDeck,shuffle} from '../engine/cards.js';
import {HOLE_COMBINATIONS,playableHoles,selectedDeck,selectionWeights} from '../engine/deal-selection.js';
import {createGame,startHand,applyAction,legalFor} from '../engine/hand.js';
import {viewFor} from '../engine/views.js';
import {checkDealBiasResume,dealSelectionDisposition} from '../shared/deal-selection.js';
import {handAssistanceDisposition,independentAssessmentEligibility} from '../shared/assistance.js';
import {extractHandTendency,tendencyFromRecords} from '../training/tendency/extract.js';
function rng(seed) {let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
test('off preserves exact shuffled deck and 51 random draws',()=>{
  for(let seed=1;seed<=100;seed++) {
    let calls=0;const random=rng(seed);
    assert.deepEqual(selectedDeck('off',0,6,()=>{calls++;return random();}),shuffle(newDeck(),rng(seed)));
    assert.equal(calls,51);
  }
});
test('actual dealing maps selected holes exactly across seat counts and buttons',()=>{
  for(let aiCount=1;aiCount<=8;aiCount++) for(let button=0;button<=aiCount;button++) {
    const initial=createGame({aiCount,dealBias:'strong'});initial.button=button;
    const n=aiCount+1,nextButton=(button+1)%n,sb=n===2?nextButton:(nextButton+1)%n,userIndex=(n-sb)%n;
    for(let seed=1;seed<=20;seed++) {
      const expected=selectedDeck('strong',userIndex,n,rng(seed));
      const state=startHand(initial,{rng:rng(seed)}).state;
      assert.deepEqual(state.hand.holes.user,[expected[userIndex],expected[n+userIndex]]);
    }
  }
  const busted=createGame({aiCount:2,dealBias:'strong'});busted.seats[0].stack=0;busted.seats[0].out=true;
  assert.throws(()=>startHand(busted),{code:'GAME_OVER'});
});
test('finite combination weights and seeded favorable movement without card duplication',()=>{
  assert.equal(HOLE_COMBINATIONS.length,1326);
  const favored=HOLE_COMBINATIONS.filter(playableHoles).length;
  for(const [mode,multiplier] of [['off',1],['light',2],['strong',4]]) {
    const weights=selectionWeights(mode);assert.equal(weights.reduce((s,n)=>s+n,0),1326+(multiplier-1)*favored);
    let hits=0;const random=rng(1789),n=20000;
    for(let i=0;i<n;i++) {const d=selectedDeck(mode,2,6,random);assert.equal(new Set(d).size,52);hits+=Number(playableHoles([d[2],d[8]]));}
    const expected=favored*multiplier/(1326+(multiplier-1)*favored);
    assert.ok(Math.abs(hits/n-expected)<0.02,`${mode}: ${hits/n} vs ${expected}`);
  }
});
test('selected holes leave remaining first-card uniform conditional on fixed selected combination',()=>{
  const counts=new Map(),n=20000,random=rng(22);
  for(let i=0;i<n;i++) {
    let draws=0;const d=selectedDeck('strong',0,6,()=>draws++===0?0:random());
    counts.set(d[1],(counts.get(d[1])??0)+1);
  }
  assert.equal(counts.size,50);
  for(const count of counts.values()) assert.ok(Math.abs(count/n-1/50)<0.008);
});
test('2-9 seats preserve cards, chips and full-hand provenance; biased zero-action hands do not count',()=>{
  for(let aiCount=1;aiCount<=8;aiCount++) {
    let state=startHand(createGame({aiCount,dealBias:'strong'}),{rng:rng(aiCount)}).state;
    const hand=state.hand;
    assert.equal(viewFor(state,'user').dealBias,'strong');
    assert.equal(viewFor(state,'p1').dealBias,undefined);
    assert.equal(new Set([...hand.deck,...Object.values(hand.holes).flat()]).size,52);
    while(state.hand) {const legal=legalFor(state);state=applyAction(state,legal.toAct,legal.canCheck?'check':'fold').state;}
    assert.equal(state.seats.reduce((s,row)=>s+row.stack,0),5000*(aiCount+1));
    assert.equal(state.lastHand.dealSelection.mode,'strong');
    assert.equal(handAssistanceDisposition(state.lastHand),'assisted');
    assert.equal(extractHandTendency({...state.lastHand,actions:[],decisions:[]},'user').hands,0);
    const independent=structuredClone(state.lastHand);delete independent.dealSelection;delete independent.dealSelectionContractVersion;
    for(const d of independent.decisions){delete d.dealSelection;delete d.dealSelectionContractVersion;}
    const records=[...Array(59).fill(independent),...Array(100).fill(state.lastHand)];
    assert.equal(tendencyFromRecords(records,'user').hands,59);
    assert.equal(tendencyFromRecords([...records,independent],'user').hands,60);
  }
});
test('invalid, omitted new provenance and mismatched resume fail closed',()=>{
  assert.throws(()=>startHand(createGame({aiCount:1,dealBias:'strong'}),{deck:newDeck()}));
  assert.throws(()=>checkDealBiasResume({dealBias:'strong',dealSelectionContractVersion:1},'off'));
  assert.equal(dealSelectionDisposition({dealSelectionContractVersion:1}),'unavailable');
  assert.equal(independentAssessmentEligibility({schemaVersion:7}).metricEligible,false);
});
