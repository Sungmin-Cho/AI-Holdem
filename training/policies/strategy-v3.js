// Policy v3 (learning calibration D11). Preflop follows the v3 reference charts
// (the same pure generator as the reference) with persona width changes, and
// the push/fold charts when short. Off-chart lines and every postflop decision
// compare equity against estimated ranges with the price. Ranges narrow by
// board strength as opponents bet or raise. Pure and deterministic: Monte Carlo
// seeds come from the decision id and the opponent count; sampling among the
// returned entries is done by the caller (deriveUnit).
import {
  HAND_CLASSES, HAND_CLASS_INDEX, combosOfClass, comboCount, describeMadeHand, drawsOf, equityVs,
  isSoleRiverNuts, scoreCards, seedFrom, toCardInts,
} from '../../shared/poker-eval.js';
import { winnablePotAfterCall } from '../../shared/decision-facts.js';
import { PREFLOP_ORDERS_V3, trainingPositionV3 } from '../../shared/preflop-key.js';
import { nearestBucket, V3_BANDS } from '../../shared/reference-coverage-v3.js';
import { handClassOf } from '../cards.js';
import { pushChart, rfiRange, shoveCallChart, vs3betChart, vsOpenChart } from '../ranges/charts-v3.js';
import { equityVsRange } from '../ranges/equity-table.js';
import { estimateOpponentRanges } from '../ranges/estimate-v3.js';
import { fallbackLegal, isStrategyV3, legalizeEntries, VERSION_V3 } from './contracts.js';
import { roundToUnit } from './sizing.js';

export { isStrategyV3, VERSION_V3 };
const N = HAND_CLASSES.length;
const POSTFLOP_SAMPLES = 500;
const PREFLOP_SAMPLES = 400;
const PREMIUMS = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function invalidConfig() {
  const error = new Error('v3 policy config is invalid');
  error.code = 'POLICY_CONFIG_MISMATCH';
  return error;
}

const PREFLOP_KEYS = ['rfiWidth', 'callWidth', 'threeBetScale', 'bluffThreeBet', 'limp', 'pushWidth'];
function personaOf(config) {
  const traits = config?.traits;
  const preflop = config?.preflop;
  if (!isStrategyV3(config) || !traits || !preflop
    || ['tightness', 'aggression', 'calling', 'bluff'].some((k) => !Number.isFinite(traits[k]) || traits[k] < 0 || traits[k] > 1)
    || PREFLOP_KEYS.some((k) => !Number.isFinite(preflop[k]) || preflop[k] < 0 || preflop[k] > 4)
    || preflop.limp > 1) throw invalidConfig();
  return { traits, preflop };
}

// ---- hand orders and range arithmetic ------------------------------------

let strengthOrder = null;
// Class indices by equity against a random hand, strongest first.
function preflopOrder() {
  if (strengthOrder) return strengthOrder;
  const random = Object.fromEntries(HAND_CLASSES.map((cls) => [cls, 1]));
  const equity = HAND_CLASSES.map((cls) => equityVsRange(cls, random));
  strengthOrder = HAND_CLASSES.map((_, i) => i).sort((a, b) => equity[b] - equity[a] || a - b);
  return strengthOrder;
}
const COMBOS = HAND_CLASSES.map(comboCount);

/** Widen (w > 1) or narrow (w < 1) a 169-frequency range by combo mass along
 * `order` (strongest first): narrowing drops the weakest mass first, widening
 * fills the strongest hands not yet fully in. */
export function scaleWidth(freq, w, order = preflopOrder()) {
  const out = Float64Array.from(freq);
  if (!(w >= 0) || w === 1) return out;
  const base = out.reduce((sum, f, i) => sum + f * COMBOS[i], 0);
  const target = Math.min(1326, base * w);
  if (w < 1) {
    let kept = 0;
    for (const i of order) {
      const mass = out[i] * COMBOS[i];
      if (kept + mass <= target + 1e-9) { kept += mass; continue; }
      const room = Math.max(0, target - kept);
      out[i] = room / COMBOS[i];
      kept += room;
    }
    return out;
  }
  let added = 0;
  const need = target - base;
  for (const i of order) {
    if (added >= need - 1e-9) break;
    const take = Math.min((1 - out[i]) * COMBOS[i], need - added);
    out[i] += take / COMBOS[i];
    added += take;
  }
  return out;
}

