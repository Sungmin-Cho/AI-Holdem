import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl, writeCutoffMarkerUnlocked } from '../tools/training-control.js';
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

test('cutoff marker then late ready seal becomes unavailable', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  assert.equal(typeof tc.writeCutoffMarker, 'function');
  const evaluation = evalOf();
  await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  await tc.writeCutoffMarker(dir);
  const sealed = await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', '늦은 해설');
  assert.equal(sealed.ok, true);
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.status, 'unavailable');
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.sealReason, 'cutoff');
});

test('cutoff marker already-present file is EXISTS reuse; non-file dest fails closed', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  const evaluation = evalOf();
  await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  const first = await tc.writeCutoffMarker(dir);
  assert.equal(first.reused, false);
  const second = await tc.writeCutoffMarker(dir);
  assert.equal(second.reused, true);
  fs.unlinkSync(path.join(dir, 'training', '.cutoff'));
  fs.mkdirSync(path.join(dir, 'training', '.cutoff'));
  await assert.rejects(
    () => tc.writeCutoffMarker(dir),
    (error) => error.code === 'UNSAFE_PATH',
  );
});

test('writeCutoffMarker EXISTS reuse re-lstats and rejects a non-file dest', () => {
  const dir = tmp();
  const dest = path.join(dir, 'training', '.cutoff');
  assert.throws(
    () => writeCutoffMarkerUnlocked(dir, {
      write() {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.mkdirSync(dest);
        const error = new Error('exists');
        error.code = 'EXISTS';
        throw error;
      },
    }),
    (error) => error.code === 'UNSAFE_PATH',
  );
  assert.equal(fs.lstatSync(dest).isDirectory(), true);
});

test('writeCutoffMarker EXISTS reuse re-lstats and accepts a regular file', () => {
  const dir = tmp();
  const dest = path.join(dir, 'training', '.cutoff');
  const result = writeCutoffMarkerUnlocked(dir, {
    write() {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify({ at: 'already' }));
      const error = new Error('exists');
      error.code = 'EXISTS';
      throw error;
    },
  });
  assert.equal(result.reused, true);
  assert.equal(fs.lstatSync(dest).isFile(), true);
});

test('process-local explanation cutoff cannot replace the durable marker fence', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  const evaluation = evalOf();
  await tc.acceptEvaluations(dir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  const { enterExplanationCutoff } = await import('../tools/training-control.js');
  assert.equal(typeof enterExplanationCutoff, 'function');
  enterExplanationCutoff(dir);
  assert.equal(fs.existsSync(path.join(dir, 'training', '.cutoff')), false);
  const sealed = await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', '늦은 해설');
  assert.equal(sealed.ok, true);
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.status, 'ready');
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.sealReason, undefined);
});
