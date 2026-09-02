import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyProfile, rebuildFromEvents } from '../training/profile-aggregator.js';
import { evaluationIdOf } from '../training/contracts.js';

function event(overrides = {}) {
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    skillKey: 'preflop.rfi.BTN',
    status: 'supported',
    grade: 'preferred',
    forced: false,
    evLossBb: null,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
    appliedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

test('same evaluation is applied once; digest conflict fail-closed; forced is forfeit', () => {
  let profile = emptyProfile();
  profile = applyEvent(profile, event());
  const again = applyEvent(profile, event());
  assert.equal(again.overall.evaluatedDecisions, 1);
  assert.equal(again.overall.supportedDecisions, 1);
  assert.equal(again.skills['preflop.rfi.BTN'].opportunities, 1);
  assert.equal(again.skills['preflop.rfi.BTN'].preferredActionRate, 1);
  assert.throws(() => applyEvent(profile, event({ payloadSha256: 'bb'.repeat(32) })), {
    code: 'PROFILE_EVENT_CONFLICT',
  });
  profile = applyEvent(profile, event({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-2-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'cc'.repeat(32),
    forced: true,
    grade: 'off-policy',
  }));
  assert.equal(profile.overall.forfeits, 1);
  assert.equal(profile.skills['preflop.rfi.BTN'].opportunities, 1);
});

test('unsupported is coverage only; rebuild is byte-stable', () => {
  const events = [
    event(),
    event({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: 'd-3-preflop-0',
        providerId: 'local-preflop-baseline',
        providerVersion: '1.0.0',
      }),
      payloadSha256: 'dd'.repeat(32),
      status: 'unsupported',
      grade: null,
    }),
  ];
  const a = rebuildFromEvents(events);
  const b = rebuildFromEvents(events);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.overall.unsupportedDecisions, 1);
  assert.equal(a.overall.supportedDecisions, 1);
  assert.equal(a.skills['preflop.rfi.BTN'].supported, 1);
  assert.equal(a.leaks.length >= 0, true);
});

test('provider version is a separate segment', () => {
  let profile = applyEvent(emptyProfile(), event());
  profile = applyEvent(profile, event({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    providerVersion: '2.0.0',
  }));
  assert.ok(profile.segments['local-preflop-baseline@1.0.0']);
  assert.ok(profile.segments['local-preflop-baseline@2.0.0']);
  assert.equal(profile.segments['local-preflop-baseline@1.0.0'].evaluatedDecisions, 1);
  assert.equal(profile.segments['local-preflop-baseline@2.0.0'].evaluatedDecisions, 1);
});

test('mixed provider versions are never summed at the top level', () => {
  let profile = applyEvent(emptyProfile(), event());
  profile = applyEvent(profile, event({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    providerVersion: '2.0.0',
  }));
  assert.equal(profile.activeSegmentId, 'local-preflop-baseline@2.0.0');
  assert.equal(profile.overall.evaluatedDecisions, 1);
  assert.equal(profile.skills['preflop.rfi.BTN'].opportunities, 1);
  assert.equal(profile.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
  assert.equal(profile.segments['local-preflop-baseline@2.0.0'].overall.evaluatedDecisions, 1);
  assert.equal(profile.segments['local-preflop-baseline@1.0.0'].skills['preflop.rfi.BTN'].opportunities, 1);
});

test('rebuild [game A, drill, drill] keeps activeSegmentId at A', () => {
  const profile = rebuildFromEvents([
    event({ origin: 'game' }),
    event({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: 'd-8-preflop-0',
        providerId: 'local-preflop-baseline',
        providerVersion: '1.0.0',
      }),
      payloadSha256: '11'.repeat(32),
      origin: 'drill',
    }),
    event({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: 'd-9-preflop-0',
        providerId: 'other-solver',
        providerVersion: '3.0.0',
      }),
      payloadSha256: '22'.repeat(32),
      providerId: 'other-solver',
      providerVersion: '3.0.0',
      origin: 'drill',
    }),
  ]);
  assert.equal(profile.activeSegmentId, 'local-preflop-baseline@1.0.0');
  assert.equal(profile.overall.evaluatedDecisions, 2);
});

test('drill-only profile uses the most recent drill provider', () => {
  const profile = rebuildFromEvents([
    event({
      origin: 'drill',
      providerId: 'drill-a',
      providerVersion: '1.0.0',
    }),
    event({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: 'd-8-preflop-0',
        providerId: 'drill-b',
        providerVersion: '2.0.0',
      }),
      payloadSha256: '33'.repeat(32),
      providerId: 'drill-b',
      providerVersion: '2.0.0',
      origin: 'drill',
    }),
  ]);
  assert.equal(profile.activeSegmentId, 'drill-b@2.0.0');
  assert.equal(profile.overall.evaluatedDecisions, 1);
});

test('other-provider drill is a separate segment and is not mixed into the game overall', () => {
  const profile = rebuildFromEvents([
    event({ origin: 'game' }),
    event({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: 'd-8-preflop-0',
        providerId: 'other-solver',
        providerVersion: '3.0.0',
      }),
      payloadSha256: '44'.repeat(32),
      providerId: 'other-solver',
      providerVersion: '3.0.0',
      origin: 'drill',
    }),
  ]);
  assert.equal(profile.activeSegmentId, 'local-preflop-baseline@1.0.0');
  assert.equal(profile.overall.evaluatedDecisions, 1);
  assert.ok(profile.segments['other-solver@3.0.0']);
  assert.equal(profile.segments['other-solver@3.0.0'].overall.evaluatedDecisions, 1);
  assert.equal(profile.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
});

test('missing payloadSha256 is PROFILE_EVENT_INVALID; empty profile defaults to the dataset provider', () => {
  assert.equal(emptyProfile().activeSegmentId, 'local-preflop-baseline@1.0.0');
  const bad = event();
  delete bad.payloadSha256;
  assert.throws(() => applyEvent(emptyProfile(), bad), { code: 'PROFILE_EVENT_INVALID' });
});
