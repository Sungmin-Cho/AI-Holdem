import { playerBudget } from './player-budget.js';
const keys = ['schemaVersion', 'runtime', 'executionKind', 'gameEpoch', 'decisionId', 'stateVersion',
  'playerId', 'generation', 'status', 'budget', 'startedAt', 'softWait', 'code', 'closeConfirmed', 'proposedAction', 'retryable'];
export function validJevPending(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))
    || p.schemaVersion !== 3 || p.runtime !== 'jev' || p.executionKind !== 'http'
    || !['running', 'recovery_required', 'retry_authorized', 'unsafe'].includes(p.status)
    || ['gameEpoch', 'decisionId', 'playerId'].some(k => typeof p[k] !== 'string' || !p[k])
    || !Number.isSafeInteger(p.stateVersion) || p.stateVersion < 0
    || !Number.isSafeInteger(p.generation) || p.generation < 1
    || typeof p.startedAt !== 'string' || !Number.isFinite(Date.parse(p.startedAt))
    || (p.status !== 'running' && typeof p.retryable !== 'boolean')
    || ['softWait', 'closeConfirmed', 'retryable'].some(k => k in p && typeof p[k] !== 'boolean')
    || ('code' in p && (typeof p.code !== 'string' || !/^[A-Z_]+$/.test(p.code)))) return false;
  if (!p.budget || typeof p.budget !== 'object' || Object.keys(p.budget).length !== 2
    || !Object.hasOwn(p.budget, 'softMs') || !Object.hasOwn(p.budget, 'hardMs')) return false;
  if (p.proposedAction && (p.retryable === true || ['recovery_required', 'retry_authorized'].includes(p.status))) return false;
  try { playerBudget(p.budget); } catch { return false; }
  if (Object.hasOwn(p, 'proposedAction')) {
    const a = p.proposedAction;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
    if (!['fold', 'check', 'call', 'raise'].includes(a.action)
      || Object.keys(a).some(k => !['action', 'amount'].includes(k))
      || (a.action === 'raise' && (!Number.isSafeInteger(a.amount) || a.amount < 0))
      || (a.action !== 'raise' && 'amount' in a)) return false;
  }
  return true;
}
export function sameJevIdentity(a, b) {
  return !!a && !!b && ['gameEpoch', 'decisionId', 'stateVersion', 'playerId', 'generation']
    .every(k => a[k] === b[k]);
}
