import { PREFLOP_ORDERS_V3, parsePreflopKeyV3, trainingPositionV3 } from '../shared/preflop-key.js';
import { V3_BANDS, practiceKeyExactV3 } from '../shared/reference-coverage-v3.js';
import { allHandClasses } from './cards.js';

/** Explicit synthetic practice context for a v3 spot key (drills), never a
 * reconstruction of a real game. The table follows the key's own line: folds
 * to the hero (RFI, push), one 2.5bb open (vs-open), the hero's 2.5bb open and
 * a 9bb 3-bet (vs-3bet), or one all-in open (vs-shove). Every stack is the key's
 * depth, so the coverage derived from it is the key's exact context. */
const SB = 25;
const BB = 50;
const OPEN_TO = 125;
const THREE_BET_TO = 450;
const ENGINE_LABELS = ['BTN/SB', 'BB', 'BTN', 'SB', 'CO', 'UTG', ...Array.from({ length: 6 }, (_, k) => `UTG+${k + 1}`)];

// Whether a key's synthetic table is gradeable lives with the v3 bands (shared,
// so the table's practice links use the same rule).
export { practiceKeyExactV3 };

function engineLabel(position, seated) {
  return ENGINE_LABELS.find((label) => trainingPositionV3(label, seated) === position) ?? null;
}

export function nativePreflopSnapshotV3(spotKey, handClass, answer) {
  const spot = parsePreflopKeyV3(spotKey);
  if (!spot || !allHandClasses().includes(handClass)) throw new Error('Invalid native practice context');
  const order = PREFLOP_ORDERS_V3[spot.seated];
  const heroIndex = order.indexOf(spot.position);
  const total = spot.stackBb * BB;
  const shortContext = spot.context === 'push' || spot.context === 'vs-shove';
  const seats = order.map((position, i) => ({
    playerId: position === spot.position ? 'user' : `p${i}`,
    position: engineLabel(position, spot.seated),
    stack: total, bet: 0, contribution: 0, folded: false, allIn: false, out: false,
  }));
  const seatAt = (position) => seats[order.indexOf(position)];
  const put = (seat, to) => {
    const chips = Math.min(to - seat.bet, seat.stack);
    seat.bet += chips; seat.contribution += chips; seat.stack -= chips;
    if (seat.stack === 0) seat.allIn = true;
  };
  put(seatAt('SB'), SB);
  put(seatAt('BB'), BB);
  const actions = [];
  let decision = 0;
  const act = (position, action, to = 0) => {
    const seat = seatAt(position);
    const maxRaiseTo = seat.bet + seat.stack;
    if (action === 'fold') seat.folded = true;
    else put(seat, to);
    actions.push({ playerId: seat.playerId, decisionId: `d-1-preflop-${decision++}`, street: 'preflop', action,
      amount: action === 'fold' ? 0 : to, ...(action === 'raise' ? { maxRaiseTo } : {}) });
  };
  const villain = spot.openerPosition;
  let currentBet = BB;
  let lastRaise = BB;
  if (spot.context === 'rfi-unopened' || spot.context === 'push') {
    for (const position of order.slice(0, heroIndex)) act(position, 'fold');
  } else if (spot.context === 'vs-single-raise' || spot.context === 'vs-shove') {
    const villainIndex = order.indexOf(villain);
    for (const position of order.slice(0, heroIndex)) {
      if (position !== villain) act(position, 'fold');
      else act(position, 'raise', spot.context === 'vs-shove' ? total : OPEN_TO);
      if (position === villain) { lastRaise = seatAt(villain).bet - BB; currentBet = seatAt(villain).bet; }
    }
    if (villainIndex >= heroIndex) throw new Error('Invalid native practice context');
  } else {
    for (const position of order.slice(0, heroIndex)) act(position, 'fold');
    act(spot.position, 'raise', OPEN_TO);
    for (const position of [...order.slice(heroIndex + 1), ...order.slice(0, heroIndex)]) {
      if (position === villain) act(position, 'raise', THREE_BET_TO);
      else if (!seatAt(position).folded) act(position, 'fold');
    }
    lastRaise = THREE_BET_TO - OPEN_TO;
    currentBet = THREE_BET_TO;
  }
  const hero = seatAt(spot.position);
  const maxRaiseTo = hero.bet + hero.stack;
  const toCall = Math.min(currentBet - hero.bet, hero.stack);
  const minRaiseTo = Math.min(maxRaiseTo, currentBet + lastRaise);
  const decisionId = `d-1-preflop-${decision}`;
  const holeCards = [`${handClass[0]}s`, `${handClass[1]}${handClass.endsWith('s') ? 's' : 'h'}`];
  const raiseTo = (sizeBb) => Math.min(maxRaiseTo, Math.round(sizeBb * BB));
  return {
    schemaVersion: 2, decisionId, gameMode: shortContext ? 'tournament' : 'cash-training', handNo: 1, actorId: 'user',
    street: 'preflop', position: hero.position, holeCards, board: [], blinds: [SB, BB],
    potBefore: seats.reduce((n, seat) => n + seat.contribution, 0),
    currentBet, actorBet: hero.bet, toCall, minRaiseTo, maxRaiseTo, effectiveStack: total, forced: false,
    publicSeats: seats, priorActions: actions,
    legal: { decisionId, canCheck: toCall === 0, canRaise: maxRaiseTo > currentBet, callAmount: toCall, minRaiseTo, maxRaiseTo },
    ...(answer ? { chosenAction: { action: answer.action, amount: answer.action === 'raise' ? raiseTo(answer.sizeBb) : 0 } } : {}),
  };
}
