import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Design D6.5/D7: every place that compares a choice with the reference, reads a
// coverage, infers a source from a key, or names a reference version literally
// is listed here. A new call site fails this test until it is reviewed: v3 must
// compare by action class and check its coverage under its own schema, while
// v1/v2 keep their exact bytes (G7).
function sites(pattern) {
  const out = execFileSync('git', ['grep', '--untracked', '-n', '-F', '-e', pattern, '--', '*.js', ':!test/**'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => line.split(':').slice(0, 1)[0])
    .reduce((counts, file) => ({ ...counts, [file]: (counts[file] ?? 0) + 1 }), {});
}

test('size-matching reference comparisons are only the v1/v2 paths', () => {
  assert.deepEqual(sites('matchReferenceAction('), {
    'shared/reference.js': 2,                // definition, and the v1/v2 branch of matchReferenceActionFor
    'tools/verify-learning-release.js': 2,   // mutation strings of a release check
    'training/decision-evaluator.js': 1,     // the v1 evaluator
  });
  assert.deepEqual(sites('matchReferenceActionFor('), {
    'shared/reference.js': 1,
    'server/drill-public/study-format.js': 1,
    'training/drill-evaluator.js': 1,
    'training/goal.js': 1,                   // the shared practice goal
    'training/profile-aggregator.js': 2,
    'training/study-history.js': 2,          // run questions and game trends
  });
});

test('coverage projections are source-bound', () => {
  assert.deepEqual(sites('projectReferenceCoverage('), {
    'shared/hint-contract.js': 1,       // v2 branch beside the v3 branch
    'shared/reference-coverage.js': 3,  // definition, projectCoverageFor, the v2 eligibility branch
    'training/pre-action-hint.js': 1,   // the v2 hint builder
  });
  assert.deepEqual(sites('projectCoverageFor('), {
    'export/hand-normalizer.js': 1,
    'publish-contract.js': 1,
    'shared/reference-coverage.js': 1,
    'tools/measure-training-coverage.js': 1,
    'training/pre-action-hint.js': 1,
    'training/profile-aggregator.js': 1,
  });
});

test('literal reference versions and key-suffix source inference are inventoried', () => {
  assert.deepEqual(sites("'2.0.0'"), {
    'engine/hint-exposure.js': 1,        // accepted exposure sources (v2, v3)
    'server/drill-public/drill.js': 1,   // key suffix → version (v3, v2, v1)
    'shared/hint-contract.js': 1,        // v2 hint branch
    'shared/reference.js': 2,            // the v2 source and referenceSchemaOf
    'tools/drill-cli.js': 2,             // v2 drill coverage beside the v3 one; chart source by key suffix
    'tools/drill-server.js': 1,          // chart view version allowlist
    'training/policies/contracts.js': 1, // policy predecessor versions (another axis)
    'training/pre-action-hint.js': 1,    // supported hint sources
    'training/providers/preflop-json.js': 1, // the v2 dataset validator
  });
  assert.deepEqual(sites("'3.0.0'"), {
    'engine/hint-exposure.js': 1,
    'server/drill-public/drill.js': 1,
    'shared/hint-contract.js': 1,
    'shared/reference-coverage.js': 2,
    'shared/reference.js': 2,
    'tools/drill-cli.js': 1,
    'tools/drill-server.js': 1,
    'training/pre-action-hint.js': 2,
    'training/policies/contracts.js': 1, // policy version (another axis)
    'tools/build-preflop-baseline-v3.js': 1,
    'training/providers/preflop-json.js': 1,
  });
  assert.deepEqual(sites("endsWith('-v2')"), { 'server/drill-public/drill.js': 1, 'tools/drill-cli.js': 2 });
  assert.deepEqual(sites("endsWith('-v3')"), { 'server/drill-public/drill.js': 1, 'tools/drill-cli.js': 2 });
});
