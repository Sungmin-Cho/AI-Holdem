// Coaching-only public-action range estimate. It starts from the recorded v3
// preflop estimate (estimate-v3.js, untouched: policy v3 keeps using that) and
// reweights each opponent's hand classes with the postflop actions visible before
// the decision, judging every action against the board it was made on and never
// a later one.
//
// This is an uncalibrated engineering heuristic, not solved poker. The
// likelihoods below are fixed, bounded assumptions chosen so that weak hands keep
// some support (bluffs, thin calls, slow plays); they are not measured action
// frequencies. Evidence that is missing or malformed yields no conditioned range
// for that opponent instead of a random substitute: every field either the v3
// preflop estimator or the likelihoods below read is validated first, and a
// missing price, street, seat flag or cap is never defaulted to zero or "preflop".
// Input is the decision-time public snapshot only: no opponent hole cards,
// personas or later boards are read.
import { HAND_CLASSES, cardInt, combosOfClass, drawsOf, scoreCards } from '../../shared/poker-eval.js';
import { estimateOpponentRanges } from './estimate-v3.js';

export const COACH_RANGE_METHOD = Object.freeze({
  id: 'coach-public-action-heuristic',
  version: 1,
  basis: 'estimate-v3 preflop range, reweighted by visible postflop actions on their historical boards',
  calibrated: false,
});

// Every number here is an assumption, not a measured frequency.
export const COACH_RANGE_CONSTANTS = Object.freeze({
  // A hand class never drops below this share of its previous weight in one action.
  floorShare: 0.02,
  // Likelihood floors: even the unlikeliest hands keep this much of the peak.
  checkFloor: 0.35,
  callFloor: 0.15,
  betFloor: 0.12,
  raiseFloor: 0.05,
  // Strength curve exponents for bets/raises: larger = more value-weighted.
  betExponent: 1.4,
  largeBetExponent: 2,
  raiseExponent: 2.6,
  largeBetPotFraction: 0.75,
  // Draw credit: share of the remaining strength a draw is assumed to realize.
  flopDrawPerOut: 0.04,
  turnDrawPerOut: 0.022,
  maxDrawCredit: 0.5,
});

const C = COACH_RANGE_CONSTANTS;
const STREET_BOARD = Object.freeze({ preflop: 0, flop: 3, turn: 4, river: 5 });
const STREET_ORDER = Object.freeze({ preflop: 0, flop: 1, turn: 2, river: 3 });
const ACTIONS = new Set(['fold', 'check', 'call', 'raise']);

export const COACH_RANGE_LIMITATIONS = Object.freeze([
  '공개 행동만으로 만든 휴리스틱 추정이며 보정(calibration)되지 않았습니다.',
  '체크·콜·벳·레이즈 우도는 고정된 가정값이지 실제 빈도가 아닙니다.',
  '프리플랍은 각 상대의 첫 프리플랍 행동만 v3 기준표로 반영합니다.',
  '아직 행동하지 않은 상대는 에퀴티 계산에서 제외합니다(누가 콜할지 예측하지 않음).',
  '쇼다운 시뮬레이션 에퀴티는 행동 EV가 아닙니다. 이후 베팅·멀티웨이·리오픈된 콜은 가격 비교만으로 판정할 수 없습니다.',
]);

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// ---- evidence validation ---------------------------------------------------
// The engine writes every chip count as an integer, every seat flag as a boolean and
// every card, street and id as a string (engine/decision.js, engine/hand.js). A value
// of any other type is treated as missing, never as a default.

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isId = (x) => typeof x === 'string' && x.length > 0;
const isChips = (x) => Number.isInteger(x) && x >= 0;

function boardInts(board) {
  if (!Array.isArray(board)) return null;
  const out = board.map((card) => cardInt(card));
  if (out.some((card) => card < 0) || new Set(out).size !== out.length) return null;
  return out;
}

