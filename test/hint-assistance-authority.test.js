import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {hintFixture} from './helpers/hint-fixture.mjs';
import {evaluatePreflopReference} from '../training/preflop-reference.js';
import {loadReferenceDataset} from '../tools/preflop-dataset.js';
import {V2_REFERENCE_SOURCE} from '../shared/reference.js';
import {createTrainingControl,materializeLearningEvaluation} from '../tools/training-control.js';
import {eventFromEvaluation} from '../training/profile-store.js';

test('canonical hinted archive survives accept/materialize and rejects omitted or false assistance',async t=>{
 const f=await hintFixture(t);await f.prepare();
 let e=f.cli('apply','user','fold');
 while(f.state().hand){const next=f.cli('step').next;e=f.cli('apply',next.toAct,'fold');}
 const record=f.state().lastHand,s=record.decisions.find(row=>row.actorId==='user');
 const evaluated=evaluatePreflopReference(s,loadReferenceDataset(V2_REFERENCE_SOURCE),{gameEpoch:f.epoch});
 const tc=createTrainingControl();
 for(const assistance of [undefined,{schemaVersion:1,hintShown:false,exposureId:null}]) {
  await assert.rejects(()=>tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'hint-test',handNo:record.handNo,evaluations:[{...evaluated,assistance}]}),{code:'ASSISTANCE_INVALID'});
 }
 await tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'hint-test',handNo:record.handNo,evaluations:[evaluated]});
 const item=tc.loadAuthority(f.dir).items[evaluated.evaluationId];
 const materialized=materializeLearningEvaluation(f.dir,item);
 assert.equal(materialized.assistance.hintShown,true);
 assert.equal(eventFromEvaluation(materialized,'2026-09-08T00:00:00.000Z').assistance.hintShown,true);
 const archive=path.join(f.dir,'hands',`hand-${String(record.handNo).padStart(4,'0')}.json`);
 if(fs.existsSync(archive))fs.unlinkSync(archive);
 assert.equal(materializeLearningEvaluation(f.dir,item).assistance.hintShown,true,'lastHand fallback remains authoritative');
 const state=f.state();delete state.lastHand.hintExposures;fs.writeFileSync(path.join(f.dir,'state.json'),JSON.stringify(state));
 assert.throws(()=>materializeLearningEvaluation(f.dir,item),{code:'ASSISTANCE_INVALID'});
});

test('default off contract archives explicit false and remains independently learnable',async t=>{
 const f=await hintFixture(t,{hints:'off'});const e=await f.prepare();assert.equal(e.hint,undefined);
 f.cli('apply','user','fold');while(f.state().hand){const next=f.cli('step').next;f.cli('apply',next.toAct,'fold');}
 const record=f.state().lastHand;assert.deepEqual(record.hintExposures,{});
 const s=record.decisions.find(row=>row.actorId==='user'),tc=createTrainingControl();
 const ev=evaluatePreflopReference(s,loadReferenceDataset(V2_REFERENCE_SOURCE),{gameEpoch:f.epoch});
 await tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'off-test',handNo:1,evaluations:[ev]});
 const m=materializeLearningEvaluation(f.dir,tc.loadAuthority(f.dir).items[ev.evaluationId]);
 assert.deepEqual(m.assistance,{schemaVersion:1,hintShown:false,exposureId:null});
 const {independentAssessmentEligibility}=await import('../shared/assistance.js');
 assert.equal(independentAssessmentEligibility(m).metricEligible,true);
 const {assistance,...undeclared}=m;
 assert.throws(()=>eventFromEvaluation({...undeclared,origin:'practice'},'2026-09-08T00:00:00.000Z'),{code:'ASSISTANCE_INVALID'});
});
