import {createHash} from 'node:crypto';
import {openContained} from './training-store.js';
export const validRecoveryOperation = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const closedRecord = (value, keys) => value !== null && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).every(key=>keys.includes(key));
const validTimestamp = value => typeof value==='string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString()===value;
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
    || !['BAD_PLAYER_RECOVERY','ROOM_UNBOUND'].includes(audit?.reason) || typeof audit?.unverifiedSnapshot!=='boolean'
    || (engine?.result==='abort' && (engine.gameOver!==true || engine.abortOperationId!==checkpoint.operationId))
    || (abortModeFor(engine,state)!==checkpoint.mode && !(engine?.result==='abort' && checkpoint.mode==='abort'))) return null;
  try {
    const bytes=openContained(root,[audit.sidecar],{maxBytes:Number.MAX_SAFE_INTEGER});
    return createHash('sha256').update(bytes).digest('hex')===audit.sha256 ? {...checkpoint} : null;
  } catch {return null;}
}
