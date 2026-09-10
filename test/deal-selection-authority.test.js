import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hintFixture} from './helpers/hint-fixture.mjs';
import {evaluatePreflopReference} from '../training/preflop-reference.js';
import {loadReferenceDataset} from '../tools/preflop-dataset.js';
import {V2_REFERENCE_SOURCE} from '../shared/reference.js';
import {createTrainingControl,materializeLearningEvaluation} from '../tools/training-control.js';
import {eventFromEvaluation,eventForPrior} from '../training/profile-store.js';
import {applyEvent,emptyProfile,assertProfileEvent} from '../training/profile-aggregator.js';
import {independentAssessmentEligibility} from '../shared/assistance.js';
import {createProfileStore,createMistakeBank} from '../tools/training-stores.js';
import {studyHistory} from '../training/study-history.js';
test('canonical biased evaluations stay factual but excluded, and cannot strip or downgrade provenance',async t=>{
 const f=await hintFixture(t,{hints:'off',dealBias:'strong'});await f.prepare();
 f.cli('apply','user','fold');while(f.state().hand){const next=f.cli('step').next;f.cli('apply',next.toAct,'fold');}
 const record=f.state().lastHand,s=record.decisions.find(row=>row.actorId==='user');
 assert.equal(f.state().config.dealBias,'strong');
 assert.equal(record.dealSelection.mode,'strong');
 const ev=evaluatePreflopReference(s,loadReferenceDataset(V2_REFERENCE_SOURCE),{gameEpoch:f.epoch});
 const tc=createTrainingControl();
 for(const mutant of [{...ev,dealSelection:undefined},{...ev,dealSelection:undefined,dealSelectionContractVersion:undefined},
   {...ev,dealSelection:{...ev.dealSelection,mode:'off'}}]) {
   await assert.rejects(()=>tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'bias-test',handNo:1,evaluations:[mutant]}),{code:'DEAL_SELECTION_INVALID'});
 }
 await tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'bias-test',handNo:1,evaluations:[ev]});
 const m=materializeLearningEvaluation(f.dir,tc.loadAuthority(f.dir).items[ev.evaluationId]);
 assert.equal(m.dealSelection.mode,'strong');
 const event=eventFromEvaluation(m,'2026-09-11T00:00:00.000Z');
 assert.equal(event.schemaVersion,7);
 assert.equal(independentAssessmentEligibility(event).reason,'BIASED_DEAL');
 for(const assistance of [undefined,{schemaVersion:1}]) {
   const invalid=independentAssessmentEligibility({...event,assistance});
   assert.equal(invalid.verified,false);assert.equal(invalid.metricEligible,false);
 }
 const p=applyEvent(emptyProfile(),event);
 assert.equal(p.game.coverage.biasedDecisions,1);
 assert.equal(p.game.coverage.exactComparableDecisions,0);
 assert.deepEqual(p.game.skills,{});
 const store=createProfileStore(f.dir),bank=createMistakeBank(f.dir);
 await store.apply(m);
 assert.equal((await store.show()).game.coverage.exactComparableDecisions,0);
 assert.deepEqual(await bank.collect({...m,grade:'off-policy'}),{added:false,item:null});
 const history=studyHistory(await store.readEventSnapshot(),'2026-09-12T00:00:00.000Z');
 assert.equal(history.goal.origin,'default');
 assert.deepEqual(history.assessments,[]);assert.deepEqual(history.retests,[]);
 const stripped={...event};delete stripped.dealSelection;delete stripped.dealSelectionContractVersion;
 assert.throws(()=>assertProfileEvent(stripped),{code:'PROFILE_EVENT_INVALID'});
 assert.throws(()=>eventForPrior(m,{...stripped,schemaVersion:6}),{code:'PROFILE_EVENT_CONFLICT'});
 const legacy={...m};delete legacy.dealSelection;delete legacy.dealSelectionContractVersion;
 assert.throws(()=>eventForPrior(legacy,event),{code:'PROFILE_EVENT_CONFLICT'});
 assert.throws(()=>eventForPrior({...m,dealSelection:{...m.dealSelection,mode:'off'}},event),{code:'PROFILE_EVENT_CONFLICT'});
});

test('new default off contract remains independently learnable end to end',async t=>{
 const f=await hintFixture(t,{hints:'off',dealBias:'off'});await f.prepare();
 f.cli('apply','user','fold');while(f.state().hand){const next=f.cli('step').next;f.cli('apply',next.toAct,'fold');}
 const s=f.state().lastHand.decisions.find(row=>row.actorId==='user');
 const ev=evaluatePreflopReference(s,loadReferenceDataset(V2_REFERENCE_SOURCE),{gameEpoch:f.epoch});
 const tc=createTrainingControl();await tc.acceptEvaluations(f.dir,{gameEpoch:f.epoch,owner:'off-test',handNo:1,evaluations:[ev]});
 const m=materializeLearningEvaluation(f.dir,tc.loadAuthority(f.dir).items[ev.evaluationId]);
 const store=createProfileStore(f.dir);await store.apply(m);
 const [event]=await store.readEventSnapshot();
 assert.equal(event.schemaVersion,7);assert.equal(event.dealSelection.mode,'off');
 assert.equal(independentAssessmentEligibility(event).metricEligible,true);
 assert.equal((await store.show()).game.coverage.exactComparableDecisions,1);
});
