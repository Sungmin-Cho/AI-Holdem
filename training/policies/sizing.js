import { clampRaiseTo, coded } from './contracts.js';

function requireInteger(value, field) {
  if (!Number.isInteger(value)) throw coded('POLICY_SNAPSHOT_INVALID', field);
  return value;
}

function actionsOnStreet(snapshot) {
  const prior = snapshot?.priorActions;
  if (!Array.isArray(prior)) throw coded('POLICY_SNAPSHOT_INVALID', 'priorActions');
  return prior.filter((action) => action?.street == null || action.street === snapshot.street);
}

export function roundToUnit(value, unit) {
  const step = Number.isInteger(unit) && unit > 0 ? unit : 1;
  return Math.round(value / step) * step;
}

export function raiseTargetFor(snapshot, legal) {
  const street = actionsOnStreet(snapshot);
  if (snapshot?.street === 'preflop') {
    const raises = street.filter((action) => action?.action === 'raise');
    const lastRaiseIndex = street.reduce(
      (found, action, index) => (action?.action === 'raise' ? index : found),
      -1,
    );
    const callsAfter = (lastRaiseIndex < 0 ? street : street.slice(lastRaiseIndex + 1))
      .filter((action) => action?.action === 'call');
    const bb = requireInteger(snapshot?.blinds?.[1], 'blinds[1]');
    if (raises.length === 0) {
      if (callsAfter.length === 0) return { rule: 'open-2.5bb', target: 2.5 * bb };
      return { rule: 'iso', target: (2.5 + callsAfter.length) * bb };
    }
    if (raises.length === 1) {
      const openTo = requireInteger(raises[0].amount, 'raise.amount');
      if (callsAfter.length === 0) return { rule: '3bet-3.4x', target: 3.4 * openTo };
      return { rule: 'squeeze', target: (3.4 + callsAfter.length) * openTo };
    }
    if (raises.length === 2) {
      return { rule: '4bet-2.3x', target: 2.3 * requireInteger(raises[1].amount, 'raise.amount') };
    }
    return { rule: '5bet-allin', target: requireInteger(legal?.maxRaiseTo, 'maxRaiseTo') };
  }

  if (snapshot?.currentBet === 0) {
    return { rule: 'bet-2/3-pot', target: (2 / 3) * requireInteger(snapshot?.potBefore, 'potBefore') };
  }
  const actorBet = requireInteger(snapshot?.actorBet, 'actorBet');
  const toCall = requireInteger(snapshot?.toCall, 'toCall');
  const potBefore = requireInteger(snapshot?.potBefore, 'potBefore');
  return {
    rule: 'raise-3/4-pot',
    target: actorBet + toCall + 0.75 * (potBefore + toCall),
  };
}

export function raiseToFor(snapshot, legal) {
  const { rule, target } = raiseTargetFor(snapshot, legal);
  const rounded = roundToUnit(target, snapshot?.blinds?.[0]);
  if (!legal?.canRaise) return { rule, target, raiseTo: null };
  return { rule, target, raiseTo: clampRaiseTo(rounded, legal) };
}
