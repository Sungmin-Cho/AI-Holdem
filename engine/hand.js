import { randomBytes, randomInt } from 'node:crypto';
import { newDeck, shuffle } from './cards.js';

const DEFAULT_BLINDS = [25, 50];
const BASE_BLINDS = [
  [25, 50],
  [50, 100],
  [75, 150],
  [100, 200],
  [150, 300],
  [200, 400],
  [300, 600],
  [400, 800],
  [500, 1000],
  [700, 1400],
  [1000, 2000],
];

export function blindsForLevel(level, blinds0 = DEFAULT_BLINDS) {
  const lastBase = BASE_BLINDS.length - 1;
  let [sb, bb] = BASE_BLINDS[Math.min(level, lastBase)];
  for (let i = lastBase; i < level; i += 1) {
    sb = Math.round(sb * 1.5);
    bb = Math.round(bb * 1.5);
  }
  const [sb0, bb0] = blinds0;
  return [Math.round(sb * (sb0 / 25)), Math.round(bb * (bb0 / 50))];
}

function emptyStats() {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    betsRaises: 0,
    calls: 0,
    showdowns: 0,
    showdownWins: 0,
    net: 0,
  };
}

export function createGame({
  aiCount,
  startStack = 5000,
  blinds0 = DEFAULT_BLINDS,
  levelEvery = 8,
  names,
} = {}) {
  const seats = [{ playerId: 'user', name: '나', stack: startStack, out: false }];
  for (let i = 1; i <= aiCount; i += 1) {
    seats.push({
      playerId: `p${i}`,
      name: names?.[i - 1] ?? `p${i}`,
      stack: startStack,
      out: false,
    });
  }
  const stats = {};
  for (const seat of seats) stats[seat.playerId] = emptyStats();

  return {
    schemaVersion: 1,
    stateVersion: 0,
    config: {
      aiCount,
      startStack,
      blinds0: [...blinds0],
      levelEvery,
    },
    sessionToken: randomBytes(16).toString('hex'),
    level: 0,
    handNo: 0,
    phase: 'idle',
    button: randomInt(seats.length),
    seats,
    hand: null,
    lastHand: null,
    stats,
    gameOver: false,
    result: null,
  };
}

function isLive(seat) {
  return !seat.out && seat.stack > 0;
}

function nextLiveIndex(seats, fromIdx) {
  const n = seats.length;
  for (let step = 1; step <= n; step += 1) {
    const idx = (fromIdx + step) % n;
    if (isLive(seats[idx])) return idx;
  }
  return fromIdx;
}

function throwGameOver() {
  const error = new Error('GAME_OVER');
  error.code = 'GAME_OVER';
  throw error;
}

function emit(events, visibility, type, payload) {
  events.push({ seq: events.length, visibility, type, ...payload });
}

export function startHand(state, options = {}) {
  const user = state.seats.find((seat) => seat.playerId === 'user');
  if (state.gameOver || !user || user.stack <= 0) throwGameOver();

  const next = structuredClone(state);
  next.handNo += 1;
  const previousLevel = next.level;
  next.level = Math.floor((next.handNo - 1) / next.config.levelEvery);
  const [sb, bb] = blindsForLevel(next.level, next.config.blinds0);

  next.button = nextLiveIndex(next.seats, next.button);
  const liveCount = next.seats.filter(isLive).length;
  // Heads-up: button posts SB and acts first preflop. Multiway: SB is left of button.
  const sbIdx = liveCount === 2 ? next.button : nextLiveIndex(next.seats, next.button);
  const bbIdx = nextLiveIndex(next.seats, sbIdx);
  const toActIdx = nextLiveIndex(next.seats, bbIdx);

  // Snapshot live seats before posting: all-in blind posters still receive hole cards.
  const dealOrder = [];
  let walk = sbIdx;
  for (let i = 0; i < liveCount; i += 1) {
    dealOrder.push(walk);
    walk = nextLiveIndex(next.seats, walk);
  }

  const contribs = {};
  const bets = {};
  const holes = {};
  const allIn = [];
  for (const seatIdx of dealOrder) {
    const pid = next.seats[seatIdx].playerId;
    contribs[pid] = 0;
    bets[pid] = 0;
  }

  const posts = [];
  const post = (idx, amount) => {
    const seat = next.seats[idx];
    const posted = Math.min(seat.stack, amount);
    seat.stack -= posted;
    contribs[seat.playerId] = posted;
    bets[seat.playerId] = posted;
    const wentAllIn = seat.stack === 0;
    if (wentAllIn) allIn.push(seat.playerId);
    posts.push({ playerId: seat.playerId, amount: posted, allIn: wentAllIn });
  };
  post(sbIdx, sb);
  post(bbIdx, bb);

  const deck = options.deck ? [...options.deck] : shuffle(newDeck(), options.rng);
  for (let round = 0; round < 2; round += 1) {
    for (const seatIdx of dealOrder) {
      const pid = next.seats[seatIdx].playerId;
      if (!holes[pid]) holes[pid] = [];
      holes[pid].push(deck.shift());
    }
  }

  next.phase = 'in_hand';
  next.hand = {
    street: 'preflop',
    deck,
    board: [],
    holes,
    contribs,
    bets,
    folded: [],
    allIn,
    toActIdx,
    actionIndex: 0,
    currentBet: bb,
    lastRaiseSize: bb,
    lastAggressor: null,
    reopenEligible: true,
    acted: [],
  };

  const events = [];
  emit(events, 'public', 'hand_start', {
    handNo: next.handNo,
    level: next.level,
    blinds: [sb, bb],
    button: next.seats[next.button].playerId,
  });
  if (next.level !== previousLevel) {
    emit(events, 'public', 'level_up', { level: next.level, sb, bb });
  }
  emit(events, 'public', 'blinds_posted', { sb, bb, posts });
  for (const seatIdx of dealOrder) {
    const pid = next.seats[seatIdx].playerId;
    emit(events, `actor:${pid}`, 'deal_hole', { playerId: pid, cards: [...holes[pid]] });
  }

  return { state: next, events };
}