// Seats the estimate (and the v3 chart it starts from) reads: ids, the out/folded/allIn
// flags, and the position label of every seat still in the game. The actor must be a seated,
// live player or it would be ranged as its own opponent.
function seatsIssue(snapshot) {
  const seats = snapshot.publicSeats;
  if (!Array.isArray(seats) || !isId(snapshot.actorId)) return 'bad-seat-evidence';
  const ids = new Set();
  for (const seat of seats) {
    if (!isObject(seat) || !isId(seat.playerId) || ids.has(seat.playerId)) return 'bad-seat-evidence';
    ids.add(seat.playerId);
    if (typeof seat.out !== 'boolean' || typeof seat.folded !== 'boolean' || typeof seat.allIn !== 'boolean') return 'bad-seat-evidence';
    if (!seat.out && !isId(seat.position)) return 'bad-seat-evidence';
  }
  const actor = seats.find((seat) => seat.playerId === snapshot.actorId);
  return actor && !actor.out && !actor.folded ? null : 'bad-seat-evidence';
}

function decisionContext(snapshot) {
  const street = snapshot.street;
  if (!Object.hasOwn(STREET_BOARD, street)) return null;
  const board = boardInts(snapshot.board);
  if (!board || board.length !== STREET_BOARD[street]) return null;
  // Hero's own cards are known to hero; they only remove combos (blockers). A missing or
  // malformed pair is not "no blockers": the blocker-adjusted range would differ.
  const hole = Array.isArray(snapshot.holeCards) && snapshot.holeCards.length === 2 ? boardInts(snapshot.holeCards) : null;
  if (!hole || hole.some((card) => board.includes(card))) return null;
  return { street, board, hole };
}

// The big blind sizes every preflop shove test (raise-to cap / blind), so it must be real.
function preflopContextIssue(snapshot) {
  const bb = Array.isArray(snapshot.blinds) ? snapshot.blinds[1] : null;
  return Number.isInteger(bb) && bb > 0 ? null : 'bad-preflop-context';
}

// An entry that cannot be attributed to a player or placed on a street could be anyone's
// action (v3 would read a missing street as preflop), so it makes the whole timeline unusable.
function timelineIssue(snapshot) {
  const prior = snapshot.priorActions;
  if (!Array.isArray(prior)) return 'bad-actions';
  for (const action of prior) {
    if (!isObject(action) || !isId(action.playerId)) return 'malformed-action';
    if (typeof action.street !== 'string' || !Object.hasOwn(STREET_ORDER, action.street)) return 'unknown-street';
  }
  return null;
}

// Why one action cannot be used, or null. `ctx.board` is the decision board. Everything read
// by the v3 preflop estimator (action, the raise-to and its cap) and by the likelihoods
// (board, pot, price, size) is required; fields neither reads are not.
function actionIssue(action, ctx) {
  if (!ACTIONS.has(action.action)) return 'unknown-action';
  const { street } = action;
  if (STREET_ORDER[street] > STREET_ORDER[ctx.street]) return 'future-street';
  if (street === 'preflop') {
    // The cap decides whether a raise is a shove, so a raise without both numbers is unreadable.
    if (action.action === 'raise' && !(Number.isInteger(action.amount) && action.amount > 0
      && Number.isInteger(action.maxRaiseTo) && action.maxRaiseTo >= action.amount)) return 'bad-sizing';
    return null;
  }
  const board = boardInts(action.board);
  if (!board) return 'bad-board';
  if (board.length !== STREET_BOARD[street]) return 'board-street-mismatch';
  if (board.some((card, i) => card !== ctx.board[i])) return 'board-not-history';
  if (action.action === 'raise' || action.action === 'call') {
    // callAmount separates a bet (nothing to call) from a raise, so it is required for both.
    if (!isChips(action.potTotal) || !isChips(action.callAmount)) return 'bad-sizing';
    if (action.action === 'raise' && !(Number.isInteger(action.amount) && action.amount > 0)) return 'bad-sizing';
  }
  return null;
}