const asObject = (freq) => {
  const out = {};
  for (let i = 0; i < N; i += 1) if (freq[i] > 1e-9) out[HAND_CLASSES[i]] = Math.min(1, freq[i]);
  return Object.keys(out).length ? out : null;
};
const asArray = (range) => {
  const out = new Float64Array(N);
  if (!range) out.fill(1);
  else for (const [cls, f] of Object.entries(range)) out[HAND_CLASS_INDEX[cls]] = f;
  return out;
};
// The top fraction of all hands by preflop equity (a stand-in range for lines the charts do not model).
function topRange(fraction) {
  return scaleWidth(new Float64Array(N).fill(1), clamp(fraction, 0.01, 1));
}

// Board strength of a class: the mean made-hand score of its unblocked combos
// plus a draw allowance, used to keep the strongest part of a range.
function boardOrder(board, dead) {
  const known = new Set(dead);
  const rows = HAND_CLASSES.map((cls, i) => {
    let total = 0;
    let n = 0;
    for (const [a, b] of combosOfClass(cls)) {
      if (known.has(a) || known.has(b)) continue;
      const cards = [a, b, ...board];
      let score = scoreCards(cards);
      // A strong draw continues like a middle pair.
      if (board.length < 5 && score < MIDDLE_PAIR && drawsOf([cardName(a), cardName(b)], board.map(cardName)).outs >= 8) score = MIDDLE_PAIR;
      total += score;
      n += 1;
    }
    return { i, strength: n ? total / n : -1 };
  });
  return rows.sort((x, y) => y.strength - x.strength || x.i - y.i).map((row) => row.i);
}
const CATEGORY_SPAN = 13 ** 5;
const MIDDLE_PAIR = CATEGORY_SPAN + 6 * 2197; // a pair of eights with no kicker
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const cardName = (card) => `${RANKS[card >> 2]}${SUITS[card & 3]}`;

// ---- snapshot reading ---------------------------------------------------

function tableOf(snapshot) {
  const live = (snapshot.publicSeats ?? []).filter((seat) => !seat.out);
  const seated = live.length;
  const order = PREFLOP_ORDERS_V3[seated] ?? null;
  const position = new Map(live.map((seat) => [seat.playerId, order ? trainingPositionV3(seat.position, seated) : null]));
  const hero = live.find((seat) => seat.playerId === snapshot.actorId);
  const total = (seat) => (seat?.stack ?? 0) + (seat?.contribution ?? 0);
  const opponents = live.filter((seat) => seat.playerId !== snapshot.actorId && !seat.folded);
  const preflop = (snapshot.priorActions ?? []).filter((a) => (a.street ?? 'preflop') === 'preflop');
  return { live, seated, order, position, hero, total, opponents, preflop, bb: snapshot.blinds?.[1] ?? 1, sb: snapshot.blinds?.[0] ?? 1 };
}

const allInRaise = (action) => action.action === 'raise' && Number.isInteger(action.maxRaiseTo) && action.amount === action.maxRaiseTo;

function sizedRaise(snapshot, legal, target, t) {
  if (!legal?.canRaise) return null;
  let to = roundToUnit(target, t.sb);
  // A raise that commits most of the stack goes all-in instead.
  if (to >= legal.maxRaiseTo * 0.6) to = legal.maxRaiseTo;
  return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, to));
}

function entries(list, legal, bb) {
  const legalItems = legalizeEntries(list.filter((row) => row.frequency > 1e-9), legal, { bb });
  return legalItems.length ? legalItems : fallbackLegal(legal);
}

// ---- preflop ------------------------------------------------------------

