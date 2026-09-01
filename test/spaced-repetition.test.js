import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSchedule } from '../training/spaced-repetition.js';

test('frequency grades map to interval increase / hold / reset+lapse', () => {
  const base = { intervalDays: 4, ease: 2.3, lapses: 0, now: Date.parse('2026-09-01T00:00:00Z') };
  const preferred = nextSchedule({ ...base, grade: 'preferred' });
  assert.equal(preferred.intervalDays, 8);
  assert.equal(preferred.lapses, 0);

  const mixed = nextSchedule({ ...base, grade: 'mixed' });
  assert.equal(mixed.intervalDays, 4);

  const off = nextSchedule({ ...base, grade: 'off-policy' });
  assert.equal(off.intervalDays, 1);
  assert.equal(off.lapses, 1);

  const low = nextSchedule({ ...base, grade: 'low-frequency' });
  assert.equal(low.intervalDays, 1);
  assert.equal(low.lapses, 1);
});
