// Estimated opponent ranges from public preflop actions, using the v3 charts.
// Only the first preflop action category of each opponent is used (opened,
// 3-bet, called an open, shoved short); anything else stays "any two cards".
// It is an estimate for teaching equity, stated as such wherever it is shown.
import { PREFLOP_ORDERS_V3, trainingPositionV3 } from '../../shared/preflop-key.js';
import { HAND_CLASSES } from '../../shared/poker-eval.js';
import { pushChart, rfiRange, vsOpenChart } from './charts-v3.js';

const asRange = (freq) => {
  const out = {};
  for (let i = 0; i < freq.length; i += 1) if (freq[i] > 0) out[HAND_CLASSES[i]] = freq[i];
  return Object.keys(out).length ? out : null;
};

function nearestStack(stackBb) {
  const buckets = [3, 4, 5, 6, 7, 8, 10, 12, 15];
  return buckets.reduce((best, s) => (Math.abs(s - stackBb) < Math.abs(best - stackBb) ? s : best), buckets[0]);
}

// Returns { [playerId]: {class: freq} | null } for every live opponent.
export function estimateOpponentRanges(snapshot) {
  const live = (snapshot.publicSeats ?? []).filter((seat) => !seat.out);
  const seated = live.length;
  const order = PREFLOP_ORDERS_V3[seated];
  const bb = snapshot.blinds?.[1];
  const ranges = {};
  const opponents = live.filter((seat) => seat.playerId !== snapshot.actorId && !seat.folded);
  const preflop = (snapshot.priorActions ?? []).filter((a) => (a.street ?? 'preflop') === 'preflop');
  const positionOf = (pid) => trainingPositionV3(live.find((seat) => seat.playerId === pid)?.position, seated);
  for (const seat of opponents) {
    ranges[seat.playerId] = null;
    if (!order || !bb) continue;
    const mine = preflop.findIndex((a) => a.playerId === seat.playerId);
    if (mine < 0) continue;
    const action = preflop[mine];
    const before = preflop.slice(0, mine);
    const raisesBefore = before.filter((a) => a.action === 'raise');
    const pos = positionOf(seat.playerId);
    if (!pos) continue;
    try {
      if (action.action === 'raise' && raisesBefore.length === 0) {
        // An open for the whole stack (raise-to equals the record's maximum) is a shove.
        const shove = Number.isInteger(action.maxRaiseTo) && action.amount === action.maxRaiseTo;
        ranges[seat.playerId] = shove && action.maxRaiseTo / bb <= 15.5
          ? asRange(pushChart(seated, pos, nearestStack(action.maxRaiseTo / bb)).raise)
          : asRange(rfiRange(seated, pos));
      } else if (raisesBefore.length === 1) {
        const opener = positionOf(raisesBefore[0].playerId);
        if (opener && order.indexOf(opener) < order.indexOf(pos)) {
          const chart = vsOpenChart(seated, pos, opener);
          ranges[seat.playerId] = asRange(action.action === 'raise' ? chart.raise : action.action === 'call' ? chart.call : []);
        }
      }
    } catch {
      ranges[seat.playerId] = null;
    }
  }
  return ranges;
}