function preflopDistribution(snapshot, legal, persona, t) {
  const { traits, preflop: p } = persona;
  const cls = handClassOf(snapshot.holeCards);
  const idx = HAND_CLASS_INDEX[cls];
  const heroPos = t.position.get(snapshot.actorId);
  const raises = t.preflop.filter((a) => a.action === 'raise');
  const calls = t.preflop.filter((a) => a.action === 'call');
  const heroTotal = t.total(t.hero);
  const allIn = { action: 'raise', raiseTo: legal.maxRaiseTo };
  if (!t.order || !heroPos) return offChartPreflop(snapshot, legal, persona, t, cls);

  // Unopened: open (or limp for a passive persona), or push when short.
  if (raises.length === 0 && calls.length === 0) {
    const heroIndex = t.order.indexOf(heroPos);
    const behind = t.order.slice(heroIndex + 1);
    const behindMax = Math.max(0, ...t.live.filter((s) => behind.includes(t.position.get(s.playerId))).map(t.total));
    const effBb = Math.min(heroTotal, behindMax) / t.bb;
    if (effBb <= V3_BANDS.pushMax) {
      const f = scaleWidth(pushChart(t.seated, heroPos, nearestBucket(Math.max(effBb, 2))).raise, p.pushWidth)[idx];
      return [{ ...allIn, frequency: f, reasonCode: 'v3-push' }, { action: 'fold', frequency: 1 - f, reasonCode: 'v3-push-fold' }];
    }
    const f = clamp(scaleWidth(rfiRange(t.seated, heroPos), p.rfiWidth)[idx]);
    const openTo = sizedRaise(snapshot, legal, (heroPos === 'SB' ? 3 : 2.5) * t.bb, t);
    return [
      { action: 'raise', raiseTo: openTo, frequency: f * (1 - p.limp), reasonCode: 'v3-open' },
      { action: 'call', frequency: f * p.limp, reasonCode: 'v3-limp' },
      { action: 'fold', frequency: 1 - f, reasonCode: 'v3-open-fold' },
    ];
  }

  const open = raises[0];
  // Facing one raise with only folds around it.
  if (raises.length === 1 && calls.length === 0 && open.playerId !== snapshot.actorId) {
    const opener = t.live.find((s) => s.playerId === open.playerId);
    const oppPos = t.position.get(open.playerId);
    const effBb = Math.min(heroTotal, t.total(opener)) / t.bb;
    if (!oppPos || t.order.indexOf(oppPos) >= t.order.indexOf(heroPos)) return offChartPreflop(snapshot, legal, persona, t, cls);
    if (allInRaise(open) && t.total(opener) / t.bb <= V3_BANDS.pushMax) {
      const f = scaleWidth(shoveCallChart(t.seated, heroPos, oppPos, nearestBucket(Math.max(effBb, 2))).call, Math.sqrt(p.callWidth))[idx];
      return [{ action: 'call', frequency: f, reasonCode: 'v3-call-shove' }, { action: 'fold', frequency: 1 - f, reasonCode: 'v3-fold-shove' }];
    }
    const facingBb = open.amount / t.bb;
    if (!allInRaise(open) && effBb > V3_BANDS.midStack[1] && facingBb <= 4.5) {
      const chart = vsOpenChart(t.seated, heroPos, oppPos);
      return chartResponse(chart, idx, p, legal, snapshot, t, { to: open.amount * (t.order.indexOf(heroPos) >= t.order.indexOf('SB') ? 3.6 : 3), tag: '3bet' });
    }
    return offChartPreflop(snapshot, legal, persona, t, cls);
  }

  // Hero opened, one 3-bet, everyone else folded.
  if (raises.length === 2 && raises[0].playerId === snapshot.actorId && calls.length === 0 && !allInRaise(raises[1])) {
    const villain = t.live.find((s) => s.playerId === raises[1].playerId);
    const villainPos = t.position.get(raises[1].playerId);
    const effBb = Math.min(heroTotal, t.total(villain)) / t.bb;
    // The chart answers 3-bets of the reference's sizes; a larger one (80BB into
    // 2.5BB) is priced off the chart.
    if (villainPos && effBb > V3_BANDS.midStack[1] && raises[1].amount / t.bb <= V3_BANDS.threeBetProjected[1]) {
      const chart = vs3betChart(t.seated, heroPos, villainPos);
      return chartResponse(chart, idx, p, legal, snapshot, t, { to: raises[1].amount * 2.3, tag: '4bet' });
    }
  }
  return offChartPreflop(snapshot, legal, persona, t, cls);
}

