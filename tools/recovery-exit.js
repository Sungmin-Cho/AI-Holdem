import {createHash} from 'node:crypto';
import {openContained} from './training-store.js';
// #260 NEVER_DEALT: a committed game that never dealt a hand, ended from any error.
// #288 REVIEW_WAIVED: a result-final game whose finalization halted in the review stage.
export const ABANDON_REASONS = Object.freeze(['BAD_PLAYER_RECOVERY','ROOM_UNBOUND','NEVER_DEALT','REVIEW_WAIVED']);
// #288: halts the finalization raises after the result is final. A halt that carries
// operator recovery commands is not one: its unresolved coach worker halts the resume
// before the review stage is reached.
export const REVIEW_WAIVABLE_HALTS = Object.freeze(['FINALIZATION_ABORTED','REVIEW_GATE_CLOSED','REVIEW_FAILED','COACH_RECONCILE_PENDING']);
export const validRecoveryOperation = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const closedRecord = (value, keys) => value !== null && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).every(key=>keys.includes(key));
const validTimestamp = value => typeof value==='string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString()===value;
// #260: a committed game whose engine never started a hand has no decision to
// lose. Its loop may already say `playing`: a resume writes it before later steps
// that can still fail, and rebuilds a missing loop-state as `playing`.
export function neverDealt(engine, state) {
  return engine?.gameOver === false && engine.handNo === 0 && engine.hand == null && engine.lastHand == null
    && ['bootstrap', 'playing'].includes(state?.phase) && !Object.hasOwn(state, 'pendingDecision');
}
// #288: the engine result is final and the loop stopped in its finalization, so the game
// can be settled without its review. The result itself is never changed. The loop that
// halted must have stopped cleanly: its owner's coach runtime closure receipt proves the
// upper-model children it started (coach, review, explanation) were confirmed closed,
// which a fresh process cannot re-prove for a review child after an app restart.
export function reviewWaivable(engine, state) {
  return engine?.gameOver === true && ['completed', 'win', 'lose'].includes(engine.result)
    && ['finalizing', 'review_generated', 'review_published'].includes(state?.phase)
    && REVIEW_WAIVABLE_HALTS.includes(state?.halt?.code) && state.halt.recovery === undefined
    && state.cleanupError === undefined && state.cleanupFailedAt === undefined
    && typeof state.ownerSessionId === 'string' && state.ownerSessionId !== ''
    && Array.isArray(state.coachRuntimeClosures)
    && state.coachRuntimeClosures.some((entry) => entry?.ownerSessionId === state.ownerSessionId);
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
