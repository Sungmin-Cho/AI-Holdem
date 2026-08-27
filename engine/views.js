import { blindsForLevel, legalFor } from './hand.js';
import { buildPots } from './sidepots.js';

function currentHandData(state) {
  if (state.hand) return state.hand;
  if (state.lastHand) {
    return {
      street: ['preflop', null, null, 'flop', 'turn', 'river'][state.lastHand.board?.length ?? 0] ?? null,
      board: state.lastHand.board ?? [],
      holes: state.lastHand.holes ?? {},
      bets: {},
      folded: state.lastHand.folded ?? [],
      allIn: state.lastHand.allIn ?? [],
      contribs: new Map(),
      pots: state.lastHand.pots ?? [],
    };
  }
  return null;
}

function publicPots(hand) {
  if (!hand) return [];
  if (Array.isArray(hand.pots)) return structuredClone(hand.pots);
  const pots = buildPots(
    new Map(Object.entries(hand.contribs ?? {})),
    new Set(hand.folded ?? []),
  );
  return pots.map((pot, potIndex) => ({ potIndex, ...pot }));
}

function publicSeat(state, hand, seat) {
  return {
    playerId: seat.playerId,
    name: seat.name,
    stack: seat.stack,
    bet: hand?.bets?.[seat.playerId] ?? 0,
    folded: Boolean(hand?.folded?.includes(seat.playerId)),
    allIn: Boolean(hand?.allIn?.includes(seat.playerId)),
    isButton: state.seats[state.button]?.playerId === seat.playerId,
  };
}

export function viewFor(state, playerId) {
  const hand = currentHandData(state);
  const legal = state.hand ? legalFor(state) : null;
  const view = {
    handNo: state.handNo,
    level: state.level,
    levelEvery: state.config.levelEvery,
    blinds: state.hand
      ? blindsForLevel(state.level, state.config.blinds0)
      : (state.lastHand?.blinds ? [...state.lastHand.blinds] : blindsForLevel(state.level, state.config.blinds0)),
    street: hand?.street ?? null,
    board: [...(hand?.board ?? [])],
    pots: publicPots(hand),
    seats: state.seats.map((seat) => publicSeat(state, hand, seat)),
    toAct: legal?.toAct ?? null,
    myCards: [...(hand?.holes?.[playerId] ?? [])],
    gameOver: Boolean(state.gameOver),
  };

  if (state.hand && legal?.toAct === playerId) view.legal = structuredClone(legal);
  if (state.result != null) view.result = state.result;
  return view;
}

export function userView(state) {
  return viewFor(state, 'user');
}

function safeAction(action) {
  const keys = [
    'decisionId', 'playerId', 'action', 'amount', 'street', 'potTotal',
    'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks',
  ];
  const result = {};
  for (const key of keys) {
    if (key in action) result[key] = structuredClone(action[key]);
  }
  return result;
}

export function redactRecord(record, viewerId = 'user') {
  if (!record) return null;
  const result = {};
  for (const key of ['handNo', 'level', 'blinds', 'button', 'board', 'folded', 'allIn', 'startStacks', 'endStacks']) {
    if (key in record) result[key] = structuredClone(record[key]);
  }
  result.holes = {};
  if (record.holes?.[viewerId]) result.holes[viewerId] = [...record.holes[viewerId]];
  result.actions = (record.actions ?? []).map(safeAction);
  result.pots = (record.pots ?? []).map((pot) => ({
    potIndex: pot.potIndex,
    amount: pot.amount,
    eligible: [...(pot.eligible ?? [])],
    winners: (pot.winners ?? []).map((winner) => ({ ...winner })),
  }));
  if (record.showdown) {
    result.showdown = {
      reveals: (record.showdown.reveals ?? []).map((reveal) => ({
        playerId: reveal.playerId,
        cards: [...reveal.cards],
        ...(reveal.handName == null ? {} : { handName: reveal.handName }),
      })),
      mucks: [...(record.showdown.mucks ?? [])],
    };
  } else {
    result.showdown = null;
  }
  return result;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function statsReport(state) {
  const perPlayer = {};
  for (const seat of state.seats) {
    const raw = state.stats?.[seat.playerId] ?? {};
    const sample = raw.hands ?? 0;
    const calls = raw.calls ?? 0;
    const betsRaises = raw.betsRaises ?? 0;
    perPlayer[seat.playerId] = {
      vpip: ratio(raw.vpip ?? 0, sample),
      pfr: ratio(raw.pfr ?? 0, sample),
      af: calls > 0 ? betsRaises / calls : betsRaises,
      showdownWin: ratio(raw.showdownWins ?? 0, raw.showdowns ?? 0),
      net: raw.net ?? 0,
      sample,
    };
  }
  return { perPlayer };
}
