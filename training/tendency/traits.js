import { TENDENCY_MIN_N, rateOf } from './contracts.js';

export const CALIBRATION = Object.freeze({
  a0: 1.461,
  a1: 1.919,
  b1: 0.42,
  b2: 0.42,
  c0: 0.10,
  c1: 0.90,
  clampLow: 0.05,
  clampHigh: 0.95,
  baseline: Object.freeze({
    tightness: 0.52,
    aggression: 0.52,
    calling: 0.42,
    bluff: 0.14,
  }),
});

function clamp(value) {
  return Math.min(CALIBRATION.clampHigh, Math.max(CALIBRATION.clampLow, value));
}

export function traitsFromTendency(t) {
  const baseline = CALIBRATION.baseline;
  const vpip = t?.preflop?.vpip;
  const tightness = !vpip || vpip.n < TENDENCY_MIN_N
    ? baseline.tightness
    : clamp(CALIBRATION.a0 - CALIBRATION.a1 * rateOf(vpip));

  const pfr = t?.preflop?.pfr;
  const af = t?.postflop?.af ?? { bets: 0, raises: 0, calls: 0 };
  const afN = (af.bets ?? 0) + (af.raises ?? 0) + (af.calls ?? 0);
  let aggression = baseline.aggression;
  if (
    vpip && vpip.n >= TENDENCY_MIN_N && vpip.k > 0
    && pfr && pfr.n >= TENDENCY_MIN_N
    && afN >= TENDENCY_MIN_N
  ) {
    const ratio = rateOf(pfr) / rateOf(vpip);
    const afValue = (af.bets + af.raises) / Math.max(1, af.calls);
    aggression = clamp(CALIBRATION.b1 * ratio + CALIBRATION.b2 * Math.min(1, afValue / 3));
  }

  let facingN = 0;
  let facingCall = 0;
  for (const street of ['flop', 'turn', 'river']) {
    const block = t?.postflop?.byStreet?.[street]?.facingBet;
    if (!block) continue;
    facingN += block.n ?? 0;
    facingCall += block.call ?? 0;
  }
  const calling = facingN < TENDENCY_MIN_N
    ? baseline.calling
    : clamp(CALIBRATION.c0 + CALIBRATION.c1 * (facingCall / facingN));

  const bluffCounter = t?.postflop?.bluff;
  const bluff = !bluffCounter || bluffCounter.n < TENDENCY_MIN_N
    ? baseline.bluff
    : clamp(rateOf(bluffCounter));

  return { tightness, aggression, calling, bluff };
}
