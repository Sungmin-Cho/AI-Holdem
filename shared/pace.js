export const PACE_PRESETS = Object.freeze({
  instant: Object.freeze({ handResultDwellMs: 0, aiActionIntervalMs: 0, runoutStepMs: 0 }),
  fast: Object.freeze({ handResultDwellMs: 1500, aiActionIntervalMs: 300, runoutStepMs: 400 }),
  normal: Object.freeze({ handResultDwellMs: 3500, aiActionIntervalMs: 700, runoutStepMs: 800 }),
  slow: Object.freeze({ handResultDwellMs: 6000, aiActionIntervalMs: 1200, runoutStepMs: 1200 }),
});

export function paceFor(setup) {
  const pace = setup?.pace ?? 'instant';
  if (!Object.hasOwn(PACE_PRESETS, pace)) throw new Error('INVALID_PACE');
  return PACE_PRESETS[pace];
}

export const RESULT_HOLD_MAX_SEC = 30;
export const validResultHoldSec = (value) => Number.isSafeInteger(value) && value >= 0 && value <= RESULT_HOLD_MAX_SEC;

/** How long a finished hand's result stays before the next hand. A setup that
 * names `resultHoldSec` decides it apart from the AI pace; older setups keep
 * the pace preset's dwell. The runout steps still follow the pace. */
export function resultHoldMsFor(setup) {
  if (setup?.resultHoldSec === undefined) return paceFor(setup).handResultDwellMs;
  if (!validResultHoldSec(setup.resultHoldSec)) throw new Error('INVALID_RESULT_HOLD');
  return setup.resultHoldSec * 1000;
}
