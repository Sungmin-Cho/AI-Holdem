import {createGame,startHand,applyAction,legalFor} from '../engine/hand.js';
import {snapshotDecision} from '../engine/decision.js';
import {newDeck} from '../engine/cards.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadReferenceDataset} from '../tools/preflop-dataset.js';
import {V2_REFERENCE_SOURCE,LEGACY_REFERENCE_SOURCE} from '../shared/reference.js';
import {preflopKeys} from '../shared/preflop-key.js';
import {nativePreflopSnapshot} from '../training/native-preflop-snapshot.js';
import {evaluatePreflopReference} from '../training/preflop-reference.js';
import {referenceAssessmentEligibility,projectReferenceCoverage} from '../shared/reference-coverage.js';
import {generateQueue} from '../training/drill-generator.js';
import {startDrill,answerQuestion,nextQuestion} from '../tools/drill-cli.js';
import {readStudySummary} from '../tools/study-summary.js';
const data=loadReferenceDataset(V2_REFERENCE_SOURCE);
test('all 99 native contexts yield eligible evaluations and accurate practice prompts',()=>{
 for(const key of preflopKeys()) {
  const s=nativePreflopSnapshot(key,'AA',{action:'raise',sizeBb:key.includes('-vs-')?8.5:2.5});
  const e=evaluatePreflopReference(s,data);
  assert.equal(e.status,'supported',key);assert.equal(referenceAssessmentEligibility(e).metricEligible,true,key);
  assert.deepEqual(projectReferenceCoverage(e.coverage),e.coverage);
  const [q]=generateQueue({source:V2_REFERENCE_SOURCE,spotKey:key,handClass:'AA',limit:1});
  assert.equal(q.prompt.seated,Number(key[0]));assert.equal(q.prompt.openerPosition,e.coverage.input.openerPosition);
 }
});
test('v2 native drill answer persists eligible practice and v1 remains resumable',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'reference-drill-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 let session=await startDrill(d,{source:LEGACY_REFERENCE_SOURCE,seed:'old'});
 const resumed=await nextQuestion(d);assert.ok(resumed);
 session=await startDrill(d,{source:V2_REFERENCE_SOURCE,spotKey:'8max-100bb-lj-vs-utg1-open25-v2',handClass:'AA'});
 const q=session.queue[0];
 const result=await answerQuestion(d,{sessionId:session.sessionId,questionId:q.questionId,attemptNo:0,action:'raise',sizeBb:8.5});
 assert.ok(result);
 const summary=await readStudySummary(d);
 assert.equal(summary.source.version,'2.0.0');assert.equal(summary.practice.overall.supportedDecisions,1);
 assert.equal(summary.practice.coverage.exactComparableDecisions,1);
});

test('real engine 6/8/9 seat first-orbit snapshots resolve table-specific positions',()=>{
 for(const seated of [6,8,9]){
  let state=startHand(createGame({aiCount:seated-1,startStack:5000,blinds0:[25,50],mode:'cash-training',levelEvery:null}),{deck:newDeck()}).state;
  let count=0;
  while(!legalFor(state).handOver){
   const legal=legalFor(state);if(legal.canCheck)break;
   const snapshot=snapshotDecision(state,legal.toAct,{action:'fold',amount:0},{blinds:[25,50],legal});
   const result=evaluatePreflopReference(snapshot,data);
   assert.equal(result.status,'supported',`${seated} ${snapshot.position}`);
   assert.equal(result.coverage.input.seated,seated);count++;
   state=applyAction(state,legal.toAct,'fold').state;
  }
  assert.equal(count,seated-1);
 }
});

test('all 79 opener pairs resolve from real engine raise/fold transitions',()=>{
 let pairs=0;
 for(const seated of [6,8,9])for(let openerIndex=0;openerIndex<seated-1;openerIndex++){
  let state=startHand(createGame({aiCount:seated-1,startStack:5000,blinds0:[25,50],mode:'cash-training',levelEvery:null}),{deck:newDeck()}).state;
  for(let before=0;before<openerIndex;before++)state=applyAction(state,legalFor(state).toAct,'fold').state;
  state=applyAction(state,legalFor(state).toAct,'raise',125).state;
  while(!legalFor(state).handOver){
   const legal=legalFor(state);if(state.hand.street!=='preflop')break;
   const snapshot=snapshotDecision(state,legal.toAct,{action:'fold',amount:0},{blinds:[25,50],legal});
   const result=evaluatePreflopReference(snapshot,data);
   assert.equal(result.status,'supported',`${seated} ${openerIndex} ${snapshot.position}`);
   assert.ok(result.spotKey.includes('-vs-'));pairs++;
   state=applyAction(state,legal.toAct,'fold').state;
  }
 }
 assert.equal(pairs,79);
});
