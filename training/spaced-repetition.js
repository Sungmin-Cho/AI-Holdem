const DAY_MS = 86_400_000;

// SR v2 (design D12): integer intervals in [1, 180] days, ease clamped to
// [1.3, 3.0] in every branch, a correct streak, and graduation after four
// correct reviews once the interval reaches 21 days. An off-policy answer
// re-enters a graduated item.
export const SRS_VERSION = 2;
const EASE_MIN = 1.3;
const EASE_MAX = 3.0;
const INTERVAL_MAX = 180;
const GRADUATE_STREAK = 4;
const GRADUATE_INTERVAL = 21;
const clampEase = (ease) => Math.round(Math.min(EASE_MAX, Math.max(EASE_MIN, ease)) * 100) / 100;
const clampInterval = (days) => Math.min(INTERVAL_MAX, Math.max(1, Math.round(days)));

function nextScheduleV2({ grade, intervalDays, ease, lapses, correctStreak, graduatedAt, now }) {
  const interval = clampInterval(intervalDays || 1);
  let next = interval;
  let nextEase = Number.isFinite(ease) ? ease : 2.3;
  let streak = Number.isSafeInteger(correctStreak) ? correctStreak : 0;
  let nextLapses = lapses;
  let graduated = graduatedAt ?? null;
  if (grade === 'preferred') { next = interval * nextEase; nextEase += 0.05; streak += 1; }
  else if (grade === 'mixed') { next = Math.ceil(interval * 1.5); nextEase -= 0.05; streak += 1; }
  else if (grade === 'low-frequency') { next = interval; nextEase -= 0.1; streak = 0; }
  else if (grade === 'off-policy') { next = 1; nextEase -= 0.2; nextLapses = lapses + 1; streak = 0; graduated = null; }
  const intervalOut = clampInterval(next);
  if (!graduated && streak >= GRADUATE_STREAK && intervalOut >= GRADUATE_INTERVAL) graduated = new Date(now).toISOString();
  return {
    intervalDays: intervalOut,
    ease: clampEase(nextEase),
    lapses: nextLapses,
    correctStreak: streak,
    srsVersion: SRS_VERSION,
    graduatedAt: graduated,
    nextReviewAt: new Date(now + intervalOut * DAY_MS).toISOString(),
  };
}

export function nextSchedule({ grade, intervalDays = 1, ease = 2.3, lapses = 0, now = Date.now(), srsVersion, correctStreak, graduatedAt } = {}) {
  if (srsVersion === SRS_VERSION) return nextScheduleV2({ grade, intervalDays, ease, lapses, correctStreak, graduatedAt, now });
  let nextInterval = intervalDays;
  let nextLapses = lapses;
  if (grade === 'preferred') {
    nextInterval = Math.max(1, Math.round(intervalDays * 2));
  } else if (grade === 'mixed') {
    nextInterval = intervalDays;
  } else if (grade === 'off-policy') {
    nextInterval = 1;
    nextLapses = lapses + 1;
  }
  return {
    intervalDays: nextInterval,
    ease,
    lapses: nextLapses,
    nextReviewAt: new Date(now + nextInterval * DAY_MS).toISOString(),
  };
}