// The v3 chart reads every preflop action up to and including the opponent's first one,
// whoever made them (an open, a limp, an earlier caller). One of those being malformed
// would change the line it classifies, so it is evidence for this opponent too.
function preflopChainIssue(prior, pid, ctx) {
  const preflop = prior.filter((action) => action.street === 'preflop');
  const first = preflop.findIndex((action) => action.playerId === pid);
  for (let i = 0; i <= first; i += 1) {
    const issue = actionIssue(preflop[i], ctx);
    if (issue) return preflop[i].playerId === pid ? issue : 'earlier-preflop-evidence';
  }
  return null;
}

// ---- board-aware hand strength ---------------------------------------------

// Strength 0..1 of every combo of every class compatible with the known cards:
// the percentile of its made-hand score among all compatible holdings (ties at
// mid-rank) plus a bounded credit for flush/straight draws on flop and turn.
function strengthTable(board, hole) {
  const blocked = new Set([...board, ...hole]);
  const rows = [];
  for (let i = 0; i < HAND_CLASSES.length; i += 1) {
    for (const [a, b] of combosOfClass(HAND_CLASSES[i])) {
      if (blocked.has(a) || blocked.has(b)) continue;
      rows.push({ cls: HAND_CLASSES[i], a, b, score: scoreCards([a, b, ...board]) });
    }
  }
  const sorted = rows.map((row) => row.score).sort((x, y) => x - y);
  const firstAt = new Map();
  const lastAt = new Map();
  sorted.forEach((score, i) => { if (!firstAt.has(score)) firstAt.set(score, i); lastAt.set(score, i); });
  const denom = Math.max(1, sorted.length - 1);
  const perClass = new Map();
  for (const row of rows) {
    const made = ((firstAt.get(row.score) + lastAt.get(row.score)) / 2) / denom;
    let credit = 0;
    if (board.length === 3 || board.length === 4) {
      const { outs } = drawsOf([row.a, row.b], board);
      credit = Math.min(C.maxDrawCredit, outs * (board.length === 3 ? C.flopDrawPerOut : C.turnDrawPerOut));
    }
    const strength = clamp01(made + (1 - made) * credit);
    if (!perClass.has(row.cls)) perClass.set(row.cls, []);
    perClass.get(row.cls).push(strength);
  }
  return perClass;
}

// ---- action likelihoods (heuristic, uncalibrated) ----------------------------

const sizeFraction = (action) => Math.min(3, Math.max(0, action.amount / Math.max(1, action.potTotal)));

function likelihood(action, strength) {
  if (action.action === 'check') return C.checkFloor + (1 - C.checkFloor) * (1 - strength * strength);
  if (action.action === 'call') {
    const price = Math.min(1, Math.max(0, action.callAmount / Math.max(1, action.potTotal + action.callAmount)) * 2);
    const centre = 0.55 + 0.2 * price;
    const tri = Math.max(0, 1 - Math.abs(strength - centre) / 0.65);
    return C.callFloor + (1 - C.callFloor) * tri;
  }
  // bet (nothing to call) or raise (over a bet)
  const isRaise = (action.callAmount ?? 0) > 0;
  const large = sizeFraction(action) >= C.largeBetPotFraction;
  const exponent = isRaise ? C.raiseExponent : large ? C.largeBetExponent : C.betExponent;
  const floor = isRaise ? C.raiseFloor : C.betFloor;
  return floor + (1 - floor) * strength ** exponent;
}

