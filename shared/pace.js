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
