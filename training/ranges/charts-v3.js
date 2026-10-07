// Deterministic construction of every reference v3 chart. Shared by the dataset
// build (tools/build-preflop-baseline.js --version 3) and the v3 opponent policy,
// so the bots and the grading reference never drift apart.
//
// Method (original, heuristic — not solver output):
// - RFI: authored charts (rfi-v3.js).
// - Facing a single open: 3-bet value by equity against the opener's range, a
//   fixed 3-bet bluff priority, then calls by equity x realization; boundaries are
//   soft so neighbouring hands mix instead of flipping from 100% to 0%.
// - Facing a 3-bet after opening: 4-bet value/bluff and calls inside the
//   opener's own range; hands outside it fold.
// - Short stacks: chip-EV push/fold (pushfold-v3.js).
import { HAND_CLASSES, comboCount } from '../../shared/poker-eval.js';
import { PREFLOP_ORDERS_V3, PUSHFOLD_STACKS_BB, parsePreflopKeyV3, playersBehind, preflopKeysV3 } from '../../shared/preflop-key.js';
import { equityVsRange } from './equity-table.js';
import { RFI_TEXT_V3, parseRange, rangePercent } from './rfi-v3.js';
import { solvePushFold } from './pushfold-v3.js';

const N = 169;
const RANKS = 'AKQJT98765432';
export const UNITS = 10000;
export const SIZES_V3 = Object.freeze({ openBb: 2.5, threeBetBb: 8.5, fourBetBb: 20 });

function asObject(freq) {
  const out = {};
  for (let i = 0; i < N; i += 1) if (freq[i] > 0) out[HAND_CLASSES[i]] = freq[i];
  return out;
}

function interp(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points.at(-1)[1];
}

const gap = cls => (cls.length === 2 ? 0 : RANKS.indexOf(cls[1]) - RANKS.indexOf(cls[0]) - 1);
const highRank = cls => 12 - RANKS.indexOf(cls[0]);

// How much of its raw equity a hand tends to realize when it calls.
export function realization(cls, inPosition) {
  if (cls.length === 2) return 0.8 + 0.2 * (highRank(cls) / 12) - (inPosition ? 0 : 0.04);
  const suited = cls[2] === 's';
  const broadway = 'AKQJT'.includes(cls[0]) && 'AKQJT'.includes(cls[1]);
  let value = suited ? 0.97 + 0.03 * (highRank(cls) / 12) : 0.86 + (broadway ? 0.07 : 0) + 0.04 * (highRank(cls) / 12);
  value -= Math.min(gap(cls), 3) * (suited ? 0.02 : 0.025);
  if (!inPosition) value -= suited ? 0.02 : 0.04;
  return value;
}

function orderBy(score) {
  return HAND_CLASSES.map((cls, i) => i).sort((a, b) => score[b] - score[a] || a - b);
}

// Soft fill: frequencies ramp linearly across `window` combos around the
// boundary. The boundary is shifted (bisection) until the filled combos equal the
// target, so hands well inside it stay at exactly 100% of their remaining share.
// `room` holds the share of each class still unassigned and is consumed.
function softFill(order, targetCombos, room, window) {
  const mids = [];
  let cum = 0;
  for (const i of order) {
    if (room[i] <= 1e-12) continue;
    const w = comboCount(HAND_CLASSES[i]) * room[i];
    mids.push([i, cum + w / 2, w]);
    cum += w;
  }
  const target = Math.min(targetCombos, cum);
  const filled = shift => mids.reduce((sum, [, mid, w]) => sum + w * Math.max(0, Math.min(1, (target + shift - mid) / window + 0.5)), 0);
  let lo = -window - cum;
  let hi = window + cum;
  for (let n = 0; n < 80; n += 1) {
    const midShift = (lo + hi) / 2;
    if (filled(midShift) < target) lo = midShift; else hi = midShift;
  }
  const freq = new Float64Array(N);
  for (const [i, mid] of mids) {
    const f = Math.max(0, Math.min(1, (target + hi - mid) / window + 0.5));
    freq[i] = room[i] * f;
    room[i] -= freq[i];
  }
  return freq;
}

// Value raises prefer blockers to the strongest continuing hands and leave
// medium pairs, which play well as calls, slightly behind.
function valueScore(cls, equity) {
  let score = equity;
  if (cls.includes('A')) score += 0.02;
  if (cls.includes('K')) score += 0.01;
  if (cls.length === 2 && 'JT98765432'.includes(cls[0])) score -= 0.02;
  return score;
}

