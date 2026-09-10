import { referenceAssessmentEligibility } from './reference-coverage.js';
import {dealSelectionDisposition,dealSelectionFields} from './deal-selection.js';

export const NO_HINT_ASSISTANCE = Object.freeze({ schemaVersion: 1, hintShown: false, exposureId: null });
export function assistanceError() {
  const error = new Error('Assistance evidence is unavailable');
  error.code = 'ASSISTANCE_INVALID';
  return error;
}
export function projectAssistance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'exposureId,hintShown,schemaVersion'
    || value.schemaVersion !== 1 || typeof value.hintShown !== 'boolean'
    || (value.hintShown ? !/^[a-f0-9]{64}$/.test(value.exposureId) : value.exposureId !== null)) {
    throw assistanceError();
  }
  return { schemaVersion: 1, hintShown: value.hintShown, exposureId: value.exposureId };
}
/** Structural eligibility, after the caller has verified the canonical origin.
 * A schema-6 event cannot fall back to historical omission. */
export function independentAssessmentEligibility(event) {
  const reference = referenceAssessmentEligibility(event);
  let result=reference;
  try {
    if (!Object.hasOwn(event, 'assistance')) {
      if (event.schemaVersion >= 6 || event.hintContractVersion != null) throw assistanceError();
    } else {
      const assistance = projectAssistance(event.assistance);
      result = { ...reference, metricEligible: reference.metricEligible && !assistance.hintShown,
        reason: assistance.hintShown ? 'ASSISTED_DECISION' : reference.reason };
    }
  } catch {
    return { ...reference, verified: false, metricEligible: false, reason: 'ASSISTANCE_INVALID' };
  }
  const deal=dealSelectionDisposition(event);
  if(deal!=='independent') return {...result,verified:deal!=='unavailable' && result.verified,
    metricEligible:false,reason:deal==='biased'?'BIASED_DEAL':'DEAL_SELECTION_INVALID'};
  return result;
}

export function assistanceAllowsIndependent(event) {
  if(dealSelectionDisposition(event)!=='independent') return false;
  try {
    if (event.assistance === undefined) return !(event.schemaVersion >= 6) && event.hintContractVersion == null;
    return !projectAssistance(event.assistance).hintShown;
  } catch { return false; }
}

export function decisionAssistance(hand, decisionId) {
  if (hand?.hintContractVersion !== 1) {
    if (hand?.hintContractVersion != null || hand?.hintExposures != null) throw assistanceError();
    return undefined;
  }
  if (!hand.hintExposures || typeof hand.hintExposures !== 'object' || Array.isArray(hand.hintExposures)) throw assistanceError();
  const marker = hand.hintExposures[decisionId];
  return marker == null ? { ...NO_HINT_ASSISTANCE }
    : projectAssistance({ schemaVersion: 1, hintShown: true, exposureId: marker.exposureId });
}

export function handAssistanceDisposition(record) {
  const deal=dealSelectionDisposition(record);
  if(deal!=='independent') return deal==='biased'?'assisted':'unavailable';
  const decisions = (record?.decisions ?? []).filter(row => row.actorId === 'user');
  try {
    const expected=JSON.stringify(dealSelectionFields(record));
    if(decisions.some(row=>JSON.stringify(dealSelectionFields(row))!==expected)) return 'unavailable';
  } catch {return 'unavailable';}
  if (record?.hintContractVersion == null && record?.hintExposures == null
    && decisions.every(row => row.assistance === undefined)) return 'independent';
  try {
    if (record.hintContractVersion !== 1 || !record.hintExposures) throw assistanceError();
    if (Object.keys(record.hintExposures).length) return 'assisted';
    const actions = (record.actions ?? []).filter(row => row.playerId === 'user');
    if (actions.length !== decisions.length) throw assistanceError();
    for (const row of decisions) {
      if (!actions.some(action => action.decisionId === row.decisionId)
        || projectAssistance(row.assistance).hintShown) throw assistanceError();
    }
    return 'independent';
  } catch { return 'unavailable'; }
}
