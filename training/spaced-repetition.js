const DAY_MS = 86_400_000;

export function nextSchedule({ grade, intervalDays = 1, ease = 2.3, lapses = 0, now = Date.now() } = {}) {
  let nextInterval = intervalDays;
  let nextLapses = lapses;
  if (grade === 'preferred') {
    nextInterval = Math.max(1, Math.round(intervalDays * 2));
  } else if (grade === 'mixed') {
    nextInterval = intervalDays;
  } else {
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
