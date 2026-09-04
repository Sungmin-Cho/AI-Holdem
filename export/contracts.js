export const EXPORT_MAX_BYTES = 4 * 1024 * 1024;

// unsupported: record the reason and exclude the hand from rendered text.
// warning: record the reason but keep the hand in rendered text.
const LEGAL_ACTIONS = new Set(['fold', 'check', 'call', 'raise']);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function validateCanonicalHand(hand) {
  if (!hand || !Number.isInteger(hand.handNo)) {
    return { exportStatus: 'unsupported', reason: 'missing handNo' };
  }
  if (!Array.isArray(hand.seats) || hand.seats.length < 2) {
    return { exportStatus: 'unsupported', reason: 'not enough seats' };
  }
  if (!Array.isArray(hand.blinds) || hand.blinds.length !== 2) {
    return { exportStatus: 'unsupported', reason: 'missing blinds' };
  }
  if (!Array.isArray(hand.posts)) {
    return { exportStatus: 'unsupported', reason: 'legacy archive: missing posts' };
  }
  if (!isPlainObject(hand.uncalledReturns)) {
    return { exportStatus: 'unsupported', reason: 'legacy archive: missing uncalledReturns' };
  }
  for (const action of hand.actions ?? []) {
    if (!LEGAL_ACTIONS.has(action.action)) {
      return { exportStatus: 'unsupported', reason: 'nonstandard action' };
    }
    if (action.action === 'raise' && !Number.isFinite(action.currentBet)) {
      return { exportStatus: 'unsupported', reason: 'legacy archive: raise without currentBet' };
    }
  }
  return { exportStatus: 'ok' };
}

export function warningsFor(hand) {
  const sum = (stacks) => Object.values(stacks ?? {}).reduce((total, value) => total + value, 0);
  if (sum(hand.startStacks) !== sum(hand.endStacks)) {
    return { exportStatus: 'warning', reason: 'chip conservation mismatch' };
  }
  return null;
}
