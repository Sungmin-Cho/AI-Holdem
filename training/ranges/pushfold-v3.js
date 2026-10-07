// Chip-EV push/fold approximation for short stacks (reference v3).
// Fictitious play between the open-shover and the players left behind it, with
// card removal: every range and call probability is conditioned on the hand
// being evaluated. Stated limits: no antes, equal effective stacks, at most one
// caller (overcalls ignored), no ICM.
import { HAND_CLASSES, comboCount, combosOfClass } from '../../shared/poker-eval.js';
import { classEquity } from './equity-table.js';

const N = 169;
let tables = null;
// E[h][v]: class equity; C[h][v]: villain combos compatible with one hero combo
// of class h, averaged over hero combos (card removal).
function equityTables() {
  if (tables) return tables;
  const E = new Float64Array(N * N);
  const C = new Float64Array(N * N);
  const combos = HAND_CLASSES.map(combosOfClass);
  for (let h = 0; h < N; h += 1) {
    for (let v = 0; v < N; v += 1) {
      E[h * N + v] = classEquity(HAND_CLASSES[h], HAND_CLASSES[v]);
      let compatible = 0;
      for (const [a, b] of combos[h]) for (const [c, d] of combos[v]) if (a !== c && a !== d && b !== c && b !== d) compatible += 1;
      C[h * N + v] = compatible / combos[h].length;
    }
  }
  tables = { E, C };
  return tables;
}

function eqVs(hand, range, { E, C }) {
  let num = 0;
  let den = 0;
  for (let v = 0; v < N; v += 1) {
    const w = C[hand * N + v] * range[v];
    if (w) { num += w * E[hand * N + v]; den += w; }
  }
  return den ? num / den : 0.5;
}

// Probability that a player holding a random hand from `range` exists, given hero's hand.
function massGiven(hand, range, { C }) {
  let sum = 0;
  let total = 0;
  for (let v = 0; v < N; v += 1) {
    const w = C[hand * N + v];
    sum += w * range[v];
    total += w;
  }
  return total ? sum / total : 0;
}

// Posted blinds for [shover, caller1..callerK]. With one player behind, the
// shover is the small blind; otherwise the last two behind are SB and BB.
export function postedBlinds(behind) {
  const posted = new Array(behind + 1).fill(0);
  if (behind === 1) { posted[0] = 0.5; posted[1] = 1; } else { posted[behind - 1] = 0.5; posted[behind] = 1; }
  return posted;
}

export const PUSHFOLD_ITERATIONS = 600;
// Hands whose best response beats the alternative by more than this keep a pure
// action after convergence; closer ones keep their averaged (mixed) frequency.
const EQUITY_MARGIN = 0.004;
const EV_MARGIN_BB = 0.04;

function pushEv(hand, S, posted, dead, callers, t) {
  let ev = 0;
  let none = 1;
  for (let c = 1; c <= callers.length; c += 1) {
    const p = massGiven(hand, callers[c - 1], t);
    const first = none * p;
    const pot = 2 * S + dead - posted[0] - posted[c];
    if (first > 0) ev += first * eqVs(hand, callers[c - 1], t) * pot;
    none *= 1 - p;
  }
  return ev + none * (S + dead - posted[0]) - (S - posted[0]);
}

// Returns { push: Float64Array(169), call: [Float64Array(169) per caller] }.
export function solvePushFold(behind, stackBb, iterations = PUSHFOLD_ITERATIONS) {
  if (!Number.isInteger(behind) || behind < 1 || behind > 8 || !(stackBb > 1)) throw new Error('bad push/fold spot');
  const t = equityTables();
  const posted = postedBlinds(behind);
  const dead = posted.reduce((a, b) => a + b, 0);
  const S = stackBb;
  const need = c => (S - posted[c]) / (2 * S + dead - posted[0] - posted[c]);
  // Both sides best-respond to the other's running average (iteration 0 = shove all).
  const avgPush = new Float64Array(N).fill(1);
  const avgCall = Array.from({ length: behind }, () => new Float64Array(N));
  for (let it = 1; it <= iterations; it += 1) {
    for (let c = 1; c <= behind; c += 1) {
      const avg = avgCall[c - 1];
      const threshold = need(c);
      for (let h = 0; h < N; h += 1) avg[h] += ((eqVs(h, avgPush, t) > threshold ? 1 : 0) - avg[h]) / it;
    }
    for (let h = 0; h < N; h += 1) {
      const best = pushEv(h, S, posted, dead, avgCall, t) > 0 ? 1 : 0;
      avgPush[h] += (best - avgPush[h]) / (it + 1);
    }
  }
  // Purify: keep a mix only where the two actions are genuinely close.
  const push = new Float64Array(N);
  for (let h = 0; h < N; h += 1) {
    const ev = pushEv(h, S, posted, dead, avgCall, t);
    push[h] = ev > EV_MARGIN_BB ? 1 : ev < -EV_MARGIN_BB ? 0 : avgPush[h];
  }
  const call = avgCall.map((avg, i) => {
    const threshold = need(i + 1);
    return Float64Array.from(avg, (f, h) => {
      const edge = eqVs(h, push, t) - threshold;
      return edge > EQUITY_MARGIN ? 1 : edge < -EQUITY_MARGIN ? 0 : f;
    });
  });
  return { push, call };
}
