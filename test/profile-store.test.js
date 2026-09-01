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
