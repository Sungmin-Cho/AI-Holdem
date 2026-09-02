import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLeaks } from '../training/leak-detector.js';
import { masteryOf } from '../training/mastery.js';

test('small samples are low confidence; leaks keep components', () => {
  assert.ok(masteryOf({ preferredActionRate: 0.9, opportunities: 3 }) < masteryOf({ preferredActionRate: 0.9, opportunities: 40 }));
  const leaks = detectLeaks({
    'preflop.bbDefense.vsRaise': {
      opportunities: 31,
      supported: 29,
      preferredActionRate: 0.62,
      evLossBb: null,
      confidence: 1,
    },
    'preflop.rfi.BTN': {
      opportunities: 3,
      supported: 3,
      preferredActionRate: 0.3,
      evLossBb: null,
      confidence: 0.15,
    },
  });
  assert.equal(leaks[0].id, 'preflop.bbDefense.vsRaise');
  assert.equal(typeof leaks[0].severity, 'number');
  assert.equal(leaks[0].opportunities, 31);
  assert.equal(leaks.find((row) => row.id === 'preflop.rfi.BTN').note, 'small-sample');
});

test('unsupported-only skills are absent from leaks and present in coverageGaps', () => {
  const result = detectLeaks({
    'preflop.other.UTG': {
      opportunities: 10,
      supported: 0,
      preferredActionRate: 0,
      evLossBb: null,
      confidence: 0.5,
    },
    'preflop.rfi.BTN': {
      opportunities: 5,
      supported: 5,
      preferredActionRate: 0.5,
      evLossBb: null,
      confidence: 1,
    },
  });
  const leaks = result.leaks ?? result;
  const gaps = result.coverageGaps ?? [];
  assert.equal(leaks.some((row) => row.id === 'preflop.other.UTG'), false);
  assert.equal(gaps.some((row) => row.id === 'preflop.other.UTG'), true);
  assert.equal(leaks[0].id, 'preflop.rfi.BTN');
});
