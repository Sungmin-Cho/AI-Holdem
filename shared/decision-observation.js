import { createHash } from 'node:crypto';
import { SAFE_ACTION_KEYS } from './hand-replay.js';
import { projectAssistance } from './assistance.js';
import {dealSelectionFields} from './deal-selection.js';

export function hintError(code = 'HINT_SNAPSHOT_INVALID') {
  return Object.assign(new Error(code), { code });
}
export function closed(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw hintError();
}
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw hintError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw hintError();
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw hintError();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export const hashCanonical = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const ROOT = ['schemaVersion','decisionId','gameMode','handNo','actorId','street','position','holeCards','board',
  'blinds','potBefore','currentBet','actorBet','toCall','minRaiseTo','maxRaiseTo','effectiveStack','publicSeats','priorActions','legal'];
const SEAT = ['playerId','position','stack','bet','contribution','folded','allIn','out'];
const LEGAL = ['decisionId','canCheck','canRaise','callAmount','minRaiseTo','maxRaiseTo'];
const PRIOR = ['playerId','decisionId','action','amount','street'];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const chips = value => Number.isSafeInteger(value) && value >= 0;
export function projectDecisionObservation(snapshot) {
  closed(snapshot, [...ROOT, 'forced'], ['chosenAction', 'assistance','dealSelection','dealSelectionContractVersion']);
  dealSelectionFields(snapshot);
  if (snapshot.schemaVersion !== 2 || typeof snapshot.forced !== 'boolean') throw hintError();
  if (snapshot.assistance !== undefined) projectAssistance(snapshot.assistance);
  if (snapshot.chosenAction !== undefined) closed(snapshot.chosenAction, ['action','amount']);
  closed(snapshot.legal, LEGAL);
  if (!Array.isArray(snapshot.publicSeats) || snapshot.publicSeats.length > 10
    || !Array.isArray(snapshot.priorActions) || snapshot.priorActions.length > 1000) throw hintError();
  const result = pick(snapshot, ROOT);
  result.publicSeats = snapshot.publicSeats.map(seat => { closed(seat, SEAT); return pick(seat, SEAT); })
    .sort((a,b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
  result.priorActions = snapshot.priorActions.map(action => {
    closed(action, PRIOR, SAFE_ACTION_KEYS.filter(key => !PRIOR.includes(key)));
    if (action.board !== undefined && (!Array.isArray(action.board) || action.board.some(card => !/^[2-9TJQKA][cdhs]$/i.test(card)))) throw hintError();
    if (action.stacks !== undefined && (!action.stacks || Array.isArray(action.stacks)
      || typeof action.stacks !== 'object' || Object.values(action.stacks).some(n => !chips(n)))) throw hintError();
    return pick(action, PRIOR);
  });
  // Validate even allowed-but-unhashed values (no undefined or non-JSON numbers).
  canonicalJson(snapshot);
  return result;
}
export const observationHash = snapshot => hashCanonical(projectDecisionObservation(snapshot));
export function exposureIdentity({ gameEpoch, decisionId, source, observationSha256, recommendationSha256 }) {
  return hashCanonical({ schemaVersion: 1, gameEpoch, decisionId, source, observationSha256, recommendationSha256 });
}
