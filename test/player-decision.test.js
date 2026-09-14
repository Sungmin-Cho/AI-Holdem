import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../tools/player-decision.js';
const next = { decisionId:'d-15-flop-8', message:'decisionId: d-15-flop-8\n홀카드: As Ad\n가능한 액션: fold / check / raise 200~4275\nlegal 수치: canCheck=true callAmount=0 canRaise=true minRaiseTo=200 maxRaiseTo=4275 currentBet=0' };
const raw = (patch={}) => JSON.stringify({ decisionId:next.decisionId, action:'bet', amount:600, reason:'A-high C-bet 압박', ...patch });
const ctx = { generation:2, decisionId:next.decisionId, gameEpoch:'epoch' };
const record = (patch={}) => ({v:1,generation:1,callNo:1,code:'INVALID_DECISION',detail:'bet_ambiguous',decisionId:ctx.decisionId,gameEpoch:ctx.gameEpoch,projection:{action:'bet',amount:600,decisionIdMatches:true},at:'2026-09-14T00:00:00Z',...patch});
const pending = (patch={}) => ({schemaVersion:2,...ctx,status:'running',diagnostics:{v:1,callNo:1,corrections:0,lastRejection:record()},...patch});
test('#194 normalizes only unopened-street bet and preserves reason', () => {
  assert.deepEqual(d.classifyDecision(raw(),next),{ok:true,action:{action:'raise',amount:600,reason:'A-high C-bet 압박',normalizedFrom:'bet'}});
  for (const [suffix,detail] of [['200','bet_ambiguous'],['','bet_unavailable']]) {
    const n={...next,message:next.message.replace(' currentBet=0',suffix ? ` currentBet=${suffix}` : '')};
    assert.equal(d.classifyDecision(raw(),n).rejection.detail,detail);
  }
  assert.equal(d.validatedDecision(raw(),next).action,'raise');
});
test('#194 classification priority and every response rejection', () => {
  const cases=[['legal_line_missing',raw(),{...next,message:''}],['no_json','As Ad SECRET'],['decision_id_mismatch',raw({decisionId:'SECRET',action:'wrong'})],['unknown_action',raw({action:'SECRET'})],['check_not_allowed',raw({action:'check'}),{...next,message:next.message.replace('canCheck=true','canCheck=false')}],['call_not_allowed',raw({action:'call'})],['raise_not_allowed',raw(),{...next,message:next.message.replace('canRaise=true','canRaise=false')}],['amount_not_integer',raw({amount:'600'})],['amount_out_of_range',raw({amount:5000})]];
  for(const [detail,value,n=next] of cases) assert.equal(d.classifyDecision(value,n).rejection.detail,detail);
  assert.equal(d.REJECTION_DETAILS.length,12);
  assert.equal(d.CORRECTABLE_DETAILS.has('legal_line_missing'),false);
  const short={...next,message:next.message.replace('minRaiseTo=200 maxRaiseTo=4275','minRaiseTo=200 maxRaiseTo=120')};
  assert.equal(d.classifyDecision(raw({amount:120}),short).ok,true);
  assert.equal(d.classifyDecision(raw({amount:200}),short).rejection.detail,'amount_out_of_range');
});
test('#194 raw diagnostics have a closed schema and scan beyond the bucket prefix', () => {
  assert.deepEqual(d.rawDiagnostics(42),{kind:'not_string',lengthBucket:null,hasObjectCandidate:false});
  for(const [n,b] of [[0,'lt64'],[63,'lt64'],[64,'lt256'],[255,'lt256'],[256,'lt1024'],[1023,'lt1024'],[1024,'ge1024'],[2000,'ge1024']]) {
    const x=d.rawDiagnostics('😀'.repeat(n)); assert.equal(x.lengthBucket,b); assert.equal(d.validateRawDiagnostics(x).ok,true);
  }
  assert.deepEqual(d.rawDiagnostics('x'.repeat(2000)+'{'),{kind:'unparseable_object',lengthBucket:'ge1024',hasObjectCandidate:true});
  assert.equal(d.validateRawDiagnostics({...d.rawDiagnostics('x'),raw:'SECRET'}).ok,false);
});
test('#194 projections exclude untrusted strings and sink results are frozen', () => {
  for(const action of ['As Ad SECRET','RAISE']) assert.equal(d.safeRejectionProjection({action},next).action,'unknown');
  for(const amount of ['600',1e21,NaN]) assert.equal(Object.hasOwn(d.safeRejectionProjection({amount},next),'amount'),false);
  assert.equal(d.safeRejectionProjection({action:'all-in'},next).action,'all-in');
  const safe=d.projectRejectionForSink(record(),ctx); assert.ok(safe); assert.ok(Object.isFrozen(safe.projection));
  assert.throws(()=>{safe.raw='SECRET';},TypeError);
  for(const bad of [record({raw:'SECRET'}),record({reason:'SECRET'}),record({projection:{action:'SECRET',decisionIdMatches:false}}),record({gameEpoch:'other'}),record({decisionId:'other'})]) assert.equal(d.projectRejectionForSink(bad,ctx),null);
});
test('#194 diagnostic validation distinguishes legacy, malformed and valid records', () => {
  assert.equal(d.validateDiagnostics(undefined,{schemaVersion:1}).ok,true);
  assert.equal(d.validateDiagnostics(null,{schemaVersion:1,diagnostics:null}).reason,'legacy_with_diagnostics');
  assert.equal(d.validateDiagnostics(undefined,{schemaVersion:2}).reason,'missing');
  for(const value of [null,0,'']) assert.equal(d.validateDiagnostics(value,pending({diagnostics:value})).ok,false);
  assert.equal(d.validateDiagnostics(pending().diagnostics,pending()).ok,true);
  for(const patch of [{callNo:4},{corrections:1},{detail:'no_json'},{extra:'SECRET'},{lastRejection:record({gameEpoch:'other'})}]) {
    const p=pending(); Object.assign(p.diagnostics,patch); assert.equal(d.validateDiagnostics(p.diagnostics,p).ok,false);
  }
  const p=pending({status:'recovery_required',code:'INVALID_DECISION'}); assert.equal(d.retryWillCorrect(p),true);
  p.diagnosticsQuarantined=true; assert.equal(d.retryWillCorrect(p),false);
});
