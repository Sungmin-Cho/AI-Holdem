// #298: 학습 효과 프로토콜 v1의 봉인과 지표 계산(문항 객체 위의 순수 함수).
// 여기의 합성 문항·짝은 계산 규칙의 검증이다. 사용자 학습 효과의 증거가 아니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNING_EFFECT_PROTOCOL_V1, PROTOCOL_SHA256, canonicalJson, m1Of, m2Of, pairedDifference, patternOf, sealHash, sealPlan,
  standardizedDifference, verdictOf,
} from '../training/learning-effect.js';

const close = (actual, expected, eps = 1e-4) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

// 문항 n개, 그중 x개 일치. 셀 = (foldAllowed, allowedCount, legalCount).
function items(n, x, cell = [true, 1, 2]) {
  const [foldAllowed, allowedCount, legalCount] = cell;
  return Array.from({ length: n }, (_, i) => ({ allowed: i < x, foldAllowed, allowedCount, legalCount }));
}

test('the protocol and a plan are sealed by canonical SHA-256; any change moves the seal', () => {
  assert.equal(PROTOCOL_SHA256, sealHash(LEARNING_EFFECT_PROTOCOL_V1));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.ok(Object.isFrozen(LEARNING_EFFECT_PROTOCOL_V1.thresholds));
  const at = '2026-10-21T00:00:00.000Z';
  const sealed = sealPlan({}, at);
  assert.deepEqual(sealed.plan, { baselineRuns: 3, interventionDays: 7, postDays: 7 });
  assert.equal(sealed.postOpensAt, '2026-10-28T00:00:00.000Z');
  assert.equal(sealed.postClosesAt, '2026-11-04T00:00:00.000Z');
  for (const change of [{ baselineRuns: 4 }, { interventionDays: 8 }, { postDays: 8 }]) {
    assert.notEqual(sealPlan(change, at).planSha256, sealed.planSha256, JSON.stringify(change));
  }
  assert.notEqual(sealPlan({}, '2026-10-21T00:00:00.001Z').planSha256, sealed.planSha256);
  for (const bad of [{ baselineRuns: 1 }, { baselineRuns: 6 }, { interventionDays: 0 }, { postDays: 2 }, { postDays: 15 }, { baselineRuns: 2.5 }]) {
    assert.throws(() => sealPlan(bad, at), { code: 'BAD_PLAN' }, JSON.stringify(bad));
  }
  assert.throws(() => sealPlan({}, '2026-10-21'), { code: 'BAD_PLAN' });
});

test('Agresti–Caffo per cell and Agresti–Min Wald+2 match hand calculations', () => {
  // 한 셀: 기준 10/20, 사후 15/20. p̃1 = 11/22, p̃2 = 16/22.
  const one = standardizedDifference([{ w: 1, x1: 10, n1: 20, x2: 15, n2: 20 }]);
  close(one.raw, 0.25);
  close(one.center, 16 / 22 - 11 / 22);
  const se = Math.sqrt((0.5 * 0.5) / 22 + ((16 / 22) * (6 / 22)) / 22);
  close(one.se, se);
  close(one.ci[0], 5 / 22 - 1.96 * se);
  close(one.ci[1], 5 / 22 + 1.96 * se);
  // 짝: n01 = 15, n10 = 0, n = 30. 네 칸에 0.5 → n′ = 32.
  const paired = pairedDifference({ n01: 15, n10: 0, n: 30 });
  close(paired.raw, 0.5);
  close(paired.center, 15.5 / 32 - 0.5 / 32);
  close(paired.se, Math.sqrt((16 / 32 - (15 / 32) ** 2) / 32));
  // 불일치 0: 중심 0, 구간은 0을 중심으로 좌우 대칭이고 0이 아니다.
  const none = pairedDifference({ n01: 0, n10: 0, n: 10 });
  close(none.center, 0);
  close(none.ci[1], -none.ci[0]);
  assert.ok(none.se > 0);
  // 한 방향 불일치만.
  close(pairedDifference({ n01: 0, n10: 7, n: 7 }).raw, -1);
});

test('verdicts use the raw difference for size and the adjusted interval for uncertainty', () => {
  assert.equal(verdictOf(0.2, [0.01, 0.4]), 'IMPROVED');
  assert.equal(verdictOf(0.14, [0.01, 0.3]), 'INCONCLUSIVE', 'significant but below the minimum meaningful change');
  assert.equal(verdictOf(-0.2, [-0.4, -0.01]), 'DECLINED');
  assert.equal(verdictOf(0.0, [-0.1, 0.1]), 'NO_MEANINGFUL_CHANGE');
  assert.equal(verdictOf(0.0, [-0.2, 0.2]), 'INCONCLUSIVE');
  assert.equal(verdictOf(0.3, [-0.01, 0.6]), 'INCONCLUSIVE');
});

test('M1: no change is NO_MEANINGFUL_CHANGE with a large sample and INCONCLUSIVE with the default sample', () => {
  const large = m1Of(items(600, 300), items(600, 300));
  assert.equal(large.raw, 0);
  assert.equal(large.verdict, 'NO_MEANINGFUL_CHANGE');
  const small = m1Of(items(30, 15), items(30, 15));
  assert.equal(small.raw, 0);
  assert.equal(small.verdict, 'INCONCLUSIVE');
});

test('M1: a real improvement on matched cells is IMPROVED', () => {
  const report = m1Of(items(30, 12), items(30, 27));
  close(report.raw, 0.5);
  assert.ok(report.ci[0] > 0);
  assert.equal(report.verdict, 'IMPROVED');
  assert.deepEqual(report.rawRate, { baseline: 0.4, post: 0.9 });
});

