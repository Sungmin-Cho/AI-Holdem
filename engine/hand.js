import { randomBytes, randomInt } from 'node:crypto';
import { newDeck, shuffle } from './cards.js';
import { snapshotDecision } from './decision.js';
import { compareScore, evaluate7 } from './evaluator.js';
import { awardPots, buildPots } from './sidepots.js';

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
    bustedPlayerIds: [],
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
  const startStacks = {};
  for (const seatIdx of dealOrder) {
    const seat = next.seats[seatIdx];
    startStacks[seat.playerId] = seat.stack;
  }

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
    lastBettingAggressor: null,
    reopenEligible: true,
    acted: [],
    actions: [],
    decisions: [],
    startStacks,
    vpipped: [],
    pfrd: [],
    raiseCount: {},
    callCount: {},
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

  if (legalSnapshot(next).handOver) finishHand(next, events);

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

function runout(state, events) {
  while (NEXT_STREET[state.hand.street]) {
    advanceStreet(state);
    emit(events, 'public', 'street', {
      street: state.hand.street,
      board: [...state.hand.board],
    });
  }
}

function clockwiseFrom(state, startIdx, inPot) {
  const n = state.seats.length;
  const order = [];
  for (let i = 0; i < n; i += 1) {
    const pid = state.seats[(startIdx + i) % n].playerId;
    if (!inPot || inPot.includes(pid)) order.push(pid);
  }
  return order;
}

function oddChipOrder(state) {
  return clockwiseFrom(state, (state.button + 1) % state.seats.length);
}

function revealOrder(state, inPot, lastAggressor) {
  if (lastAggressor && inPot.includes(lastAggressor)) {
    const startIdx = state.seats.findIndex((seat) => seat.playerId === lastAggressor);
    return clockwiseFrom(state, startIdx, inPot);
  }
  return clockwiseFrom(state, (state.button + 1) % state.seats.length, inPot);
}

function potWinnersOf(pot, scores) {
  let best = null;
  for (const pid of pot.eligible) {
    const score = scores.get(pid);
    if (best == null || compareScore(score, best) > 0) best = score;
  }
  return pot.eligible.filter((pid) => compareScore(scores.get(pid), best) === 0);
}

function buildShowdown(state, hand, inPot, pots, scores, evals) {
  const winnerSet = new Set();
  for (const pot of pots) {
    for (const pid of potWinnersOf(pot, scores)) winnerSet.add(pid);
  }
  const order = revealOrder(state, inPot, hand.lastBettingAggressor);
  const shown = [];
  const reveals = [];
  const mucks = [];
  for (const pid of order) {
    const mustShow = winnerSet.has(pid) || pots.some((pot) => {
      if (!pot.eligible.includes(pid)) return false;
      const shownInPot = shown.filter((id) => pot.eligible.includes(id));
      if (shownInPot.length === 0) return true;
      let bestShown = scores.get(shownInPot[0]);
      for (const id of shownInPot.slice(1)) {
        if (compareScore(scores.get(id), bestShown) > 0) bestShown = scores.get(id);
      }
      return compareScore(scores.get(pid), bestShown) > 0;
    });
    if (mustShow) {
      reveals.push({
        playerId: pid,
        cards: [...hand.holes[pid]],
        handName: evals[pid].name,
      });
      shown.push(pid);
    } else {
      mucks.push(pid);
    }
  }
  return { reveals, mucks };
}

function returnUncalled(state) {
  const contribs = state.hand.contribs;
  let maxLive = 0;
  for (const pid of inPotPids(state.hand)) {
    maxLive = Math.max(maxLive, contribs[pid] ?? 0);
  }
  const returned = {};
  for (const pid of Object.keys(contribs)) {
    const excess = Math.max(0, (contribs[pid] ?? 0) - maxLive);
    if (excess <= 0) continue;
    returned[pid] = excess;
    contribs[pid] -= excess;
    state.seats.find((s) => s.playerId === pid).stack += excess;
  }
  return returned;
}

