import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProfileStore } from '../training/profile-store.js';
import { evaluationIdOf } from '../training/contracts.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-profile-'));
}

function evaluation(overrides = {}) {
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    grade: 'preferred',
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    ...overrides,
  };
}

test('profile lives under store/.training and survives a torn jsonl tail', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  await store.apply(evaluation());
  const profilePath = path.join(storeDir, '.training', 'profile.json');
  const eventsPath = path.join(storeDir, '.training', 'profile-events.jsonl');
  assert.equal(fs.lstatSync(path.join(storeDir, '.training')).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(profilePath).mode & 0o777, 0o600);
  fs.appendFileSync(eventsPath, '{"partial":true');
  const rebuilt = await store.rebuild();
  assert.equal(rebuilt.overall.evaluatedDecisions, 1);
  await store.apply(evaluation());
  assert.equal((await store.show()).overall.evaluatedDecisions, 1);
});

test('apply returns {applied}; missing payloadSha256 is PROFILE_EVENT_INVALID', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = await store.apply(evaluation());
  assert.equal(first.applied, true);
  const again = await store.apply(evaluation());
  assert.equal(again.applied, false);
  await assert.rejects(() => store.apply(evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-2-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: undefined,
  })), {
    code: 'PROFILE_EVENT_INVALID',
  });
});

test('new profile persist uses schemaVersion 2', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = await store.apply(evaluation());
  assert.equal(first.profile.schemaVersion, 2);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
});

test('schema 1 profile is rebuilt from events as schema 2 and is not returned raw', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = evaluation();
  const second = evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    source: { id: 'local-preflop-baseline', version: '2.0.0' },
  });
  await store.apply(first);
  await store.apply(second);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    processed: {
      [first.evaluationId]: first.payloadSha256,
      [second.evaluationId]: second.payloadSha256,
    },
    overall: {
      evaluatedDecisions: 2,
      supportedDecisions: 2,
      unsupportedDecisions: 0,
      forfeits: 0,
      preferred: 2,
      offPolicy: 0,
      evLossBb: null,
      evLossBbPer100: null,
    },
    skills: {
      'preflop.rfi.BTN': { opportunities: 2, supported: 2, preferred: 2, offPolicy: 0 },
    },
    leaks: [],
    segments: {
      'local-preflop-baseline@1.0.0': { evaluatedDecisions: 1, supportedDecisions: 1 },
      'local-preflop-baseline@2.0.0': { evaluatedDecisions: 1, supportedDecisions: 1 },
    },
  }));
  const shown = await store.show();
  assert.equal(shown.schemaVersion, 2);
  assert.equal(shown.activeSegmentId, 'local-preflop-baseline@2.0.0');
  assert.equal(shown.overall.evaluatedDecisions, 1);
  assert.equal(shown.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
  assert.equal(shown.segments['local-preflop-baseline@2.0.0'].overall.evaluatedDecisions, 1);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.overall.evaluatedDecisions, 1);
});

test('schema 1 load fails closed when events cannot support the nested schema', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true, mode: 0o700 });
  const row = evaluation();
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    processed: { [row.evaluationId]: row.payloadSha256 },
    overall: { evaluatedDecisions: 2 },
    skills: {},
    leaks: [],
    segments: {},
  }));
  await assert.rejects(() => store.show(), { code: 'UNSUPPORTED_PROFILE' });

  fs.writeFileSync(store.eventsPath, `${JSON.stringify({
    evaluationId: row.evaluationId,
    skillKey: 'preflop.rfi.BTN',
    status: 'supported',
    grade: 'preferred',
    forced: false,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
    appliedAt: '2026-09-01T00:00:00.000Z',
  })}\n`);
  await assert.rejects(() => store.show(), { code: 'PROFILE_EVENT_INVALID' });
});

test('schema 2 file is not read as schema 1 mixed totals; duplicate apply projects', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = evaluation();
  const second = evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    source: { id: 'local-preflop-baseline', version: '2.0.0' },
  });
  await store.apply(first);
  await store.apply(second);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  disk.overall.evaluatedDecisions = 99;
  disk.overall.supportedDecisions = 99;
  fs.writeFileSync(store.profilePath, JSON.stringify(disk));
  const shown = await store.show();
  assert.equal(shown.schemaVersion, 2);
  assert.equal(shown.overall.evaluatedDecisions, 1);
  const again = await store.apply(second);
  assert.equal(again.applied, false);
  assert.equal(again.profile.schemaVersion, 2);
  assert.equal(again.profile.overall.evaluatedDecisions, 1);
});
