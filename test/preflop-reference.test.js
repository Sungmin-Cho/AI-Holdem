import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadReferenceDataset} from '../tools/preflop-dataset.js';
import {V2_REFERENCE_SOURCE} from '../shared/reference.js';
import {resolvePreflopReference,comparePreflopChoice,evaluatePreflopReference} from '../training/preflop-reference.js';
const data=loadReferenceDataset(V2_REFERENCE_SOURCE);
const corpus=JSON.parse(fs.readFileSync(new URL('./fixtures/reference-coverage/decisions.json',import.meta.url),'utf8'));
const snapshot=()=>structuredClone(corpus[0]);
test('production transcript: 12 of 24 preflop decisions exact, postflop excluded',()=>{
 const rows=corpus.map(s=>evaluatePreflopReference(s,data));
 assert.equal(rows.length,38);
 assert.equal(rows.filter(r=>r.street==='preflop').length,24);
 assert.equal(rows.filter(r=>r.coverage?.metricEligible).length,12);
 assert.equal(rows.filter(r=>r.status==='supported').length,12);
});
test('query never reads chosen action; comparison requires minted matching reference',()=>{
 const s=snapshot();const expected=resolvePreflopReference(s,data);
 Object.defineProperty(s,'chosenAction',{get(){throw Error('future choice read');}});
 assert.deepEqual(resolvePreflopReference(s,data),expected);
 const observed=snapshot();
 assert.throws(()=>comparePreflopChoice(observed,structuredClone(expected)),{code:'REFERENCE_CONTEXT_MISMATCH'});
 observed.holeCards=['As','Ah'];
 assert.throws(()=>comparePreflopChoice(observed,expected),{code:'REFERENCE_CONTEXT_MISMATCH'});
});
test('bounded stack projection cannot grade or assign chosen frequency',()=>{
 for(const bb of [80,99,100,112,120]){
  const s=snapshot();for(const p of s.publicSeats)p.stack=bb*50-p.contribution;
  s.maxRaiseTo=s.legal.maxRaiseTo=s.effectiveStack=bb*50;
  const r=evaluatePreflopReference(s,data);
  assert.equal(r.status,'supported');assert.equal(r.coverage.metricEligible,bb===100);
  if(bb!==100){assert.equal(r.grade,null);assert.equal(r.chosen.frequency,null);}
 }
 for(const total of [3999,6001]){
  const s=snapshot();for(const p of s.publicSeats)p.stack=total-p.contribution;
  s.maxRaiseTo=s.legal.maxRaiseTo=s.effectiveStack=total;
  assert.equal(resolvePreflopReference(s,data).code,'STACK_OUT_OF_RANGE');
 }
});
test('choice size projection preserves query; illegal native mass rejects entire reference',()=>{
 const s=snapshot();s.holeCards=['As','Ah'];const ref=resolvePreflopReference(s,data);
 for(const amount of [100,125,150,151]){
  s.chosenAction={action:'raise',amount};const r=comparePreflopChoice(s,ref);
  assert.equal(r.coverage.choiceMatch,amount===125?'exact':amount<=150?'projected':'unavailable');
  assert.equal(r.chosen.frequency,amount===125?1:null);
 }
 s.legal.canRaise=false;assert.equal(resolvePreflopReference(s,data).code,'REFERENCE_ACTION_ILLEGAL');
});

test('unsupported raises retain verified provenance without metrics',()=>{
 const rows=corpus.filter(s=>s.street==='preflop').map(s=>{s=structuredClone(s);s.chosenAction={action:'raise',amount:s.minRaiseTo};return evaluatePreflopReference(s,data);});
 const unsupported=rows.filter(r=>r.status==='unsupported'&&r.coverage);
 assert.ok(unsupported.length>0);
 for(const e of unsupported){assert.equal(referenceAssessmentEligibility(e).verified,true);assert.equal(referenceAssessmentEligibility(e).metricEligible,false);assert.equal(e.coverage.input.chosenRaiseToBb,e.chosen.sizeBb);}
});