// Chart response with persona changes: the continuing range widens or narrows
// (callWidth), raises scale (threeBetScale), and the weaker raising hands are
// raised more often by a bluff-heavy persona (bluffThreeBet).
function chartResponse(chart, idx, p, legal, snapshot, t, { to, tag }) {
  const cont = new Float64Array(N);
  for (let i = 0; i < N; i += 1) cont[i] = clamp((chart.raise?.[i] ?? 0) + (chart.call?.[i] ?? 0));
  const continuing = scaleWidth(cont, p.callWidth);
  const raiseBase = chart.raise?.[idx] ?? 0;
  const order = preflopOrder();
  const rank = order.indexOf(idx) / N;
  const bluffy = raiseBase > 0 && rank > 0.25;
  const raise = clamp(raiseBase * p.threeBetScale * (bluffy ? p.bluffThreeBet : 1), 0, continuing[idx]);
  const call = Math.max(0, continuing[idx] - raise);
  const raiseTo = sizedRaise(snapshot, legal, to, t);
  return [
    { action: 'raise', raiseTo, frequency: raise, reasonCode: `v3-${tag}` },
    { action: 'call', frequency: call, reasonCode: `v3-${tag}-call` },
    { action: 'fold', frequency: 1 - raise - call, reasonCode: `v3-${tag}-fold` },
  ];
}

// The price of a call against the pot it can win: a bet above hero's stack is
// returned, not won (the fact card's arithmetic).
function requiredEquity(snapshot, call) {
  if (!(call > 0)) return 0;
  const winnable = winnablePotAfterCall(snapshot);
  return call / (winnable > call ? winnable : Math.max(0, snapshot.potBefore ?? 0) + call);
}

// Lines the charts do not model (limps, callers, 4-bets, deep all-ins): equity
// against stand-in ranges compared with the price.
function offChartPreflop(snapshot, legal, persona, t, cls) {
  const { traits } = persona;
  const raises = t.preflop.filter((a) => a.action === 'raise');
  const estimated = (() => { try { return estimateOpponentRanges(snapshot); } catch { return {}; } })();
  const ranges = t.opponents.slice(0, 8).map((seat) => {
    const own = t.preflop.filter((a) => a.playerId === seat.playerId);
    if (estimated[seat.playerId]) return estimated[seat.playerId];
    if (own.some((a) => a.action === 'raise')) {
      const nth = raises.findIndex((a) => a.playerId === seat.playerId);
      return asObject(topRange(nth >= 2 || own.some(allInRaise) ? 0.05 : nth === 1 ? 0.1 : 0.22));
    }
    if (own.some((a) => a.action === 'call')) return asObject(topRange(0.4));
    return null;
  });
  let equity;
  try {
    equity = equityVs({ holeCards: snapshot.holeCards, boardCards: [], ranges: ranges.length ? ranges : [null], samples: PREFLOP_SAMPLES,
      seed: seedFrom(`${snapshot.decisionId}:${ranges.length}:preflop`) });
  } catch { equity = 0.3; }
  const call = Math.max(0, legal.callAmount ?? 0);
  const need = requiredEquity(snapshot, call);
  const share = 1 / (1 + t.opponents.length);
  const strong = equity >= Math.max(0.55, share + 0.18) || (raises.length >= 2 && PREMIUMS.has(cls));
  const jam = raises.length >= 3 || (raises.length >= 2 && PREMIUMS.has(cls));
  const raiseTo = jam ? legal.maxRaiseTo
    : sizedRaise(snapshot, legal, raises.length ? raises.at(-1).amount * 3 : (2.5 + t.preflop.filter((a) => a.action === 'call').length) * t.bb, t);
  const pRaise = strong ? clamp(0.35 + 0.55 * traits.aggression) : 0;
  if (legal.canCheck) {
    return [{ action: 'raise', raiseTo, frequency: pRaise, reasonCode: 'v3-iso' }, { action: 'check', frequency: 1 - pRaise, reasonCode: 'v3-check' }];
  }
  const margin = 0.03 - 0.08 * traits.calling;
  const pCall = equity >= need + margin ? 1 - pRaise : 0;
  return [
    { action: 'raise', raiseTo, frequency: pRaise, reasonCode: 'v3-offchart-raise' },
    { action: 'call', frequency: pCall, reasonCode: 'v3-offchart-call' },
    { action: 'fold', frequency: 1 - pRaise - pCall, reasonCode: 'v3-offchart-fold' },
  ];
}

