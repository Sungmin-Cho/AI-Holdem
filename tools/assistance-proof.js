import { openContained } from './training-store.js';
import { decisionAssistance, projectAssistance, assistanceError } from '../shared/assistance.js';
import { observationHash, exposureIdentity } from '../shared/decision-observation.js';
import { sameReferenceSource } from '../shared/reference.js';
import { buildPreActionHint, recommendationHash } from '../training/pre-action-hint.js';
import { loadReferenceDataset } from './preflop-dataset.js';

export function verifyDecisionAssistance(record, snapshot, { gameEpoch, source, required = false } = {}) {
  const declared = record?.hintContractVersion != null || record?.hintExposures != null;
  if (!declared) {
    if (required || snapshot?.assistance !== undefined) throw assistanceError();
    return undefined;
  }
  if (record.handNo !== Number(snapshot.decisionId.split('-')[1]) || snapshot.actorId !== 'user') throw assistanceError();
  const expected = decisionAssistance(record,snapshot.decisionId);
  if (JSON.stringify(projectAssistance(snapshot.assistance)) !== JSON.stringify(expected)) throw assistanceError();
  if (expected.hintShown) {
    const marker = record.hintExposures[snapshot.decisionId];
    if (marker.schemaVersion !== 1 || !sameReferenceSource(marker.source,source)
      || observationHash(snapshot) !== marker.observationSha256
      || observationHash(marker.observationSnapshot) !== marker.observationSha256
      || Buffer.byteLength(JSON.stringify(marker.observationSnapshot)) > 16384) throw assistanceError();
    const hint = buildPreActionHint(marker.observationSnapshot,loadReferenceDataset(source),{gameEpoch,stateVersion:0});
    if (hint.status !== 'supported' || hint.exposureId !== marker.exposureId
      || recommendationHash(hint) !== marker.recommendationSha256
      || exposureIdentity({gameEpoch,decisionId:snapshot.decisionId,...marker}) !== marker.exposureId) throw assistanceError();
  }
  return expected;
}
export function verifyEvaluationAssistance(sessionDir, evaluation, handNo, gameEpoch) {
  let record, state;
  try { state=JSON.parse(openContained(sessionDir,['state.json'],{maxBytes:2*1024*1024})); }
  catch(error) { if(error.code!=='ENOENT') throw assistanceError(); }
  try { record=JSON.parse(openContained(sessionDir,['hands',`hand-${String(handNo).padStart(4,'0')}.json`],{maxBytes:2*1024*1024})); }
  catch(error) { if(error.code!=='ENOENT') throw assistanceError(); record=state?.lastHand?.handNo===handNo?state.lastHand:null; }
  const rows=(record?.decisions??[]).filter(row=>row.actorId==='user'&&row.decisionId===evaluation.decisionId);
  const required=state?.config?.hintContractVersion!=null || record?.hintContractVersion!=null || evaluation.assistance!==undefined;
  if (!required && !record?.hintExposures) return undefined;
  if (rows.length!==1) throw assistanceError();
  const assistance=verifyDecisionAssistance(record,rows[0],{gameEpoch,source:evaluation.source,required});
  if (JSON.stringify(assistance)!==JSON.stringify(projectAssistance(evaluation.assistance))) throw assistanceError();
  return assistance;
}
