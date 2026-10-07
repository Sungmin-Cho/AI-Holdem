import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { nativePreflopSnapshotV3 } from '../training/native-preflop-snapshot-v3.js';
import { referenceAssessmentEligibilityV3, matchReferenceActionV3, V3_TREE } from '../shared/reference-coverage-v3.js';
import { SIZES_V3 } from '../training/ranges/charts-v3.js';

const raw = fs.readFileSync(new URL('../training/data/preflop-baseline-v3.json', import.meta.url), 'utf8');
const V3 = parsePreflopJson(raw, { expectedSha256: fs.readFileSync(new URL('../training/data/preflop-baseline-v3.sha256', import.meta.url), 'utf8').trim() });
const source = { id: V3.data.id, version: V3.data.version, contentSha256: V3.contentSha256 };
const evaluate = (key, hand, answer) => evaluatePreflopReferenceV3(nativePreflopSnapshotV3(key, hand, answer), V3, { gameEpoch: 'ab'.repeat(32) });

test('the tree sizes the validator assumes are the dataset\'s and the builder\'s', () => {
  assert.equal(V3_TREE.openBb, V3.data.tree.openBb);
  assert.equal(V3_TREE.threeBetBb, V3.data.tree.threeBetBb);
  assert.equal(V3_TREE.fourBetBb, V3.data.tree.fourBetBb);
  assert.deepEqual({ ...V3_TREE }, { ...SIZES_V3 });
});

test('genuine v3 evaluations are eligible in every context, a raise off the tree size still matches by class', () => {
  for (const [key, hand, answer] of [
    ['6max-100bb-btn-rfi-v3', 'AKo', { action: 'raise', sizeBb: 3 }],
    ['6max-100bb-bb-vs-btn-open-v3', 'Q8o', { action: 'call' }],
    ['6max-100bb-co-vs-btn-3bet-v3', 'AA', { action: 'raise', sizeBb: 22 }],
    ['6max-10bb-btn-push-v3', 'AJo', { action: 'raise', sizeBb: 10 }],
    ['6max-8bb-bb-vs-sb-shove-v3', 'A2o', { action: 'call' }],
  ]) {
    const e = evaluate(key, hand, answer);
    assert.equal(e.coverage.metricEligible, true, key);
    assert.ok(e.grade, key);
    assert.deepEqual(referenceAssessmentEligibilityV3(e, source), { verified: true, referenceAvailable: true, metricEligible: true, reason: null }, key);
    assert.equal(matchReferenceActionV3(e.recommended, e.chosen)?.action, answer.action, key);
  }
});

test('forged grades, rows, choices and spot keys are rejected; ineligible rows carry no grade', () => {
  const e = evaluate('6max-100bb-btn-rfi-v3', 'AKo', { action: 'raise', sizeBb: 2.5 });
  const bad = (mutate) => {
    const copy = structuredClone(e);
    mutate(copy);
    return referenceAssessmentEligibilityV3(copy, source).reason;
  };
  assert.equal(bad((c) => { c.grade = 'off-policy'; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.recommended.find((r) => r.action === 'raise').sizeBb = 3; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.recommended.push({ action: 'call', frequency: 0.01, evBb: null }); }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.chosen.sizeBb = 2.6; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.chosen.action = 'fold'; delete c.chosen.sizeBb; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.spotKey = '6max-100bb-co-rfi-v3'; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { c.coverage.metricEligible = false; }), 'REFERENCE_COVERAGE_INVALID');
  assert.equal(bad((c) => { delete c.coverage; }), 'REFERENCE_COVERAGE_INVALID');
  // Out of the choice band: compared nowhere, and a grade would be forged.
  const wide = evaluate('6max-100bb-btn-rfi-v3', 'AKo', { action: 'raise', sizeBb: 5 });
  assert.equal(wide.grade, null);
  assert.deepEqual(referenceAssessmentEligibilityV3(wide, source), { verified: true, referenceAvailable: true, metricEligible: false, reason: null });
  assert.equal(referenceAssessmentEligibilityV3({ ...wide, grade: 'preferred' }, source).reason, 'REFERENCE_COVERAGE_INVALID');
});

test('a mix observation is checked against its own source and coverage', () => {
  const e = evaluate('6max-100bb-bb-vs-btn-open-v3', 'Q8o', { action: 'call' });
  const event = {
    status: 'supported', forced: false, grade: e.grade, coverage: e.coverage,
    mixObservation: { spotKey: e.spotKey, handClass: e.handClass, referenceActions: e.recommended,
      chosenAction: { action: 'call', frequency: e.chosen.frequency }, sourceIdentity: source },
  };
  assert.equal(referenceAssessmentEligibilityV3(event, source).metricEligible, true);
  const other = { ...source, contentSha256: '00'.repeat(32) };
  assert.equal(referenceAssessmentEligibilityV3({ ...event, mixObservation: { ...event.mixObservation, sourceIdentity: other } }, source).verified, false);
});