// ---- postflop -----------------------------------------------------------

// Each opponent's preflop range, narrowed by board strength for every postflop
// bet or raise (to the top 75%) and call (top 90%). A bettor is not assumed to
// hold only strong hands, so frequent betting does not buy automatic folds.
function narrowedRanges(snapshot, t) {
  let estimated = {};
  try { estimated = estimateOpponentRanges(snapshot); } catch { estimated = {}; }
  const board = toCardInts(snapshot.board);
  const order = boardOrder(board, [...toCardInts(snapshot.holeCards), ...board]);
  return t.opponents.slice(0, 8).map((seat) => {
    const actions = (snapshot.priorActions ?? []).filter((a) => a.playerId === seat.playerId && (a.street ?? 'preflop') !== 'preflop');
    const aggressive = actions.filter((a) => a.action === 'raise').length;
    const passive = actions.filter((a) => a.action === 'call').length;
    const w = 0.75 ** aggressive * 0.9 ** passive;
    const base = asArray(estimated[seat.playerId] ?? null);
    return w < 1 ? asObject(scaleWidth(base, w, order)) : asObject(base);
  });
}

// A player's preflop range estimated from the other side's view, narrowed by
// its own postflop line like an opponent's (0.75 per bet or raise, 0.9 per call).
function rangeOfPlayer(snapshot, playerId, viewerId, order) {
  let estimated = {};
  try { estimated = estimateOpponentRanges({ ...snapshot, actorId: viewerId }); } catch { estimated = {}; }
  const actions = (snapshot.priorActions ?? []).filter((a) => a.playerId === playerId && (a.street ?? 'preflop') !== 'preflop');
  const w = 0.75 ** actions.filter((a) => a.action === 'raise').length * 0.9 ** actions.filter((a) => a.action === 'call').length;
  const base = asArray(estimated[playerId] ?? null);
  return w < 1 ? scaleWidth(base, w, order) : base;
}

// The baseline persona's bluff trait: personas bluff in proportion to it.
const BASE_BLUFF = 0.14;
const valueBetFrequency = (traits) => clamp(0.55 + 0.4 * traits.aggression);