// A continuing hand keeps at least this share for the other continuing action,
// so a reasonable 3-bet-or-call choice is never graded as a zero-frequency play.
export const CONTINUE_FLOOR = 0.05;
function applyContinueFloor(raise, call, allowCall = true) {
  for (let i = 0; i < N; i += 1) {
    const total = raise[i] + call[i];
    if (total < 0.5 || !allowCall) continue;
    const floor = CONTINUE_FLOOR * total;
    if (raise[i] < floor) { call[i] -= floor - raise[i]; raise[i] = floor; }
    else if (call[i] < floor) { raise[i] -= floor - call[i]; call[i] = floor; }
  }
}

const THREE_BET_BLUFFS = ['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'Q9s', 'J9s', 'T8s', '98s', '87s', '76s', '65s', '54s',
  'K8s', 'K7s', 'K6s', 'K5s', 'Q8s', 'J8s', 'T7s', '97s', '86s', '75s', '64s'].map(c => HAND_CLASSES.indexOf(c));
const FOUR_BET_BLUFFS = ['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'KTs', 'QJs'].map(c => HAND_CLASSES.indexOf(c));

const rfiCache = new Map();
export function rfiRange(seated, position) {
  const key = `${seated}:${position}`;
  if (!rfiCache.has(key)) {
    const behind = playersBehind(seated, position);
    if (behind === null || behind < 1) throw new Error(`no RFI chart for ${key}`);
    rfiCache.set(key, parseRange(seated === 2 ? RFI_TEXT_V3.hu : RFI_TEXT_V3[behind]));
  }
  return rfiCache.get(key);
}

// Facing-open targets in % of all combos, interpolated on the opener's RFI width.
export function vsOpenTargets(seated, hero, opener) {
  const r = rangePercent(rfiRange(seated, opener));
  const valueShare = interp(r, [[10, 0.8], [17.6, 0.75], [28.1, 0.65], [45.2, 0.6]]);
  if (hero === 'BB' && opener === 'SB') {
    return seated === 2 ? { threeBet: 18, call: 50, valueShare: 0.6, inPosition: false }
      : { threeBet: 15, call: 40, valueShare: 0.6, inPosition: false };
  }
  if (hero === 'BB') {
    return { threeBet: interp(r, [[10, 4.5], [17.6, 5.5], [22.2, 7], [28.1, 9.5], [45.2, 13]]),
      call: interp(r, [[10, 17], [17.6, 21], [22.2, 24], [28.1, 29], [45.2, 40]]), valueShare, inPosition: false };
  }
  if (hero === 'SB') {
    return { threeBet: interp(r, [[10, 4.5], [17.6, 6], [22.2, 7.5], [28.1, 10.5], [45.2, 14]]),
      call: interp(r, [[10, 0.5], [17.6, 1], [28.1, 1.5], [45.2, 2]]), valueShare, inPosition: false };
  }
  const behind = playersBehind(seated, hero);
  const callScale = behind === 2 ? 1 : behind === 3 ? 0.6 : 0.5;
  return { threeBet: interp(r, [[10, 4], [17.6, 5.5], [22.2, 6.5], [28.1, 9.5], [45.2, 11]]) + (hero === 'BTN' ? 0.5 : 0),
    call: interp(r, [[10, 5], [17.6, 7], [22.2, 8.5], [28.1, 10]]) * callScale, valueShare, inPosition: true };
}

const vsOpenCache = new Map();
export function vsOpenChart(seated, hero, opener) {
  const key = `${seated}:${hero}:${opener}`;
  if (vsOpenCache.has(key)) return vsOpenCache.get(key);
  const target = vsOpenTargets(seated, hero, opener);
  const openerRange = asObject(rfiRange(seated, opener));
  const eq = Float64Array.from(HAND_CLASSES, cls => equityVsRange(cls, openerRange));
  const room = new Float64Array(N).fill(1);
  const toCombos = pct => (pct * 1326) / 100;
  const value = softFill(orderBy(Float64Array.from(HAND_CLASSES, (cls, i) => valueScore(cls, eq[i]))), toCombos(target.threeBet * target.valueShare), room, 24);
  const bluffs = THREE_BET_BLUFFS.filter(i => room[i] > 0.5);
  const bluff = softFill(bluffs, toCombos(target.threeBet * (1 - target.valueShare)), room, 16);
  const callScore = Float64Array.from(HAND_CLASSES, (cls, i) => eq[i] * realization(cls, target.inPosition));
  const call = softFill(orderBy(callScore), toCombos(target.call), room, 40);
  const raise = new Float64Array(N);
  for (let i = 0; i < N; i += 1) raise[i] = value[i] + bluff[i];
  applyContinueFloor(raise, call);
  const chart = { raise, call };
  vsOpenCache.set(key, chart);
  return chart;
}

export function vs3betChart(seated, hero, villain) {
  const open = rfiRange(seated, hero);
  const threeBet = asObject(vsOpenChart(seated, villain, hero).raise);
  const inPosition = villain === 'SB' || villain === 'BB' ? hero !== 'SB' : false;
  const eq = Float64Array.from(HAND_CLASSES, cls => equityVsRange(cls, threeBet));
  const room = Float64Array.from(open);
  let reach = 0;
  for (let i = 0; i < N; i += 1) reach += comboCount(HAND_CLASSES[i]) * open[i];
  const value = softFill(orderBy(Float64Array.from(HAND_CLASSES, (cls, i) => valueScore(cls, eq[i]))), reach * 0.07 * 0.7, room, 8);
  const bluffs = FOUR_BET_BLUFFS.filter(i => room[i] > 0.3);
  const bluff = softFill(bluffs, reach * 0.07 * 0.3, room, 6);
  const callScore = Float64Array.from(HAND_CLASSES, (cls, i) => eq[i] * realization(cls, inPosition));
  const call = softFill(orderBy(callScore), reach * (inPosition ? 0.40 : 0.28), room, 20);
  const raise = new Float64Array(N);
  const callShare = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    if (open[i] <= 0) continue;
    raise[i] = (value[i] + bluff[i]) / open[i];
    callShare[i] = call[i] / open[i];
  }
  applyContinueFloor(raise, callShare);
  return { raise, call: callShare, reachable: open };
}

