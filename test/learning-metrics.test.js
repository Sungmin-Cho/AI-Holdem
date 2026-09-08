import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyProfile } from '../training/profile-aggregator.js';

test('REQ-003: positive-frequency choices stay allowed', async (t) => {
  const canonicalSource = {
    id: 'local-preflop-baseline',
    version: '1.0.0',
    contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
  };
  const referenceActions = [
    { action: 'raise', sizeBb: 2.5, frequency: 0.8 },
    { action: 'fold', frequency: 0.2 },
  ];
  const firstEvent = {
    schemaVersion: 4,
    evaluationId: `${'ab'.repeat(32)}:d-1-preflop-0:local-preflop-baseline@1.0.0`,
    payloadSha256: '01'.repeat(32),
    skillKey: 'preflop.rfi.BTN',
    status: 'supported',
    grade: 'mixed',
    forced: false,
    evLossBb: null,
    providerId: canonicalSource.id,
    providerVersion: canonicalSource.version,
    origin: 'game',
    appliedAt: '2026-09-06T00:00:00.000Z',
    mixObservation: {
      spotKey: '6max-100bb-btn-rfi-unopened',
      handClass: 'AJo',
      referenceActions,
      chosenAction: { action: 'fold' },
      sourceIdentity: canonicalSource,
      detailSha256: '11'.repeat(32),
    },
  };
  const profile = applyEvent(emptyProfile(), firstEvent);
  assert.strictEqual(profile.game?.overall?.allowedActionRate,1,'all positive-frequency choices must remain allowed');

  const { createOwnedTempDir } = await import('./helpers/owned-fixtures.mjs');
  assert.equal(typeof createOwnedTempDir, 'function');

  function event(index, {
    action = 'raise',
    origin = 'game',
    sourceIdentity = canonicalSource,
    spotKey = '6max-100bb-btn-rfi-unopened',
    handClass = 'AJo',
    actions = referenceActions,
    includeObservation = true,
    grade = action === 'raise' ? 'preferred' : 'mixed',
  } = {}) {
    return {
      ...firstEvent,
      evaluationId: `${'ab'.repeat(32)}:d-${index}-preflop-0:${sourceIdentity.id}@${sourceIdentity.version}`,
      payloadSha256: index.toString(16).padStart(64, '0'),
      grade,
      origin,
      providerId: sourceIdentity.id,
      providerVersion: sourceIdentity.version,
      ...(includeObservation ? {
        mixObservation: {
          spotKey,
          handClass,
          referenceActions: actions,
          chosenAction: { action, ...(action === 'raise' ? { sizeBb: 2.5 } : {}) },
          sourceIdentity,
          detailSha256: index.toString(16).padStart(64, 'f'),
        },
      } : { mixObservation: undefined }),
    };
  }

  function replay({ raises, folds, ...options }) {
    let next = emptyProfile();
    let index = 10;
    for (let count = 0; count < raises; count += 1) next = applyEvent(next, event(index++, options));
    for (let count = 0; count < folds; count += 1) next = applyEvent(next, event(index++, { ...options, action: 'fold' }));
    return next;
  }

  function assertProjectionShape(value) {
    assert.ok(value && typeof value === 'object');
    assert.ok(value.overall && typeof value.overall === 'object');
    assert.ok(value.skills && typeof value.skills === 'object');
    assert.ok(Array.isArray(value.leaks));
    assert.ok(Array.isArray(value.candidates));
    assert.ok(value.coverage && typeof value.coverage === 'object');
    assert.ok(Array.isArray(value.coverageGaps));
    assert.ok(value.calibration && typeof value.calibration === 'object');
  }

  await t.test('schema 5 exposes independent game and practice projections', () => {
    const value = replay({ raises: 1, folds: 0 });
    assert.equal(value.schemaVersion, 5);
    assertProjectionShape(value.game);
    assertProjectionShape(value.practice);
    assert.equal(value.overall.evaluatedDecisions, value.game.overall.evaluatedDecisions);
  });

  for (const row of [
    { raises: 16, folds: 4, want: 1 },
    { raises: 20, folds: 0, want: 0.8 },
    { raises: 0, folds: 20, want: 0.2 },
  ]) {
    await t.test(`${row.raises}/${row.folds} choices use exact total-variation agreement`, () => {
      const value = replay(row);
      assert.equal(value.game.overall.allowedActionRate, 1);
      assert.equal(value.game.calibration.distributionAgreement, row.want);
      assert.equal(value.game.calibration.eligibleObservations, 20);
      assert.equal(value.game.calibration.totalObservations, 20);
    });
  }

  await t.test('nineteen observations are insufficient for calibration', () => {
    const value = replay({ raises: 15, folds: 4 });
    assert.equal(value.game.overall.allowedActionRate, 1);
    assert.equal(value.game.calibration.distributionAgreement, null);
    assert.match(value.game.calibration.reason, /insufficient/i);
    assert.equal(value.game.calibration.eligibleObservations, 0);
    assert.equal(value.game.calibration.totalObservations, 19);
  });

  await t.test('legacy evidence without mix observations remains uncalibrated', () => {
    let value = emptyProfile();
    for (let index = 40; index < 60; index += 1) {
      value = applyEvent(value, event(index, { includeObservation: false }));
    }
    assert.equal(value.game.calibration.distributionAgreement, null);
    assert.match(value.game.calibration.reason, /legacy|missing|unavailable/i);
    assert.equal(value.game.calibration.totalObservations, 0);
    assert.equal(value.game.overall.supportedDecisions, 0);
    assert.equal(value.game.overall.allowedActionRate, 0);
    assert.deepEqual(value.game.candidates, []);
    assert.equal(value.game.coverage.unverifiedDecisions, 20);
  });

  await t.test('practice observations cannot change game totals or calibration', () => {
    let value = replay({ raises: 20, folds: 0 });
    const gameBefore = structuredClone(value.game);
    for (let index = 100; index < 120; index += 1) {
      value = applyEvent(value, event(index, { action: 'fold', origin: 'practice' }));
    }
    assert.deepEqual(value.game, gameBefore);
    assert.equal(value.practice.overall.allowedActionRate, 1);
    assert.equal(value.practice.calibration.distributionAgreement, 0.2);
  });

  await t.test('spot and hand groups below twenty are not pooled', () => {
    let value = emptyProfile();
    for (let index = 130; index < 140; index += 1) value = applyEvent(value, event(index));
    for (let index = 140; index < 150; index += 1) {
      value = applyEvent(value, event(index, { handClass: 'KQo' }));
    }
    assert.equal(value.game.calibration.distributionAgreement, null);
    assert.equal(value.game.calibration.eligibleObservations, 0);
    assert.equal(value.game.calibration.totalObservations, 20);
  });

  await t.test('distinct reference vectors are never pooled', () => {
    const alternate = [
      { action: 'raise', sizeBb: 2.5, frequency: 0.7 },
      { action: 'fold', frequency: 0.3 },
    ];
    let value = emptyProfile();
    for (let index = 160; index < 170; index += 1) value = applyEvent(value, event(index));
    for (let index = 170; index < 180; index += 1) value = applyEvent(value, event(index, { actions: alternate }));
    assert.equal(value.game.calibration.distributionAgreement, null);
    assert.equal(value.game.calibration.eligibleObservations, 0);
  });

  await t.test('unverified source identities cannot complete a canonical calibration group', () => {
    const spoofed = { ...canonicalSource, contentSha256: 'ff'.repeat(32) };
    let value = emptyProfile();
    for (let index = 180; index < 190; index += 1) value = applyEvent(value, event(index));
    for (let index = 190; index < 200; index += 1) {
      value = applyEvent(value, event(index, { sourceIdentity: spoofed }));
    }
    assert.equal(value.game.calibration.distributionAgreement, null);
    assert.equal(value.game.calibration.eligibleObservations, 0);
    assert.equal(value.game.calibration.totalObservations, 10);
  });

  await t.test('eligible calibration groups use observation-count weighting', () => {
    let value = replay({ raises: 20, folds: 0 });
    for (let index = 200; index < 232; index += 1) {
      value = applyEvent(value, event(index, {
        action: index < 216 ? 'raise' : 'fold',
        handClass: 'KQo',
      }));
    }
    assert.ok(Math.abs(value.game.calibration.distributionAgreement - 0.7384615384615385) < 1e-12);
    assert.equal(value.game.calibration.eligibleObservations, 52);
    assert.equal(value.game.calibration.totalObservations, 52);
  });

  await t.test('duplicate replay is a no-op and conflicting evidence fails closed', () => {
    const first = event(260);
    const once = applyEvent(emptyProfile(), first);
    assert.deepEqual(applyEvent(once, first), once);
    assert.throws(() => applyEvent(once, { ...first, payloadSha256: 'ee'.repeat(32) }), {
      code: 'PROFILE_EVENT_CONFLICT',
    });
  });

  await t.test('mixed and low-frequency actions do not create practice candidates', () => {
    let value = applyEvent(emptyProfile(), event(270, { action: 'fold', grade: 'mixed' }));
    value = applyEvent(value, event(271, { action: 'fold', grade: 'low-frequency' }));
    assert.equal(value.game.overall.allowedActionRate, 1);
    assert.deepEqual(value.game.candidates, []);
    value = applyEvent(value, event(272, { action: 'call', grade: 'off-policy' }));
    assert.equal(value.game.overall.allowedActionRate, 2 / 3);
    assert.equal(value.game.candidates.length, 1);
  });

  await t.test('an off-size raise is not allowed by a positive frequency for another size', () => {
    const offSize = event(275, { grade: 'mixed' });
    offSize.mixObservation.chosenAction = { action: 'raise', sizeBb: 8.5 };
    const value = applyEvent(emptyProfile(), offSize);
    assert.equal(value.game.overall.allowedActionRate, 0);
    assert.equal(value.game.calibration.totalObservations, 1);
  });

  await t.test('reference authority is bound to the canonical content identity', async () => {
    const { referenceQuality } = await import('../shared/reference.js');
    assert.equal(referenceQuality(canonicalSource).quality, 'heuristic-reference');
    assert.equal(referenceQuality({ ...canonicalSource, contentSha256: 'ff'.repeat(32) }).quality, 'unverified');
    assert.equal(referenceQuality({ id: 'fake-solver', version: '1.0.0', contentSha256: 'aa'.repeat(32) }).quality, 'synthetic');
    assert.notEqual(referenceQuality(canonicalSource).quality, 'solver-verified');
  });

  await t.test('malformed observations fail and spoofed or fake authority is excluded', async () => {
    const { validateMixObservation } = await import('../shared/reference.js');
    assert.throws(() => validateMixObservation({ ...firstEvent.mixObservation, referenceActions: [] }), {
      code: 'MIX_OBSERVATION_INVALID',
    });
    assert.throws(() => validateMixObservation({
      ...firstEvent.mixObservation,
      chosenAction: { action: 'fold', frequency: Number.POSITIVE_INFINITY },
    }), { code: 'MIX_OBSERVATION_INVALID' });
    assert.throws(() => validateMixObservation({
      ...firstEvent.mixObservation,
      referenceActions: [
        { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: {} },
        { action: 'fold', frequency: 0.2 },
      ],
    }), { code: 'MIX_OBSERVATION_INVALID' });
    let value = applyEvent(emptyProfile(), event(280, {
      sourceIdentity: { ...canonicalSource, contentSha256: 'ff'.repeat(32) },
    }));
    value = applyEvent(value, event(281, {
      sourceIdentity: { id: 'fake-solver', version: '1.0.0', contentSha256: 'aa'.repeat(32) },
    }));
    assert.equal(value.game.overall.supportedDecisions, 0);
    assert.deepEqual(value.game.candidates, []);
    assert.equal(Object.keys(value.processed).length, 2);
  });

  await t.test('forced and unsupported events never enter calibration or study progress', () => {
    const studyRun = {
      id: '11111111-1111-4111-8111-111111111111',
      mode: 'assessment',
      total: 2,
      index: 0,
      startedAt: '2026-09-06T00:00:00.000Z',
      assessmentId: '22222222-2222-4222-8222-222222222222',
    };
    let value = applyEvent(emptyProfile(), { ...event(290), forced: true, studyRun });
    value = applyEvent(value, { ...event(291), status: 'unsupported', grade: null, studyRun });
    assert.equal(value.game.calibration.totalObservations, 0);
    assert.deepEqual(value.game.studyRuns, {});
    assert.equal(value.game.overall.evaluatedDecisions, 2);
    assert.equal(value.game.overall.forfeits, 1);
    assert.equal(value.game.overall.unsupportedDecisions, 1);
  });
});