// River bluff mass (design D11). Each combo of hero's own range is scored against
// the opponent's continuing range on the complete board (card removal between the
// two ranges is ignored). With value mass V (equity ≥ valueLine), bluffs fill
// V·b/(1+b), scaled by the persona's bluff trait, from the weakest showdown
// values up. Returns the plan; `share(score)` is the bluff share of a hand.
function riverBluffPlan(snapshot, t, traits, fraction, valueLine) {
  const board = toCardInts(snapshot.board);
  const blocked = new Set(board);
  const order = boardOrder(board, board);
  const villain = t.opponents[0];
  const rows = (range) => {
    const out = [];
    for (let i = 0; i < N; i += 1) {
      if (!(range[i] > 0)) continue;
      for (const [a, b] of combosOfClass(HAND_CLASSES[i])) {
        if (!blocked.has(a) && !blocked.has(b)) out.push({ w: range[i], s: scoreCards([a, b, ...board]) });
      }
    }
    return out;
  };
  const villainRows = rows(rangeOfPlayer(snapshot, villain.playerId, snapshot.actorId, order)).sort((x, y) => x.s - y.s);
  const below = new Float64Array(villainRows.length + 1);
  villainRows.forEach((row, i) => { below[i + 1] = below[i] + row.w; });
  const total = below[villainRows.length];
  const firstAtLeast = (score) => { let lo = 0; let hi = villainRows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (villainRows[mid].s < score) lo = mid + 1; else hi = mid; } return lo; };
  const firstAbove = (score) => { let lo = 0; let hi = villainRows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (villainRows[mid].s <= score) lo = mid + 1; else hi = mid; } return lo; };
  const equityOf = (score) => (total > 0 ? (below[firstAtLeast(score)] + (below[firstAbove(score)] - below[firstAtLeast(score)]) / 2) / total : 0.5);
  const heroRows = rows(rangeOfPlayer(snapshot, snapshot.actorId, villain.playerId, order)).map((row) => ({ ...row, e: equityOf(row.s) }));
  // Value combos bet at the value-bet frequency; V is what actually bets.
  const value = heroRows.reduce((sum, row) => sum + (row.e >= valueLine ? row.w : 0), 0) * valueBetFrequency(traits);
  const target = value * (fraction / (1 + fraction)) * (traits.bluff / BASE_BLUFF);
  const share = (score) => {
    const e = equityOf(score);
    if (e >= valueLine) return 0;
    const weaker = heroRows.reduce((sum, row) => sum + (row.e < e ? row.w : 0), 0);
    const same = heroRows.reduce((sum, row) => sum + (row.e === e ? row.w : 0), 0);
    if (same === 0) return weaker < target ? 1 : 0;
    return clamp((target - weaker) / same);
  };
  return { value, target, heroRows, equityOf, share };
}

// River nuts: nothing beats the hand and it is not a split with the board.
const isRiverNuts = isSoleRiverNuts;

function wetBoard(board) {
  const cards = toCardInts(board);
  const suits = [0, 0, 0, 0];
  for (const c of cards) suits[c & 3] += 1;
  const ranks = [...new Set(cards.map((c) => c >> 2))].sort((a, b) => a - b);
  let connected = 0;
  for (let i = 1; i < ranks.length; i += 1) if (ranks[i] - ranks[i - 1] <= 2) connected += 1;
  return Math.max(...suits) >= 2 || connected >= 2;
}