function throwIllegal(message) {
  const error = new Error(message);
  error.code = 'ILLEGAL_ACTION';
  throw error;
}

function potTotal(hand) {
  if (!hand) return 0;
  return Object.values(hand.contribs).reduce((sum, chips) => sum + chips, 0);
}

function inPotPids(hand) {
  return Object.keys(hand.holes).filter((pid) => !hand.folded.includes(pid));
}

function canPutChips(state, pid) {
  const hand = state.hand;
  if (!hand?.holes[pid]) return false;
  if (hand.folded.includes(pid)) return false;
  if (hand.allIn.includes(pid)) return false;
  const seat = state.seats.find((s) => s.playerId === pid);
  return Boolean(seat && seat.stack > 0);
}

function actionablePids(state) {
  return inPotPids(state.hand).filter((pid) => canPutChips(state, pid));
}

function needsAction(state, idx) {
  const seat = state.seats[idx];
  if (!seat) return false;
  const pid = seat.playerId;
  if (!canPutChips(state, pid)) return false;
  const matched = (state.hand.bets[pid] ?? 0) >= state.hand.currentBet;
  if (actionablePids(state).length === 1) return !matched;
  if (state.hand.acted.includes(pid) && matched) return false;
  return true;
}

function nextNeedingAction(state, fromIdx) {
  const n = state.seats.length;
  for (let step = 1; step <= n; step += 1) {
    const idx = (fromIdx + step) % n;
    if (needsAction(state, idx)) return idx;
  }
  return null;
}

function bettingRoundClosed(state) {
  const inPot = inPotPids(state.hand);
  if (inPot.length <= 1) return true;
  const actionable = actionablePids(state);
  if (actionable.length === 0) return true;
  if (actionable.length === 1) {
    const pid = actionable[0];
    return (state.hand.bets[pid] ?? 0) >= state.hand.currentBet;
  }
  return actionable.every(
    (pid) => state.hand.acted.includes(pid) && (state.hand.bets[pid] ?? 0) >= state.hand.currentBet,
  );
}

const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river' };
const STREET_CARDS = { flop: 3, turn: 1, river: 1 };

function bbAmount(state) {
  return blindsForLevel(state.level, state.config.blinds0)[1];
}

function advanceStreet(state) {
  const nextStreet = NEXT_STREET[state.hand.street];
  const n = STREET_CARDS[nextStreet];
  for (let i = 0; i < n; i += 1) state.hand.board.push(state.hand.deck.shift());
  state.hand.street = nextStreet;
  for (const pid of Object.keys(state.hand.bets)) state.hand.bets[pid] = 0;
  state.hand.currentBet = 0;
  state.hand.lastRaiseSize = bbAmount(state);
  state.hand.lastAggressor = null;
  state.hand.reopenEligible = true;
  state.hand.acted = [];
  state.hand.toActIdx = nextNeedingAction(state, state.button);
}

function afterAction(state) {
  if (inPotPids(state.hand).length <= 1) {
    state.hand.toActIdx = null;
    return;
  }
  if (!bettingRoundClosed(state)) {
    state.hand.toActIdx = nextNeedingAction(state, state.hand.toActIdx);
    return;
  }
  if (state.hand.street === 'river' || !NEXT_STREET[state.hand.street]) {
    state.hand.toActIdx = null;
    return;
  }
  advanceStreet(state);
  if (state.hand.toActIdx == null || bettingRoundClosed(state)) {
    state.hand.toActIdx = null;
  }
}

function decisionIdOf(state) {
  const hand = state.hand;
  if (!hand) return null;
  return `d-${state.handNo}-${hand.street}-${hand.actionIndex}`;
}

