// Chip-EV push/fold approximation for short stacks (reference v3).
// Fictitious play between the open-shover and the players left behind it, with
// card removal: every range and call probability is conditioned on the hand
// being evaluated. Stated limits: no antes, equal effective stacks, at most one
// caller (overcalls ignored), no ICM.
import { HAND_CLASSES } from '../../shared/poker-eval.js';
import { classEquity, compatibleCombos } from './equity-table.js';

const N = 169;
let tables = null;
// E[h][v]: class equity; C[h][v]: villain combos compatible with one hero combo
// of class h, averaged over hero combos (card removal).
function equityTables() {
  if (tables) return tables;
  const E = new Float64Array(N * N);
  const C = new Float64Array(N * N);
  for (let h = 0; h < N; h += 1) {
    for (let v = 0; v < N; v += 1) {
      E[h * N + v] = classEquity(HAND_CLASSES[h], HAND_CLASSES[v]);
      C[h * N + v] = compatibleCombos(HAND_CLASSES[h], HAND_CLASSES[v]);
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
// A shoving decision within this EV of indifference is not flipped during
// purification; it is also the regret bound the tests hold the result to.
export const EV_MARGIN_BB = 0.04;

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

const PAIR_ORDER = ['AA', 'KK', 'QQ', 'JJ', 'TT', '99', '88', '77', '66', '55', '44', '33', '22'].map(c => HAND_CLASSES.indexOf(c));
const SUITED_PAIRS = HAND_CLASSES.map((cls, i) => (cls.endsWith('s') ? [i, HAND_CLASSES.indexOf(`${cls.slice(0, 2)}o`)] : null)).filter(Boolean);
function applyDominance(push) {
  let changed = false;
  for (let i = PAIR_ORDER.length - 2; i >= 0; i -= 1) {
    const [higher, lower] = [PAIR_ORDER[i], PAIR_ORDER[i + 1]];
    if (push[higher] < push[lower]) { push[higher] = push[lower]; changed = true; }
  }
  for (const [suited, offsuit] of SUITED_PAIRS) {
    if (push[suited] < push[offsuit]) { push[suited] = push[offsuit]; changed = true; }
  }
  return changed;
}

// Returns { push: Float64Array(169), call: [Float64Array(169) per caller] }.
export function solvePushFold(behind, stackBb, iterations = PUSHFOLD_ITERATIONS) {
  if (!Number.isInteger(behind) || behind < 1 || behind > 8 || !(stackBb > 1)) throw new Error('bad push/fold spot');
  const t = equityTables();
  const posted = postedBlinds(behind);
  const dead = posted.reduce((a, b) => a + b, 0);
  const S = stackBb;
  const need = c => (S - posted[c]) / (2 * S + dead - posted[0] - posted[c]);
  // The shove range is averaged over iterations; the callers always play their
  // exact best response to the current average (a threshold on equity). With
  // several callers this is not a two-player zero-sum game, so averaging both
  // sides does not settle; this one-sided scheme does in practice.
  const callersFor = (pushRange) => Array.from({ length: behind }, (_, i) => {
    const threshold = need(i + 1);
    return Float64Array.from(pushRange, (f, h) => (eqVs(h, pushRange, t) > threshold ? 1 : 0));
  });
  const avgPush = new Float64Array(N).fill(1);
  for (let it = 1; it <= iterations; it += 1) {
    const calls = callersFor(avgPush);
    for (let h = 0; h < N; h += 1) {
      const best = pushEv(h, S, posted, dead, calls, t) > 0 ? 1 : 0;
      avgPush[h] += (best - avgPush[h]) / (it + 1);
    }
  }
  // Purify into mutually consistent final strategies. The shove range starts
  // as the rounded average; callers always take their exact best response to
  // it. A shoving decision that loses more than the margin against those calls
  // is flipped; a hand that would flip back and forth is near-indifferent and
  // is mixed 50/50 instead. Callers are recomputed after every change, so the
  // returned calls are an exact best response to the returned shove range.
  const push = Float64Array.from(avgPush, (f) => (f >= 0.5 ? 1 : 0));
  const flips = new Uint8Array(N);
  let call = callersFor(push);
  for (let round = 0; round < 40; round += 1) {
    let changed = false;
    for (let h = 0; h < N; h += 1) {
      if (push[h] !== 0 && push[h] !== 1) continue;
      const ev = pushEv(h, S, posted, dead, call, t);
      const want = ev > 0 ? 1 : 0;
      if (push[h] === want || Math.abs(ev) <= EV_MARGIN_BB) continue;
      flips[h] += 1;
      push[h] = flips[h] >= 2 ? 0.5 : want;
      changed = true;
    }
    // A dominating hand (the suited version, a higher pair) shoves at least as
    // often as the hand it dominates; noise near the boundary must not invert it.
    changed = applyDominance(push) || changed;
    if (!changed) break;
    call = callersFor(push);
  }
  return { push, call };
}

// Largest regret of a pure action in a returned solution: how much a hand that
// always shoves/folds (or calls/folds) loses against the other side's final
// strategy. Mixed (cycling, near-indifferent) hands are exempt.
export function pushFoldRegret(behind, stackBb, { push, call }) {
  const t = equityTables();
  const posted = postedBlinds(behind);
  const dead = posted.reduce((a, b) => a + b, 0);
  let worst = 0;
  for (let h = 0; h < N; h += 1) {
    const ev = pushEv(h, stackBb, posted, dead, call, t);
    if (push[h] === 1) worst = Math.max(worst, -ev);
    if (push[h] === 0) worst = Math.max(worst, ev);
  }
  for (let c = 1; c <= behind; c += 1) {
    const pot = 2 * stackBb + dead - posted[0] - posted[c];
    for (let h = 0; h < N; h += 1) {
      // Calling EV minus folding EV, in big blinds.
      const ev = eqVs(h, push, t) * pot - (stackBb - posted[c]);
      if (call[c - 1][h] === 1) worst = Math.max(worst, -ev);
      if (call[c - 1][h] === 0) worst = Math.max(worst, ev);
    }
  }
  return worst;
}