function postflopDistribution(snapshot, legal, persona, t) {
  const { traits } = persona;
  const ranges = narrowedRanges(snapshot, t);
  let equity;
  try {
    equity = equityVs({ holeCards: snapshot.holeCards, boardCards: snapshot.board, ranges: ranges.length ? ranges : [null],
      samples: POSTFLOP_SAMPLES, seed: seedFrom(`${snapshot.decisionId}:${ranges.length}`) });
  } catch { equity = 0.3; }
  const multi = Math.max(0, t.opponents.length - 1);
  const river = snapshot.street === 'river';
  const draws = river ? { outs: 0 } : drawsOf(snapshot.holeCards, snapshot.board);
  const strongDraw = draws.outs >= 8;
  const pot = Math.max(1, snapshot.potBefore ?? 1);
  const actorBet = snapshot.actorBet ?? 0;
  const wet = wetBoard(snapshot.board);

  if (legal.canCheck) {
    const valueLine = 0.62 + 0.05 * multi;
    const preflopAggressor = t.preflop.filter((a) => a.action === 'raise').at(-1)?.playerId === snapshot.actorId;
    const streetActions = (snapshot.priorActions ?? []).filter((a) => a.street === snapshot.street);
    const firstToActOnFlop = snapshot.street === 'flop' && streetActions.every((a) => a.action === 'check');
    let fraction;
    let pBet;
    let reason;
    if (equity >= valueLine) {
      fraction = equity >= 0.8 || wet ? 0.75 : 0.5;
      pBet = valueBetFrequency(traits);
      reason = 'v3-value-bet';
    } else if (strongDraw && !river) {
      fraction = 0.6;
      pBet = clamp((0.2 + 0.45 * traits.aggression) * (multi ? 0.5 : 1));
      reason = 'v3-semibluff-bet';
    } else if (preflopAggressor && firstToActOnFlop) {
      fraction = 0.33;
      pBet = clamp((0.15 + 0.45 * traits.aggression + 0.2 * traits.bluff) * (multi ? 0.45 : 1));
      reason = 'v3-cbet';
    } else {
      // River heads-up: bluff mass V·b/(1+b) of the value combos, weakest showdown values first.
      fraction = 0.66;
      pBet = river && !multi
        ? riverBluffPlan(snapshot, t, traits, fraction, valueLine).share(scoreCards([...toCardInts(snapshot.holeCards), ...toCardInts(snapshot.board)]))
        : 0;
      if (!(pBet > 0)) return entries([{ action: 'check', frequency: 1, reasonCode: 'v3-check' }], legal, t.bb);
      reason = 'v3-river-bluff';
    }
    const raiseTo = sizedRaise(snapshot, legal, actorBet + fraction * pot, t);
    return entries([
      { action: 'raise', raiseTo, frequency: pBet, reasonCode: reason },
      { action: 'check', frequency: 1 - pBet, reasonCode: 'v3-check' },
    ], legal, t.bb);
  }

  const call = Math.max(0, legal.callAmount ?? 0);
  const need = requiredEquity(snapshot, call);
  const raiseTo = sizedRaise(snapshot, legal, Math.max(snapshot.currentBet ?? 0, 1) * 3, t);
  let pRaise = 0;
  let reason = 'v3-raise';
  if (river) {
    // River raises are value only: the nuts nearly always, a hand with 70%
    // against the continuing range by temperament.
    if (isRiverNuts(snapshot.holeCards, snapshot.board)) { pRaise = clamp(0.8 + 0.2 * traits.aggression); reason = 'v3-river-nut-raise'; }
    else if (equity >= 0.7) { pRaise = clamp(0.25 + 0.6 * traits.aggression); reason = 'v3-river-value-raise'; }
  } else if (equity >= 0.75) {
    pRaise = clamp(0.25 + 0.5 * traits.aggression);
    reason = 'v3-value-raise';
  } else if (strongDraw && snapshot.street === 'flop' && !multi) {
    pRaise = clamp(0.12 * traits.aggression + 0.15 * traits.bluff);
    reason = 'v3-semibluff-raise';
  } else if (!multi && equity < 0.3 && snapshot.street !== 'river') {
    // A few bluff raises with the weakest hands keep a constant bettor honest.
    pRaise = clamp(0.04 + 0.12 * traits.bluff);
    reason = 'v3-bluff-raise';
  }
  const margin = 0.03 - 0.1 * traits.calling;
  const drawPrice = strongDraw && equity >= need * 0.85;
  const pCall = equity >= need + margin || drawPrice ? 1 - pRaise : 0;
  return entries([
    { action: 'raise', raiseTo, frequency: pRaise, reasonCode: reason },
    { action: 'call', frequency: pCall, reasonCode: drawPrice && equity < need + margin ? 'v3-draw-call' : 'v3-call' },
    { action: 'fold', frequency: 1 - pRaise - pCall, reasonCode: 'v3-fold' },
  ], legal, t.bb);
}

export function distributionV3(snapshot, legal, config) {
  const persona = personaOf(config);
  const t = tableOf(snapshot);
  if (snapshot.street === 'preflop') return entries(preflopDistribution(snapshot, legal, persona, t), legal, t.bb);
  return postflopDistribution(snapshot, legal, persona, t);
}

export const __test = { preflopOrder, boardOrder, isRiverNuts, narrowedRanges, tableOf, riverBluffPlan, BASE_BLUFF, valueBetFrequency };