test('M1 negative control: an unchanged always-fold policy on an easier post set is not an improvement', () => {
  const foldOk = [true, 1, 2];
  const foldBad = [false, 1, 2];
  // 항상 fold → fold가 허용된 셀은 전부 일치, 아닌 셀은 전부 불일치.
  const baseline = [...items(6, 6, foldOk), ...items(24, 0, foldBad)];
  const post = [...items(24, 24, foldOk), ...items(6, 0, foldBad)];
  const report = m1Of(baseline, post);
  assert.deepEqual(report.rawRate, { baseline: 0.2, post: 0.8 }, 'the unstandardized rate jumps by 60 points');
  assert.equal(report.raw, 0, 'the standardized raw difference is exactly zero');
  assert.notEqual(report.verdict, 'IMPROVED');
  // astra r2 반례: 1:29 대 29:1 — 보정 중심은 0이 아니지만 원자료 차이는 0이고 개선이 아니다.
  const extreme = m1Of([...items(1, 1, foldOk), ...items(29, 0, foldBad)], [...items(29, 29, foldOk), ...items(1, 0, foldBad)]);
  assert.equal(extreme.raw, 0);
  assert.ok(Math.abs(extreme.center) > 0.15, 'the adjusted center alone would have suggested a change');
  assert.notEqual(extreme.verdict, 'IMPROVED');
});

test('M1 negative control: an unchanged uniform-random legal policy keeps a zero standardized difference across shifted cells', () => {
  // 합법 행동 무작위의 기대 일치율 = allowedCount / legalCount. 셀마다 그 비율로 정확히 맞춘 결정적 자료.
  const cells = [[[true, 1, 2], 0.5], [[false, 1, 3], 1 / 3], [[true, 2, 3], 2 / 3]];
  const set = (sizes) => cells.flatMap(([cell, p], i) => items(sizes[i], Math.round(sizes[i] * p), cell));
  const report = m1Of(set([12, 6, 12]), set([6, 18, 6]));
  assert.equal(report.raw, 0);
  assert.notEqual(report.verdict, 'IMPROVED');
});

test('M1: a missing-cell mass above 0.2 is NON_COMPARABLE; at 0.2 the common cells are renormalized', () => {
  const a = [true, 1, 2];
  const b = [false, 2, 3];
  const over = m1Of([...items(23, 10, a), ...items(7, 3, b)], items(30, 15, a));
  close(over.missingMass, 7 / 30);
  assert.equal(over.verdict, 'NON_COMPARABLE');
  assert.equal(over.reason, 'DISTRIBUTION_MISMATCH');
  const edge = m1Of([...items(24, 12, a), ...items(6, 3, b)], items(30, 15, a));
  close(edge.missingMass, 0.2);
  assert.equal(edge.renormalized, true);
  assert.equal(edge.nBaseCommon, 24);
  assert.notEqual(edge.verdict, 'NON_COMPARABLE');
});

test('M1: the 20-item floor is checked after exclusions and renormalization; incomplete slots stop the verdict', () => {
  assert.equal(m1Of(items(19, 9), items(30, 15)).reason, 'TOO_FEW_CLEAN_ITEMS');
  assert.notEqual(m1Of(items(20, 10), items(20, 10)).verdict, 'INSUFFICIENT');
  const a = [true, 1, 2];
  const b = [false, 2, 3];
  // 공통 셀만 남기면 기준이 19개다.
  assert.equal(m1Of([...items(19, 9, a), ...items(4, 2, b)], items(30, 15, a)).reason, 'TOO_FEW_CLEAN_ITEMS');
  const partial = m1Of(items(30, 12), items(30, 27), { slotsComplete: false });
  assert.equal(partial.verdict, 'INSUFFICIENT');
  assert.equal(partial.reason, 'INCOMPLETE_SLOTS');
  assert.deepEqual(partial.rawRate, { baseline: 0.4, post: 0.9 }, 'partial data stays descriptive');
});

test('M2 and the memorization pattern', () => {
  const improved = m2Of({ table: { n11: 10, n10: 0, n01: 15, n00: 5 } });
  assert.equal(improved.n, 30);
  close(improved.raw, 0.5);
  assert.equal(improved.verdict, 'IMPROVED');
  // 같은 문항만 좋아지고 새 문항은 그대로: 반복 암기만.
  const transfer = m1Of(items(30, 12), items(30, 12));
  assert.equal(transfer.verdict, 'INCONCLUSIVE');
  assert.equal(patternOf(transfer, improved), 'retention-without-transfer');
  assert.equal(patternOf(m1Of(items(30, 12), items(30, 27)), improved), null);
  assert.equal(patternOf(m1Of(items(5, 2), items(5, 2)), improved), 'transfer-not-evaluable', 'no transfer claim when transfer cannot be judged');
  assert.equal(m2Of({ table: { n11: 4, n10: 1, n01: 3, n00: 1 } }).reason, 'TOO_FEW_CLEAN_PAIRS');
  assert.equal(m2Of({ table: { n11: 10, n10: 0, n01: 15, n00: 5 } }, { slotsComplete: false }).reason, 'INCOMPLETE_SLOTS');
  const delays = m2Of({ table: { n11: 10, n10: 0, n01: 0, n00: 0 }, delays: [30, 24.5, 48] }).delayHours;
  assert.deepEqual(delays, { n: 3, min: 24.5, median: 30, max: 48 });
});
