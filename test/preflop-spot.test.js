import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreflopSpot, trainingPosition } from '../training/preflop-spot.js';

function sixSeats() {
  return ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
    playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
  }));
}

test('engine 6max UTG+1 → HJ, HU BTN/SB → BTN', () => {
  assert.equal(trainingPosition('UTG+1', { seated: 6 }), 'HJ');
  assert.equal(trainingPosition('BTN/SB', { seated: 2 }), 'BTN');
});

function baseSpot(over = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Kd'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: sixSeats(),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
    ...over,
  };
}

test('RFI unopened and vs-single-raise keys; multiway/size/stack rejected', () => {
  const base = baseSpot();
  const rfi = normalizePreflopSpot(base);
  assert.equal(rfi.ok, true);
  assert.equal(rfi.spotKey, '6max-100bb-btn-rfi-unopened');

  const vs = normalizePreflopSpot({
    ...base,
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 250 }],
    chosenAction: { action: 'raise', amount: 850 },
  });
  assert.equal(vs.ok, true);
  assert.equal(vs.spotKey, '6max-100bb-bb-vs-single-raise');

  assert.equal(normalizePreflopSpot({ ...base, chosenAction: { action: 'raise', amount: 400 } }).code, 'UNSUPPORTED_SIZE');
  assert.equal(normalizePreflopSpot({ ...base, effectiveStack: 5000 }).code, 'UNSUPPORTED_STACK');
  assert.equal(normalizePreflopSpot({ ...base, publicSeats: sixSeats().slice(0, 5) }).code, 'UNSUPPORTED_SPOT');
  assert.equal(normalizePreflopSpot({
    ...base,
    priorActions: [{ action: 'raise', amount: 250 }, { action: 'raise', amount: 850 }],
  }).code, 'UNSUPPORTED_SPOT');
});

test('prior call (limp or cold-call) is UNSUPPORTED_SPOT', () => {
  assert.equal(normalizePreflopSpot(baseSpot({
    priorActions: [{ action: 'call', amount: 100 }],
    chosenAction: { action: 'raise', amount: 250 },
  })).code, 'UNSUPPORTED_SPOT');
  assert.equal(normalizePreflopSpot(baseSpot({
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 250 }, { action: 'call', amount: 250 }],
    chosenAction: { action: 'fold' },
  })).code, 'UNSUPPORTED_SPOT');
});

test('facing size is prior raise amount, independent of hero fold/call', () => {
  assert.equal(normalizePreflopSpot(baseSpot({
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 500 }],
    chosenAction: { action: 'fold' },
  })).code, 'UNSUPPORTED_SIZE');
  const foldVs25 = normalizePreflopSpot(baseSpot({
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 250 }],
    chosenAction: { action: 'fold' },
  }));
  assert.equal(foldVs25.ok, true);
  const callVs25 = normalizePreflopSpot(baseSpot({
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 250 }],
    chosenAction: { action: 'call', amount: 250 },
  }));
  assert.equal(callVs25.ok, true);
});

test('hero 10bb 3bet vs 2.5bb open is UNSUPPORTED_SIZE', () => {
  assert.equal(normalizePreflopSpot(baseSpot({
    position: 'BB',
    priorActions: [{ action: 'raise', amount: 250 }],
    chosenAction: { action: 'raise', amount: 1000 },
  })).code, 'UNSUPPORTED_SIZE');
});

test('NaN or non-finite stack is UNSUPPORTED_STACK', () => {
  assert.equal(normalizePreflopSpot(baseSpot({ effectiveStack: Number.NaN })).code, 'UNSUPPORTED_STACK');
});

test('6-max engine labels map to training positions', () => {
  assert.equal(trainingPosition('UTG', { seated: 6 }), 'UTG');
  assert.equal(trainingPosition('UTG+1', { seated: 6 }), 'HJ');
  assert.equal(trainingPosition('HJ', { seated: 6 }), 'HJ');
  assert.equal(trainingPosition('CO', { seated: 6 }), 'CO');
  assert.equal(trainingPosition('BTN', { seated: 6 }), 'BTN');
  assert.equal(trainingPosition('SB', { seated: 6 }), 'SB');
  assert.equal(trainingPosition('BB', { seated: 6 }), 'BB');
});