function legalSnapshot(state) {
  const hand = state.hand;
  const idle = !hand || state.phase !== 'in_hand';
  const toActIdx = idle ? null : hand.toActIdx;
  const toAct = toActIdx != null && needsAction(state, toActIdx)
    ? state.seats[toActIdx].playerId
    : null;
  const handOver = idle || toAct == null;
  const base = {
    stateVersion: state.stateVersion,
    decisionId: idle ? null : decisionIdOf(state),
    handNo: state.handNo,
    street: hand?.street ?? null,
    toAct,
    canCheck: false,
    callAmount: 0,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    potTotal: potTotal(hand),
    handOver,
    gameOver: state.gameOver,
  };
  if (state.result != null) base.result = state.result;
  if (state.bustedPlayerIds) base.bustedPlayerIds = state.bustedPlayerIds;
  if (handOver) return base;

  const seat = state.seats[toActIdx];
  const pid = seat.playerId;
  const myBet = hand.bets[pid] ?? 0;
  const callRaw = Math.max(0, hand.currentBet - myBet);
  const callAmount = Math.min(callRaw, seat.stack);
  const minRaiseTo = hand.currentBet + hand.lastRaiseSize;
  const maxRaiseTo = myBet + seat.stack;
  const reopenBlocked = hand.acted.includes(pid) && !hand.reopenEligible;
  const canRaise = !reopenBlocked && maxRaiseTo > hand.currentBet;
  return {
    ...base,
    canCheck: callRaw === 0,
    callAmount,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
  };
}

export function legalFor(state) {
  return legalSnapshot(state);
}

function putChips(seat, hand, pid, put) {
  seat.stack -= put;
  hand.bets[pid] = (hand.bets[pid] ?? 0) + put;
  hand.contribs[pid] = (hand.contribs[pid] ?? 0) + put;
  if (seat.stack === 0 && !hand.allIn.includes(pid)) hand.allIn.push(pid);
}

function markActed(hand, pid) {
  if (!hand.acted.includes(pid)) hand.acted.push(pid);
}

export function applyAction(state, playerId, action, amount) {
  const legal = legalSnapshot(state);
  if (legal.toAct !== playerId) throwIllegal('not your turn');
  if (action !== 'fold' && action !== 'check' && action !== 'call' && action !== 'raise') {
    throwIllegal('unknown action');
  }
  if (action === 'check' && !legal.canCheck) throwIllegal('cannot check');
  if (action === 'call' && (legal.callAmount <= 0 || legal.canCheck)) throwIllegal('cannot call');
  if (action === 'raise') {
    if (!legal.canRaise) throwIllegal('cannot raise');
    if (!Number.isInteger(amount)) throwIllegal('raise-to must be an integer');
    if (legal.minRaiseTo > legal.maxRaiseTo) {
      if (amount !== legal.maxRaiseTo) throwIllegal('only all-in raise is legal');
    } else if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
      throwIllegal('raise-to out of range');
    }
  }

  const next = structuredClone(state);
  const hand = next.hand;
  const street = hand.street;
  const seat = next.seats.find((s) => s.playerId === playerId);
  const myBet = hand.bets[playerId] ?? 0;

  if (action === 'fold') {
    hand.folded.push(playerId);
    markActed(hand, playerId);
  } else if (action === 'check') {
    markActed(hand, playerId);
  } else if (action === 'call') {
    putChips(seat, hand, playerId, Math.min(hand.currentBet - myBet, seat.stack));
    markActed(hand, playerId);
  } else {
    const put = amount - myBet;
    const raiseBy = amount - hand.currentBet;
    const fullRaise = amount >= hand.currentBet + hand.lastRaiseSize;
    putChips(seat, hand, playerId, put);
    if (fullRaise) {
      hand.lastRaiseSize = raiseBy;
      hand.lastAggressor = playerId;
      hand.reopenEligible = true;
      hand.acted = [playerId];
    } else {
      hand.reopenEligible = false;
      markActed(hand, playerId);
    }
    hand.currentBet = amount;
  }

  hand.actionIndex += 1;
  afterAction(next);

  const events = [];
  const wentAllIn = next.hand.allIn.includes(playerId);
  const payload = { playerId, action, street };
  if (action === 'raise') payload.amount = amount;
  if (wentAllIn) payload.allIn = true;
  emit(events, 'public', 'action', payload);
  if (next.hand.street !== street) {
    emit(events, 'public', 'street', { street: next.hand.street, board: [...next.hand.board] });
  }
  return { state: next, events };
}

export function forceDefault(state, playerId) {
  const legal = legalSnapshot(state);
  if (legal.toAct !== playerId) throwIllegal('not your turn');
  if (legal.canCheck) return applyAction(state, playerId, 'check');
  return applyAction(state, playerId, 'fold');
}
