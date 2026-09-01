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
