import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preflopKeysV3, parsePreflopKeyV3 } from '../shared/preflop-key.js';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { nativePreflopSnapshotV3, practiceKeyExactV3 } from '../training/native-preflop-snapshot-v3.js';
import { projectReferenceCoverageV3 } from '../shared/reference-coverage-v3.js';

const raw = fs.readFileSync(new URL('../training/data/preflop-baseline-v3.json', import.meta.url), 'utf8');
const V3 = parsePreflopJson(raw, { expectedSha256: fs.readFileSync(new URL('../training/data/preflop-baseline-v3.sha256', import.meta.url), 'utf8').trim() });

const answerFor = (key) => {
  const { context, stackBb } = parsePreflopKeyV3(key);
  if (context === 'push') return { action: 'raise', sizeBb: stackBb };
  if (context === 'vs-shove') return { action: 'call' };
  if (context === 'rfi-unopened') return { action: 'raise', sizeBb: 2.5 };
  if (context === 'vs-single-raise') return { action: 'raise', sizeBb: 8 };
  return { action: 'raise', sizeBb: 22 };
};

test('every v3 key synthesizes a table whose coverage is that spot, exact where the model covers it', () => {
  let exact = 0;
  for (const key of preflopKeysV3()) {
    const snapshot = nativePreflopSnapshotV3(key, 'AA', answerFor(key));
    const evaluation = evaluatePreflopReferenceV3(snapshot, V3, { gameEpoch: 'ab'.repeat(32) });
    assert.equal(evaluation.coverage.derived.spotKey, key, key);
    if (practiceKeyExactV3(key)) {
      exact += 1;
      assert.equal(evaluation.coverage.referenceMatch, 'exact', key);
      assert.equal(evaluation.coverage.metricEligible, true, key);
    } else {
      assert.deepEqual(evaluation.coverage.reasonCodes, ['PUSHFOLD_PROJECTED'], key);
    }
    assert.equal(evaluation.coverage.choiceMatch, 'exact', key);
    assert.equal(evaluation.status, 'supported', `${key}: ${evaluation.code}`);
    assert.deepEqual(projectReferenceCoverageV3(evaluation.coverage), evaluation.coverage);
  }
  assert.ok(exact > 1000, `${exact} exact practice keys`);
});

test('a fold answer and an unreachable opener are carried as the evaluator reports them', () => {
  const fold = evaluatePreflopReferenceV3(nativePreflopSnapshotV3('6max-100bb-btn-rfi-v3', '72o', { action: 'fold' }), V3, { gameEpoch: 'ab'.repeat(32) });
  assert.equal(fold.grade, 'preferred');
  const unreachable = evaluatePreflopReferenceV3(nativePreflopSnapshotV3('6max-100bb-utg-vs-btn-3bet-v3', '72o', { action: 'fold' }), V3, { gameEpoch: 'ab'.repeat(32) });
  assert.equal(unreachable.code, 'OPENER_RANGE_UNREACHABLE');
  assert.throws(() => nativePreflopSnapshotV3('6max-100bb-btn-rfi-v2', 'AA'), /Invalid native practice context/);
  assert.throws(() => nativePreflopSnapshotV3('6max-100bb-btn-rfi-v3', 'XX'), /Invalid native practice context/);
});