function updateStats(state, hand, inPot, contested, contestedWinners) {
  for (const pid of Object.keys(hand.holes)) {
    const stats = state.stats[pid] ?? (state.stats[pid] = emptyStats());
    stats.hands += 1;
    if (hand.vpipped.includes(pid)) stats.vpip += 1;
    if (hand.pfrd.includes(pid)) stats.pfr += 1;
    stats.betsRaises += hand.raiseCount[pid] ?? 0;
    stats.calls += hand.callCount[pid] ?? 0;
    if (contested && inPot.includes(pid)) {
      stats.showdowns += 1;
      if (contestedWinners.has(pid)) stats.showdownWins += 1;
    }
    const start = hand.startStacks[pid] ?? 0;
    const seat = state.seats.find((s) => s.playerId === pid);
    stats.net += seat.stack - start;
  }
}

function finishHand(state, events) {
  const hand = state.hand;
  const inPot = inPotPids(hand);
  const contested = inPot.length >= 2;
  returnUncalled(state);
  if (contested) runout(state, events);

  const pots = buildPots(new Map(Object.entries(hand.contribs)), new Set(hand.folded));
  const evals = {};
  const scores = new Map();
  if (contested) {
    for (const pid of inPot) {
      const result = evaluate7([...hand.holes[pid], ...hand.board]);
      evals[pid] = result;
      scores.set(pid, result.score);
    }
  } else {
    for (const pid of inPot) scores.set(pid, [1]);
  }

  let showdown = null;
  if (contested) {
    showdown = buildShowdown(state, hand, inPot, pots, scores, evals);
    emit(events, 'public', 'showdown', {
      reveals: showdown.reveals,
      mucks: showdown.mucks,
    });
  }

  const order = oddChipOrder(state);
  const contestedWinners = new Set();
  const potRecords = [];
  for (let i = 0; i < pots.length; i += 1) {
    const pot = pots[i];
    const part = awardPots([pot], scores, order);
    const winners = [];
    for (const pid of order) {
      const share = part.get(pid) ?? 0;
      if (share <= 0) continue;
      winners.push({ playerId: pid, share });
      state.seats.find((s) => s.playerId === pid).stack += share;
    }
    if (pot.eligible.length >= 2) {
      for (const winner of winners) contestedWinners.add(winner.playerId);
    }
    emit(events, 'public', 'pot_award', {
      potIndex: i,
      amount: pot.amount,
      winners,
    });
    potRecords.push({
      potIndex: i,
      amount: pot.amount,
      eligible: [...pot.eligible],
      winners,
    });
  }

  updateStats(state, hand, inPot, contested, contestedWinners);

  const endStacks = {};
  for (const seat of state.seats) endStacks[seat.playerId] = seat.stack;

  state.lastHand = {
    handNo: state.handNo,
    level: state.level,
    blinds: blindsForLevel(state.level, state.config.blinds0),
    button: state.seats[state.button].playerId,
    holes: structuredClone(hand.holes),
    board: [...hand.board],
    folded: [...hand.folded],
    allIn: [...hand.allIn],
    actions: structuredClone(hand.actions),
    decisions: structuredClone(hand.decisions ?? []),
    pots: potRecords,
    showdown,
    startStacks: { ...hand.startStacks },
    endStacks,
  };

  const bustedPlayerIds = [];
  for (const seat of state.seats) {
    if (!seat.out && seat.stack === 0) {
      seat.out = true;
      bustedPlayerIds.push(seat.playerId);
      emit(events, 'public', 'bust', { playerId: seat.playerId });
    }
  }

  const user = state.seats.find((seat) => seat.playerId === 'user');
  const aiAlive = state.seats.some((seat) => seat.playerId !== 'user' && !seat.out);
  if (!user || user.stack <= 0) {
    state.gameOver = true;
    state.result = 'lose';
    state.bustedPlayerIds = bustedPlayerIds;
    emit(events, 'public', 'game_over', { result: 'lose', bustedPlayerIds });
  } else if (!aiAlive) {
    state.gameOver = true;
    state.result = 'win';
    state.bustedPlayerIds = bustedPlayerIds;
    emit(events, 'public', 'game_over', { result: 'win', bustedPlayerIds });
  }

  state.phase = 'idle';
  state.hand = null;
}

