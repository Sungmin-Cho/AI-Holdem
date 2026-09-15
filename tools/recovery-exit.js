import {createHash} from 'node:crypto';
import {openContained} from './training-store.js';
export const validRecoveryOperation = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Engine/loop lifecycle only: never inspect the unverifiable pending subtree.
export function abortModeFor(engine, state) {
  if (engine?.gameOver === false && ['bootstrap', 'playing'].includes(state?.phase)) return 'abort';
  if (engine?.gameOver === true && ['playing', 'finalizing', 'review_generated', 'review_published'].includes(state?.phase)) return 'finalize';
  return null;
}
export function validateAbortingCheckpoint(root, engine, state) {
  const checkpoint=state?.aborting, audit=state?.abandonedPendingDecision;
  if (!checkpoint || !validRecoveryOperation(checkpoint.operationId)
    || !['abort','finalize'].includes(checkpoint.mode)
    || audit?.operationId!==checkpoint.operationId || audit?.mode!==checkpoint.mode
    || audit?.sidecar!==`loop-state.abandoned.${checkpoint.operationId}.json`
    || !/^[a-f0-9]{64}$/.test(audit?.sha256 ?? '')
    || audit?.reason!=='BAD_PLAYER_RECOVERY' || typeof audit?.unverifiedSnapshot!=='boolean'
    || (abortModeFor(engine,state)!==checkpoint.mode && !(engine?.result==='abort' && checkpoint.mode==='abort'))) return null;
  try {
    const bytes=openContained(root,[audit.sidecar],{maxBytes:Number.MAX_SAFE_INTEGER});
    return createHash('sha256').update(bytes).digest('hex')===audit.sha256 ? {...checkpoint} : null;
  } catch {return null;}
}
