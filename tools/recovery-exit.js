import {createHash} from 'node:crypto';
import {openContained} from './training-store.js';
// #260 START_FAILED: a committed game that never dealt a hand, ended from any error.
export const ABANDON_REASONS = Object.freeze(['BAD_PLAYER_RECOVERY','ROOM_UNBOUND','START_FAILED']);
export const validRecoveryOperation = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const closedRecord = (value, keys) => value !== null && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).every(key=>keys.includes(key));
const validTimestamp = value => typeof value==='string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString()===value;
// #260: a committed game whose loop never left bootstrap and whose engine never
// started a hand has no decision to lose.
export function neverDealt(engine, state) {
  return engine?.gameOver === false && engine.handNo === 0 && engine.hand == null
    && state?.phase === 'bootstrap' && !Object.hasOwn(state, 'pendingDecision');
}
// Engine/loop lifecycle only: never inspect the unverifiable pending subtree.
export function abortModeFor(engine, state) {
  if (engine?.gameOver === false && ['bootstrap', 'playing'].includes(state?.phase)) return 'abort';
  if (engine?.gameOver === true && ['playing', 'finalizing', 'review_generated', 'review_published'].includes(state?.phase)) return 'finalize';
  return null;
}
export function validateAbortingCheckpoint(root, engine, state) {
  const checkpoint=state?.aborting, audit=state?.abandonedPendingDecision;
  if (!closedRecord(checkpoint,['operationId','mode']) || !validRecoveryOperation(checkpoint.operationId)
    || Object.hasOwn(state,'pendingDecision')
    || !closedRecord(audit,['operationId','mode','sidecar','sha256','reason','unverifiedSnapshot','abandonedAt'])
    || !validTimestamp(audit.abandonedAt)
    || !['abort','finalize'].includes(checkpoint.mode)
    || audit?.operationId!==checkpoint.operationId || audit?.mode!==checkpoint.mode
    || audit?.sidecar!==`loop-state.abandoned.${checkpoint.operationId}.json`
    || !/^[a-f0-9]{64}$/.test(audit?.sha256 ?? '')
    || !ABANDON_REASONS.includes(audit?.reason) || typeof audit?.unverifiedSnapshot!=='boolean'
    || (engine?.result==='abort' && (engine.gameOver!==true || engine.abortOperationId!==checkpoint.operationId))
    || (abortModeFor(engine,state)!==checkpoint.mode && !(engine?.result==='abort' && checkpoint.mode==='abort'))) return null;
  try {
    const bytes=openContained(root,[audit.sidecar],{maxBytes:Number.MAX_SAFE_INTEGER});
    return createHash('sha256').update(bytes).digest('hex')===audit.sha256 ? {...checkpoint} : null;
  } catch {return null;}
}