function afterAction(state, events) {
  if (inPotPids(state.hand).length <= 1) {
    finishHand(state, events);
    return;
  }
  if (!bettingRoundClosed(state)) {
    state.hand.toActIdx = nextNeedingAction(state, state.hand.toActIdx);
    return;
  }
  state.hand.lastBettingAggressor = state.hand.lastAggressor;
  if (actionablePids(state).length <= 1) {
    finishHand(state, events);
    return;
  }
  if (!NEXT_STREET[state.hand.street]) {
    finishHand(state, events);
    return;
  }
  advanceStreet(state);
  emit(events, 'public', 'street', {
    street: state.hand.street,
    board: [...state.hand.board],
  });
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
  const hasRespondent = actionablePids(state).some((id) => id !== pid);
  const canRaise = !reopenBlocked && hasRespondent && maxRaiseTo > hand.currentBet;
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

export function applyAction(state, playerId, action, amount, { forced = false } = {}) {
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

  const record = {
    decisionId: legal.decisionId,
    playerId,
    action,
    amount: action === 'raise' ? amount : action === 'call' ? legal.callAmount : 0,
    street,
    potTotal: legal.potTotal,
    callAmount: legal.callAmount,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    board: [...hand.board],
    stacks: Object.fromEntries(next.seats.map((s) => [s.playerId, s.stack])),
  };
  if (playerId === 'user') {
    if (!hand.decisions) hand.decisions = [];
    hand.decisions.push(snapshotDecision(next, playerId, {
      action,
      amount: record.amount,
    }, {
      forced,
      blinds: blindsForLevel(next.level, next.config.blinds0),
    }));
  }
  hand.actions.push(record);

  if (action === 'fold') {
    hand.folded.push(playerId);
    markActed(hand, playerId);
  } else if (action === 'check') {
    markActed(hand, playerId);
  } else if (action === 'call') {
    putChips(seat, hand, playerId, Math.min(hand.currentBet - myBet, seat.stack));
    markActed(hand, playerId);
    hand.callCount[playerId] = (hand.callCount[playerId] ?? 0) + 1;
    if (street === 'preflop' && !hand.vpipped.includes(playerId)) hand.vpipped.push(playerId);
  } else {
    const put = amount - myBet;
    const raiseBy = amount - hand.currentBet;
    const fullRaise = amount >= hand.currentBet + hand.lastRaiseSize;
    putChips(seat, hand, playerId, put);
    hand.lastAggressor = playerId;
    if (fullRaise) {
      hand.lastRaiseSize = raiseBy;
      hand.reopenEligible = true;
      hand.acted = [playerId];
    } else {
      hand.reopenEligible = false;
      markActed(hand, playerId);
    }
    hand.currentBet = amount;
    hand.raiseCount[playerId] = (hand.raiseCount[playerId] ?? 0) + 1;
    if (street === 'preflop') {
      if (!hand.vpipped.includes(playerId)) hand.vpipped.push(playerId);
      if (!hand.pfrd.includes(playerId)) hand.pfrd.push(playerId);
    }
  }

  hand.actionIndex += 1;
  const wentAllIn = hand.allIn.includes(playerId);
  const events = [];
  const payload = { playerId, action, street };
  if (action === 'raise') payload.amount = amount;
  if (wentAllIn) payload.allIn = true;
  emit(events, 'public', 'action', payload);
  afterAction(next, events);
  return { state: next, events };
}

export function forceDefault(state, playerId) {
  const legal = legalSnapshot(state);
  if (legal.toAct !== playerId) throwIllegal('not your turn');
  if (legal.canCheck) return applyAction(state, playerId, 'check', undefined, { forced: true });
  return applyAction(state, playerId, 'fold', undefined, { forced: true });
}