function applyAction(weights, action, table) {
  const raw = {};
  let peak = 0;
  for (const cls of Object.keys(weights)) {
    const strengths = table.get(cls);
    if (!strengths?.length) { raw[cls] = 0; continue; }
    let sum = 0;
    for (const strength of strengths) sum += likelihood(action, strength);
    raw[cls] = sum / strengths.length;
    peak = Math.max(peak, raw[cls]);
  }
  const next = {};
  let top = 0;
  for (const [cls, weight] of Object.entries(weights)) {
    if (!(raw[cls] > 0) || !(peak > 0)) continue; // no compatible combo left (blocked)
    next[cls] = weight * Math.max(raw[cls] / peak, C.floorShare);
    top = Math.max(top, next[cls]);
  }
  if (!(top > 0)) return null;
  for (const cls of Object.keys(next)) next[cls] /= top;
  return next;
}

// ---- estimate ----------------------------------------------------------------

const live = (snapshot) => snapshot.publicSeats.filter((seat) => !seat.out && !seat.folded && seat.playerId !== snapshot.actorId);

function unavailable(reason) {
  return { status: 'unavailable', range: null, reasons: [reason], appliedActions: 0, skippedActions: 0 };
}

const emptyResult = () => ({ method: COACH_RANGE_METHOD, status: 'unavailable', limitations: COACH_RANGE_LIMITATIONS,
  issues: [], acted: [], unacted: [], players: {} });

/**
 * Coaching range estimate for every live opponent of the decision snapshot.
 * Returns { method, status, limitations, issues, acted, unacted, players } where
 * status is 'full' (every live opponent conditioned), 'partial' or 'unavailable',
 * and players[id] = { status: 'conditioned'|'partial'|'unavailable', range, reasons,
 * appliedActions, skippedActions, actedThisStreet }. `issues` lists evidence defects
 * that apply to the whole snapshot (seats, board, blinds, the action timeline); when
 * the seats themselves are unreadable there are no players at all. Never throws on
 * bad evidence.
 */
export function estimateCoachRanges(snapshot) {
  try {
    return estimateFrom(snapshot);
  } catch {
    // Nothing below is expected to throw; a surprise is a failed estimate, not a guess.
    const failed = emptyResult();
    failed.issues.push('estimate-failed');
    return failed;
  }
}