const pushCache = new Map();
function pushSolution(behind, stackBb) {
  const key = `${behind}:${stackBb}`;
  if (!pushCache.has(key)) pushCache.set(key, solvePushFold(behind, stackBb));
  return pushCache.get(key);
}

export function pushChart(seated, position, stackBb) {
  return { raise: pushSolution(playersBehind(seated, position), stackBb).push, call: new Float64Array(N) };
}

export function shoveCallChart(seated, hero, pusher, stackBb) {
  const order = PREFLOP_ORDERS_V3[seated];
  const caller = order.indexOf(hero) - order.indexOf(pusher);
  return { raise: new Float64Array(N), call: pushSolution(playersBehind(seated, pusher), stackBb).call[caller - 1] };
}

export function chartForKey(key) {
  const p = parsePreflopKeyV3(key);
  if (!p) throw new Error(`unknown v3 key ${key}`);
  switch (p.context) {
    case 'rfi-unopened': return { raise: rfiRange(p.seated, p.position), call: new Float64Array(N) };
    case 'vs-single-raise': return vsOpenChart(p.seated, p.position, p.openerPosition);
    case 'vs-3bet': return vs3betChart(p.seated, p.position, p.openerPosition);
    case 'push': return pushChart(p.seated, p.position, p.stackBb);
    case 'vs-shove': return shoveCallChart(p.seated, p.position, p.openerPosition, p.stackBb);
    default: throw new Error(`unknown v3 context ${p.context}`);
  }
}

// Largest-remainder integer units per hand; ties order raise, call, fold.
export function quantizeHand(raise, call) {
  const r = Math.max(0, Math.min(1, raise));
  const c = Math.max(0, Math.min(1 - r, call));
  const rows = [r, c, Math.max(0, 1 - r - c)].map((value, order) => {
    const exact = value * UNITS;
    return { order, units: Math.floor(exact + 1e-9), rest: exact - Math.floor(exact + 1e-9) };
  });
  let left = UNITS - rows.reduce((sum, row) => sum + row.units, 0);
  for (const row of [...rows].sort((a, b) => b.rest - a.rest || a.order - b.order)) {
    if (left <= 0) break;
    row.units += 1;
    left -= 1;
  }
  return rows.map(row => row.units);
}

const encodeUnits = units => units.map(u => u.toString(36).padStart(3, '0')).join('');

// Every key mapped to a de-duplicated chart id; chart ids follow first use.
export function buildChartsV3() {
  const charts = {};
  const spots = {};
  const idOf = new Map();
  for (const key of preflopKeysV3()) {
    const { raise, call } = chartForKey(key);
    const columns = [[], [], []];
    for (let i = 0; i < N; i += 1) {
      const units = quantizeHand(raise[i], call[i]);
      for (let a = 0; a < 3; a += 1) columns[a].push(units[a]);
    }
    const encoded = { raise: encodeUnits(columns[0]), call: encodeUnits(columns[1]), fold: encodeUnits(columns[2]) };
    for (const action of ['raise', 'call']) if (columns[action === 'raise' ? 0 : 1].every(u => u === 0)) delete encoded[action];
    const signature = JSON.stringify(encoded);
    if (!idOf.has(signature)) {
      const id = `c${String(idOf.size + 1).padStart(4, '0')}`;
      idOf.set(signature, id);
      charts[id] = encoded;
    }
    spots[key] = idOf.get(signature);
  }
  return { charts, spots, stacksBb: [...PUSHFOLD_STACKS_BB] };
}
