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
