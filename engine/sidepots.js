import { compareScore } from './evaluator.js';

export function buildPots(contribs, folded) {
  const levels = [...new Set([...contribs.values()].filter((value) => value > 0))]
    .sort((a, b) => a - b);
  const pots = [];
  let previousLevel = 0;

  for (const level of levels) {
    let amount = 0;
    const eligible = [];

    for (const [pid, contribution] of contribs) {
      amount += Math.max(0, Math.min(contribution, level) - previousLevel);
      if (contribution >= level && !folded.has(pid)) eligible.push(pid);
    }

    if (amount > 0) {
      const last = pots.at(-1);
      const sameEligible = last
        && last.eligible.length === eligible.length
        && last.eligible.every((pid) => eligible.includes(pid));
      if (sameEligible) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    previousLevel = level;
  }

  return pots;
}

export function awardPots(pots, scores, oddChipOrder) {
  const payouts = new Map();

  for (const pot of pots) {
    if (pot.eligible.length === 0) continue;

    let bestScore = scores.get(pot.eligible[0]);
    for (const pid of pot.eligible.slice(1)) {
      const score = scores.get(pid);
      if (compareScore(score, bestScore) > 0) bestScore = score;
    }

    const winners = pot.eligible.filter((pid) => (
      compareScore(scores.get(pid), bestScore) === 0
    ));
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount % winners.length;

    for (const pid of winners) payouts.set(pid, (payouts.get(pid) || 0) + share);

    const winnerSet = new Set(winners);
    const orderedWinners = [];
    for (const pid of oddChipOrder) {
      if (winnerSet.has(pid) && !orderedWinners.includes(pid)) orderedWinners.push(pid);
    }
    for (const pid of winners) {
      if (!orderedWinners.includes(pid)) orderedWinners.push(pid);
    }
    for (const pid of orderedWinners) {
      if (remainder === 0) break;
      payouts.set(pid, payouts.get(pid) + 1);
      remainder -= 1;
    }
  }

  return payouts;
}
