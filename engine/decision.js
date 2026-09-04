import { positionsOf } from './positions.js';

export const PRIOR_ACTION_KEYS = [
  'decisionId', 'playerId', 'action', 'amount', 'street', 'potTotal',
  'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks', 'currentBet',
];

function throwSnapshot(message) {
  const error = new Error(message);
  error.code = 'SNAPSHOT_INVALID';
  throw error;
}

function safePrior(action) {
  const result = {};
  for (const key of PRIOR_ACTION_KEYS) {
    if (key in action) result[key] = structuredClone(action[key]);
  }
  return result;
}

function potBefore(hand) {
  return Object.values(hand.contribs ?? {}).reduce((sum, chips) => sum + chips, 0);
}

function totalOf(state, pid) {
  const seat = state.seats.find((s) => s.playerId === pid);
  return (seat?.stack ?? 0) + (state.hand.contribs[pid] ?? 0);
}

function inPotOpponent(state, actorId, seat) {
  const hand = state.hand;
  if (seat.playerId === actorId) return false;
  if (seat.out) return false;
  if (hand.folded.includes(seat.playerId)) return false;
  return Boolean(hand.holes[seat.playerId]) || Object.hasOwn(hand.contribs, seat.playerId);
}

function effectiveStack(state, actorId) {
  const actorTotal = totalOf(state, actorId);
  let best = null;
  for (const seat of state.seats) {
    if (!inPotOpponent(state, actorId, seat)) continue;
    const capped = Math.min(actorTotal, totalOf(state, seat.playerId));
    if (best == null || capped > best) best = capped;
  }
  return best ?? actorTotal;
}

export function snapshotDecision(state, playerId, chosenAction, { forced = false, blinds } = {}) {
  const hand = state.hand;
  if (!hand) throwSnapshot('no hand');
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) throwSnapshot('unknown actor');
  const holes = hand.holes[playerId];
  if (!Array.isArray(holes) || holes.length !== 2) throwSnapshot('actor holes');
  if (!Array.isArray(blinds) || blinds.length !== 2 || !blinds.every((n) => Number.isInteger(n))) {
    throwSnapshot('blinds');
  }

  const pos = positionsOf(state);
  const myBet = hand.bets[playerId] ?? 0;
  const callRaw = Math.max(0, hand.currentBet - myBet);
  const toCall = Math.min(callRaw, seat.stack);
  const snapshot = {
    schemaVersion: 1,
    decisionId: `d-${state.handNo}-${hand.street}-${hand.actionIndex}`,
    gameMode: state.config?.mode ?? 'tournament',
    handNo: state.handNo,
    actorId: playerId,
    street: hand.street,
    position: pos[playerId] ?? null,
    holeCards: [...holes],
    board: [...hand.board],
    blinds: [...blinds],
    potBefore: potBefore(hand),
    currentBet: hand.currentBet,
    actorBet: myBet,
    toCall,
    minRaiseTo: hand.currentBet + hand.lastRaiseSize,
    maxRaiseTo: myBet + seat.stack,
    effectiveStack: effectiveStack(state, playerId),
    forced: Boolean(forced),
    publicSeats: state.seats.map((entry) => ({
      playerId: entry.playerId,
      position: pos[entry.playerId] ?? null,
      stack: entry.stack,
      bet: hand.bets[entry.playerId] ?? 0,
      contribution: hand.contribs[entry.playerId] ?? 0,
      folded: hand.folded.includes(entry.playerId),
      allIn: hand.allIn.includes(entry.playerId),
      out: Boolean(entry.out),
    })),
    priorActions: (hand.actions ?? []).map(safePrior),
  };

  if (chosenAction != null) {
    snapshot.chosenAction = {
      action: chosenAction.action,
      amount: chosenAction.amount ?? 0,
    };
  }

  for (const key of ['potBefore', 'currentBet', 'actorBet', 'toCall', 'minRaiseTo', 'maxRaiseTo', 'effectiveStack', 'handNo']) {
    if (!Number.isInteger(snapshot[key])) throwSnapshot(key);
  }
  return snapshot;
}
