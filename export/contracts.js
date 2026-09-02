export const EXPORT_MAX_BYTES = 4 * 1024 * 1024;

const LEGAL_ACTIONS = new Set(['fold', 'check', 'call', 'raise']);

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
  for (const action of hand.actions ?? []) {
    if (!LEGAL_ACTIONS.has(action.action)) {
      return { exportStatus: 'unsupported', reason: 'nonstandard action' };
    }
  }
  return { exportStatus: 'ok' };
}
