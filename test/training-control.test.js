import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl } from '../tools/training-control.js';
import { readJsonl } from '../tools/training-store.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tctrl-'));
}

function evalOf(overrides = {}) {
  const evaluationId = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId: 'd-1-preflop-0',
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  return {
    schemaVersion: 1,
    evaluationId,
    decisionId: 'd-1-preflop-0',
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0', license: 'Apache-2.0', contentSha256: 'x' },
    ...overrides,
  };
}

test('accept is idempotent on same digest and fail-closed on digest conflict', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  const evaluation = evalOf();
  const first = await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  assert.equal(first.accepted.length, 1);
  assert.equal(first.accepted[0].status, 'evaluated');
  const again = await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  assert.equal(again.accepted.length, 1);
  assert.equal(readJsonl(path.join(dir, 'training', 'evaluations.jsonl')).length, 1);

  await assert.rejects(
    () => tc.acceptEvaluations(dir, {
      gameEpoch: 'ab'.repeat(32),
      owner: 'owner-1',
      handNo: 1,
      evaluations: [evalOf({ grade: 'off-policy' })],
    }),
    { code: 'EVALUATION_CONFLICT' },
  );
});

test('reconcile records pending when archive is missing and does not evaluate (R2 producer-closed barrier)', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  const snapshot = {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
      playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
    forced: false,
  };
  const lastHand = { handNo: 1, decisions: [snapshot] };
  let calls = 0;
  const evaluate = () => {
    calls += 1;
    return [evalOf()];
  };
  const first = await tc.reconcile(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    lastHand,
    handsDir: path.join(dir, 'hands'),
    evaluate,
  });
  assert.equal(calls, 0);
  assert.equal(first.created ?? 0, 0);
  const pendingAuth = tc.loadAuthority(dir);
  assert.equal(pendingAuth.pending['d-1-preflop-0'] != null, true);
  fs.mkdirSync(path.join(dir, 'hands'));
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), JSON.stringify(lastHand));
  const second = await tc.reconcile(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    lastHand,
    handsDir: path.join(dir, 'hands'),
    evaluate,
  });
  assert.equal(second.created ?? 0, 0);
  assert.equal(calls, 0);
  const id = evalOf().evaluationId;
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[id], undefined);
  assert.equal(auth.pending['d-1-preflop-0'].handNo, 1);
});

test('unknown authority schema is fail-closed', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evalOf()],
  });
  const authPath = path.join(dir, 'training', '.training-authority.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  auth.schemaVersion = 99;
  fs.writeFileSync(authPath, JSON.stringify(auth));
  await assert.rejects(
    () => tc.acceptEvaluations(dir, {
      gameEpoch: 'ab'.repeat(32),
      owner: 'owner-1',
      handNo: 1,
      evaluations: [evalOf()],
    }),
    { code: 'UNSUPPORTED_TRAINING_AUTHORITY' },
  );
});
