import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGame, startHand, legalFor, applyAction, blindsForLevel } from '../engine/hand.js';
import { snapshotDecision } from '../engine/decision.js';
import { exposeHint } from '../engine/hint-exposure.js';
import { observationHash } from '../shared/decision-observation.js';
import { gameEpochOf } from '../publish-contract.js';
import { buildPreActionHint, recommendationHash } from '../training/pre-action-hint.js';
import { V2_REFERENCE_SOURCE } from '../shared/reference.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { verifyDecisionAssistance } from '../tools/assistance-proof.js';
const CLI = new URL('../engine/cli.js',import.meta.url).pathname;
const data = loadReferenceDataset(V2_REFERENCE_SOURCE);
function setup() {
  let state = createGame({aiCount:5,mode:'cash-training',levelEvery:null,hints:'on'});
  state.button=2; state=startHand(state).state;
  while(legalFor(state).toAct!=='user') state=applyAction(state,legalFor(state).toAct,'fold').state;
  const snapshot=snapshotDecision(state,'user',null,{legal:legalFor(state),blinds:blindsForLevel(state.level,state.config.blinds0)});
  const hint=buildPreActionHint(snapshot,data,{gameEpoch:gameEpochOf(state.sessionToken),stateVersion:state.stateVersion});
  assert.equal(hint.status,'supported');
  const meta={schemaVersion:1,gameEpoch:hint.gameEpoch,decisionId:hint.decisionId,source:hint.source,
    observationSha256:observationHash(snapshot),recommendationSha256:recommendationHash(hint)};
  return {state,meta};
}
test('engine stores its own observation before action and archives marker with assistance', () => {
  let {state,meta}=setup(); const options={playerId:'user',decisionId:meta.decisionId,expectVersion:state.stateVersion};
  const marker=exposeHint(state,meta,options);
  assert.equal(marker.observationSnapshot.assistance.hintShown,false);
  assert.equal(marker.observationSnapshot.chosenAction,undefined);
  assert.equal(exposeHint(state,meta,options).exposureId,marker.exposureId);
  assert.equal(Object.keys(state.hand.hintExposures).length,1);
  assert.throws(()=>exposeHint(state,{...meta,recommendationSha256:'b'.repeat(64)},options),{code:'HINT_EXPOSURE_CONFLICT'});
  state=applyAction(state,'user','fold').state;
  while(state.hand) state=applyAction(state,legalFor(state).toAct,'fold').state;
  assert.equal(state.lastHand.decisions[0].assistance.exposureId,marker.exposureId);
  assert.deepEqual(state.lastHand.hintExposures[meta.decisionId],marker);
  const decision=state.lastHand.decisions[0];
  const proof={gameEpoch:meta.gameEpoch,source:meta.source,required:true};
  assert.equal(verifyDecisionAssistance(state.lastHand,decision,proof).hintShown,true);
  for (const assistance of [undefined,{schemaVersion:1,hintShown:false,exposureId:null},
    {schemaVersion:1,hintShown:true,exposureId:'f'.repeat(64)}]) {
    assert.throws(()=>verifyDecisionAssistance(state.lastHand,{...decision,assistance},proof),{code:'ASSISTANCE_INVALID'});
  }
  const missing=structuredClone(state.lastHand);delete missing.hintExposures;
  assert.throws(()=>verifyDecisionAssistance(missing,decision,proof),{code:'ASSISTANCE_INVALID'});
});
test('CLI mutation increments version, retries keep one marker, and stale request cannot mutate', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hint-engine-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {state,meta}=setup();fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state));
  const file=path.join(dir,'hint-meta.json');fs.writeFileSync(file,JSON.stringify(meta));
  const args=['hint-expose','--game-dir',dir,'--for','user','--decision-id',meta.decisionId,'--hint-meta-file',file];
  const call=v=>JSON.parse(execFileSync(process.execPath,[CLI,...args,'--expect-version',String(v)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const a=call(state.stateVersion);assert.equal(a.stateVersion,state.stateVersion+1);
  assert.equal(a.view.legal.stateVersion,a.stateVersion);
  const b=call(a.stateVersion);assert.equal(b.stateVersion,a.stateVersion+1);assert.equal(a.exposureId,b.exposureId);
  const before=fs.readFileSync(path.join(dir,'state.json'),'utf8');
  assert.throws(()=>call(state.stateVersion));assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);
  assert.equal(Object.keys(JSON.parse(before).hand.hintExposures).length,1);
});
