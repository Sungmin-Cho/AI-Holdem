import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSchedule, SRS_VERSION } from '../training/spaced-repetition.js';

const NOW = Date.UTC(2026, 9, 7);
const v2 = (state) => nextSchedule({ srsVersion: SRS_VERSION, now: NOW, intervalDays: 1, ease: 2.3, lapses: 0, correctStreak: 0, ...state });

test('SR v2 follows the design table with integer intervals and clamped ease', () => {
  assert.deepEqual(v2({ grade: 'preferred', intervalDays: 10 }), { intervalDays: 23, ease: 2.35, lapses: 0, correctStreak: 1,
    srsVersion: 2, graduatedAt: null, nextReviewAt: new Date(NOW + 23 * 86_400_000).toISOString() });
  const mixed = v2({ grade: 'mixed', intervalDays: 3, correctStreak: 2 });
  assert.deepEqual([mixed.intervalDays, mixed.ease, mixed.correctStreak], [5, 2.25, 3]);
  const low = v2({ grade: 'low-frequency', intervalDays: 6, correctStreak: 3 });
  assert.deepEqual([low.intervalDays, low.ease, low.correctStreak], [6, 2.2, 0]);
  const off = v2({ grade: 'off-policy', intervalDays: 40, lapses: 2, correctStreak: 5, graduatedAt: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual([off.intervalDays, off.ease, off.lapses, off.correctStreak, off.graduatedAt], [1, 2.1, 3, 0, null]);
  assert.equal(v2({ grade: 'off-policy', ease: 1.35 }).ease, 1.3, 'ease never drops below 1.3');
  assert.equal(v2({ grade: 'preferred', ease: 2.99 }).ease, 3, 'ease never exceeds 3.0');
  assert.equal(v2({ grade: 'preferred', intervalDays: 150, ease: 3 }).intervalDays, 180, 'interval is capped at 180 days');
  for (const grade of ['preferred', 'mixed', 'low-frequency', 'off-policy']) assert.ok(Number.isSafeInteger(v2({ grade, intervalDays: 7, ease: 2.17 }).intervalDays));
});

test('an item graduates after four correct reviews at 21 days and re-enters on a miss', () => {
  const graduated = v2({ grade: 'preferred', intervalDays: 10, correctStreak: 3 });
  assert.equal(graduated.correctStreak, 4);
  assert.equal(graduated.intervalDays >= 21, true);
  assert.equal(graduated.graduatedAt, new Date(NOW).toISOString());
  const early = v2({ grade: 'preferred', intervalDays: 2, correctStreak: 5 });
  assert.equal(early.graduatedAt, null, 'a short interval does not graduate yet');
  assert.equal(v2({ grade: 'mixed', intervalDays: 30, correctStreak: 6, graduatedAt: graduated.graduatedAt }).graduatedAt, graduated.graduatedAt);
});

test('without srsVersion the v1 schedule is unchanged', () => {
  assert.deepEqual(nextSchedule({ grade: 'preferred', intervalDays: 3, ease: 2.3, lapses: 1, now: NOW }),
    { intervalDays: 6, ease: 2.3, lapses: 1, nextReviewAt: new Date(NOW + 6 * 86_400_000).toISOString() });
  assert.deepEqual(nextSchedule({ grade: 'mixed', intervalDays: 3, ease: 2.3, lapses: 1, now: NOW }).intervalDays, 3);
});