function estimateFrom(snapshot) {
  const result = emptyResult();
  if (!isObject(snapshot)) { result.issues.push('bad-snapshot'); return result; }
  const seatIssue = seatsIssue(snapshot);
  if (seatIssue) { result.issues.push(seatIssue); return result; }
  const opponents = live(snapshot);
  const ctx = decisionContext(snapshot);
  const wholeIssue = ctx ? preflopContextIssue(snapshot) ?? timelineIssue(snapshot) : 'bad-board-evidence';
  if (wholeIssue) {
    result.issues.push(wholeIssue);
    for (const seat of opponents) result.players[seat.playerId] = unavailable(wholeIssue);
    return result;
  }
  let preflop = {};
  try {
    preflop = estimateOpponentRanges(snapshot);
  } catch {
    result.issues.push('preflop-estimate-failed');
  }
  const prior = snapshot.priorActions;
  const table = new Map(); // street board length -> strength table
  const tableFor = (board) => {
    const key = board.join(',');
    if (!table.has(key)) table.set(key, strengthTable(board, ctx.hole));
    return table.get(key);
  };

  for (const seat of opponents) {
    const pid = seat.playerId;
    const mine = prior.filter((a) => a.playerId === pid);
    const postflop = mine.filter((a) => a.street !== 'preflop');
    const preflopCount = mine.length - postflop.length;
    const base = preflop[pid];
    const player = { status: 'conditioned', range: null, reasons: [], appliedActions: 0, skippedActions: 0,
      actedThisStreet: ctx.street === 'preflop' ? preflopCount > 0 : postflop.some((a) => a.street === ctx.street) };
    result.players[pid] = player;
    const fail = (reason) => Object.assign(player, unavailable(reason), { actedThisStreet: player.actedThisStreet });
    // The chart's input first: a malformed opener price must not read as a different line.
    const chain = preflopChainIssue(prior, pid, ctx);
    if (chain) { fail(chain); continue; }
    if (!base) { fail('no-preflop-range'); continue; }
    const issue = mine.map((a) => actionIssue(a, ctx)).find(Boolean);
    if (issue) { fail(issue); continue; }
    if (preflopCount > 1) { player.status = 'partial'; player.reasons.push('later-preflop-action-not-modeled'); }
    let weights = { ...base };
    const top = Math.max(...Object.values(weights));
    for (const cls of Object.keys(weights)) weights[cls] /= top;
    let failed = false;
    for (const action of postflop) {
      if (action.action === 'fold') continue;
      const next = applyAction(weights, action, tableFor(action.board.map(cardInt)));
      if (!next) { failed = true; break; }
      weights = next;
      player.appliedActions += 1;
    }
    if (failed) { fail('no-compatible-combo'); continue; }
    // A current all-in flag does not prove when the chips went in. Only a
    // historical full-stack raise or call can excuse missing later streets.
    const allInAt = seat.allIn ? mine.find((a) => (
      (a.action === 'raise' && Number.isInteger(a.maxRaiseTo) && a.maxRaiseTo > 0 && a.amount === a.maxRaiseTo)
      || (a.action === 'call' && Number.isInteger(a.stacks?.[pid]) && a.stacks[pid] > 0
        && a.amount === a.callAmount && a.amount === a.stacks[pid])
    ))?.street : null;
    const streetsDone = Object.keys(STREET_ORDER).filter((s) => s !== 'preflop' && STREET_ORDER[s] < STREET_ORDER[ctx.street]);
    if (streetsDone.some((s) => !postflop.some((a) => a.street === s)
      && !(allInAt && STREET_ORDER[allInAt] < STREET_ORDER[s]))) {
      player.status = 'partial';
      player.reasons.push('missing-street-action');
    }
    player.range = weights;
  }

  const states = opponents.map((seat) => result.players[seat.playerId].status);
  if (states.length === 0) result.status = 'unavailable';
  else if (states.every((s) => s === 'conditioned')) result.status = 'full';
  else if (states.some((s) => s !== 'unavailable')) result.status = 'partial';
  // Committed opponents: acted on this street or all-in. The rest are unacted.
  for (const seat of opponents) {
    (result.players[seat.playerId].actedThisStreet || seat.allIn ? result.acted : result.unacted).push(seat.playerId);
  }
  return result;
}

/**
 * The ranges to use for equity, or null with a reason.
 *
 * Admission is two-step. First every live opponent, acted or not, must be fully
 * conditioned: an unacted opponent with no range evidence may still call, so equity
 * against the others alone would present a heads-up number for a multiway spot. Only
 * then is the equity computed against the opponents already committed on this
 * street, and the unacted ones (whose ranges are known but have not been narrowed
 * by an action here) are excluded and counted in `excluded`. That count is also given
 * when nobody has acted yet (nothing to rank against, all of them waiting). It is 0
 * when the omission is missing evidence: no subset was cut from a number that does not
 * exist, and the unacted opponent is the cause rather than something excluded.
 */
export function coachEquityRanges(estimate) {
  const none = (reason) => ({ ranges: null, reason, excluded: 0 });
  const players = estimate?.players;
  if (!isObject(players) || !Array.isArray(estimate.acted) || !Array.isArray(estimate.unacted)) return none('no-estimate');
  const ids = Object.keys(players);
  const grouped = [...estimate.acted, ...estimate.unacted];
  const complete = grouped.length === ids.length && ids.every((pid) => grouped.includes(pid))
    && ids.every((pid) => players[pid]?.status === 'conditioned' && isObject(players[pid].range));
  if (!Array.isArray(estimate.issues) || estimate.issues.length || !complete) return none('range-evidence-missing');
  if (!estimate.acted.length) return { ranges: null, reason: 'no-acted-opponent', excluded: estimate.unacted.length };
  return { ranges: estimate.acted.map((pid) => players[pid].range), reason: null, excluded: estimate.unacted.length };
}
