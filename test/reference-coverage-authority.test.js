import {validateExplanation} from '../training/explain.js';
import {measureTrainingCoverage} from '../tools/measure-training-coverage.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveSessionReference} from '../tools/reference-source.js';
import {loadReferenceDataset} from '../tools/preflop-dataset.js';
import {V2_REFERENCE_SOURCE} from '../shared/reference.js';
import {createTrainingControl,materializeLearningEvaluation} from '../tools/training-control.js';
import {evaluatePreflopReference} from '../training/preflop-reference.js';
import {nativePreflopSnapshot} from '../training/native-preflop-snapshot.js';
import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import {eventFromEvaluation} from '../training/profile-store.js';
import {rebuildFromEvents} from '../training/profile-aggregator.js';
const data=loadReferenceDataset(V2_REFERENCE_SOURCE),epoch='a'.repeat(64);
const snap=()=>nativePreflopSnapshot('9max-100bb-hj-vs-lj-open25-v2','AJo',{action:'fold'});
test('v2 authority replays canonical decision and seals full coverage',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'reference-authority-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 resolveSessionReference(d,{createNew:true,source:V2_REFERENCE_SOURCE});fs.mkdirSync(path.join(d,'hands'));
 const s=snap();fs.writeFileSync(path.join(d,'hands','hand-0001.json'),JSON.stringify({handNo:1,decisions:[s]}));
 const e=evaluatePreflopReference(s,data,{gameEpoch:epoch}),tc=createTrainingControl();
 const forged=structuredClone(e);forged.coverage.input.heroTotalChips++;
 await assert.rejects(tc.acceptEvaluations(d,{gameEpoch:epoch,owner:'test',handNo:1,evaluations:[forged]}),{code:'REFERENCE_EVALUATION_MISMATCH'});
 const {accepted:[item]}=await tc.acceptEvaluations(d,{gameEpoch:epoch,owner:'test',handNo:1,evaluations:[e]});
 assert.deepEqual(materializeLearningEvaluation(d,item).coverage,e.coverage);
 assert.equal(referenceAssessmentEligibility(e).metricEligible,true);
});
test('100 projected events cannot change exact score or calibration',()=>{
 const base=snap(),exact=evaluatePreflopReference(base,data,{gameEpoch:epoch});exact.payloadSha256='b'.repeat(64);
 const events=[eventFromEvaluation(exact,'2026-09-08T00:00:00.000Z')];
 const before=rebuildFromEvents(events);
 for(let n=0;n<100;n++){
  const s=snap();s.publicSeats.forEach(p=>p.stack+=600);s.maxRaiseTo=s.legal.maxRaiseTo=s.effectiveStack=5600;
  const e=evaluatePreflopReference(s,data,{gameEpoch:n.toString(16).padStart(64,'0')});e.payloadSha256='c'.repeat(64);
  assert.equal(referenceAssessmentEligibility(e).metricEligible,false);
  events.push(eventFromEvaluation(e,'2026-09-08T00:00:00.000Z'));
 }
 const after=rebuildFromEvents(events);
 assert.deepEqual(after.overall,before.overall);assert.deepEqual(after.calibration,before.calibration);
 assert.equal(after.coverage.referenceAvailableDecisions,101);assert.equal(after.coverage.projectedReferenceDecisions,100);
 assert.equal(after.coverage.exactComparableDecisions,1);
 const forged=structuredClone(exact);delete forged.coverage;
 assert.equal(referenceAssessmentEligibility(forged).verified,false);
});

test('accept with a missing v2 descriptor does not create a legacy binding',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'reference-missing-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 const evaluation=evaluatePreflopReference(snap(),data,{gameEpoch:epoch});
 await assert.rejects(createTrainingControl().acceptEvaluations(d,{gameEpoch:epoch,owner:'test',handNo:1,evaluations:[evaluation]}),{code:'REFERENCE_CONTEXT_UNAVAILABLE'});
 assert.equal(fs.existsSync(path.join(d,'reference-source.json')),false);
 assert.deepEqual(resolveSessionReference(d,{createNew:true,source:V2_REFERENCE_SOURCE}),V2_REFERENCE_SOURCE);
});

test('coverage measurement binds canonical decisions and rejects duplicate journals without writes',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'coverage-measure-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 resolveSessionReference(d,{createNew:true});fs.mkdirSync(path.join(d,'hands'));
 const snapshot=snap();fs.writeFileSync(path.join(d,'hands','hand-0001.json'),JSON.stringify({decisions:[snapshot]}));
 const e=evaluatePreflopReference(snapshot,data,{gameEpoch:epoch});
 const {accepted:[item]}=await createTrainingControl().acceptEvaluations(d,{gameEpoch:epoch,owner:'test',handNo:1,evaluations:[e]});
 const journal=path.join(d,'training','evaluations.jsonl');
 const line=JSON.stringify({...e,payloadSha256:item.payloadSha256})+'\n';fs.writeFileSync(journal,line);
 const before=fs.readFileSync(journal);const r=measureTrainingCoverage(d);
 assert.equal(r.complete,true);assert.equal(r.decisions,1);assert.equal(r.exactComparable,1);
 assert.deepEqual(fs.readFileSync(journal),before);
 fs.writeFileSync(journal,line+line);assert.throws(()=>measureTrainingCoverage(d),{code:'COVERAGE_EVIDENCE_INVALID'});
 assert.equal(fs.readFileSync(journal,'utf8'),line+line);
 assert.throws(()=>measureTrainingCoverage('relative'),{code:'COVERAGE_EVIDENCE_INVALID'});
 for(const change of [x=>x.summary.coverage.metricEligible=false,x=>x.summary.source.version='1.0.0']){
  const forged=structuredClone(item);change(forged);assert.throws(()=>materializeLearningEvaluation(d,forged));
 }
});
test('v2 projected and unavailable explanations cannot introduce grades or numerical claims',()=>{
 for(const amount of [400,600]){
  const snapshot=snap();snapshot.chosenAction={action:'raise',amount};
  const e=evaluatePreflopReference(snapshot,data,{gameEpoch:epoch});
  assert.equal(referenceAssessmentEligibility(e).metricEligible,false);
  assert.equal(validateExplanation(e,'투영 또는 범위 밖 선택이므로 점수를 제공하지 않습니다.').ok,true);
  assert.equal(validateExplanation(e,'직접 비교한 주력 선택입니다.').ok,false);
  assert.equal(validateExplanation(e,'레이즈 빈도 80%입니다.').ok,false);
  assert.equal(validateExplanation(e,`핸드 ${e.handNo}의 선택은 점수에서 제외됩니다.`).ok,true);
  delete e.coverage;assert.equal(validateExplanation(e,'참고 자료입니다.').code,'REFERENCE_SOURCE_UNVERIFIED');
 }
});
