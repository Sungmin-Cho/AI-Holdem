import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestHand, unpublishedEnvelope } from '../tools/training-pipeline.js';
import * as pipeline from '../tools/training-pipeline.js';
import { gameEpochOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl, readAnnotationExactFile } from '../tools/training-control.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tpipe-'));
}

test('ingestHand evaluates a user decision and builds a training envelope', async () => {
  const dir = tmp();
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
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: 'tok',
    lastHand: { handNo: 1, decisions: [snapshot] },
  }));
  const result = await ingestHand({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf('tok'),
    owner: 'owner-1',
  });
  assert.equal(result.ok, true);
  const envelope = unpublishedEnvelope(dir, { gameEpoch: gameEpochOf('tok') });
  assert.equal(envelope.training.length, 1);
  assert.equal(envelope.training[0].handClass, 'AA');
  assert.equal(envelope.training[0].grade, 'preferred');
  assert.equal(envelope.training[0].explanation, undefined);
  assert.ok(Array.isArray(envelope.trainingAuthority.items));
  assert.equal(envelope.trainingAuthority.items.length, 1);
  assert.equal(envelope.trainingAuthority.items[0].evaluationId, envelope.training[0].evaluationId);
  assert.equal(JSON.stringify(envelope).includes('Ah'), false);
  assert.equal(JSON.stringify(envelope).includes('path'), false);
  assert.equal(envelope.view, undefined);
});

test('ingestHand fail-open when the hand is missing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionToken: 'tok' }));
  const result = await ingestHand({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf('tok'),
    owner: 'owner-1',
  });
  assert.equal(result.ok, false);
});

function snapshotOf(decisionId = 'd-1-preflop-0') {
  return {
    schemaVersion: 1,
    decisionId,
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Jo'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
      playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'fold' },
    forced: false,
  };
}

function cannedEvaluation(decisionId, gameEpoch) {
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch,
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null }],
    chosen: { action: 'fold', frequency: 0.04, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'mixed',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

function handleOf(result, { delayMs = 0, onTerminate } = {}) {
  let timer = null;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    const finish = () => resolve(cancelled ? { ok: false, code: 'TERMINATED' } : result);
    if (delayMs > 0) timer = setTimeout(finish, delayMs);
    else finish();
  });
  return {
    promise,
    async terminate() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      onTerminate?.();
      return { confirmed: true };
    },
  };
}

function writeLastHand(dir, { token = 'tok', handNo = 1, decisionId = 'd-1-preflop-0' } = {}) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: token,
    lastHand: { handNo, decisions: [snapshotOf(decisionId)] },
  }));
}

const VALID_EXPLAIN = 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.';

test('runHandPipeline publishes machine before explain and seals explanation set-once', async () => {
  assert.equal(typeof pipeline.runHandPipeline, 'function');
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  const order = [];
  let explainCalls = 0;
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const result = await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      order.push('evaluate');
      return handleOf({ ok: true, evaluations: [evaluation] });
    },
    explain: () => {
      explainCalls += 1;
      order.push('explain');
      return handleOf(VALID_EXPLAIN);
    },
    publish: (kind) => {
      order.push(`publish:${kind}`);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['evaluate', 'publish:machine', 'explain', 'publish:annotation']);
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(dir);
  const item = auth.items[evaluation.evaluationId];
  assert.equal(item.status, 'evaluated');
  assert.equal(item.annotations.explanation.status, 'ready');
  const again = await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => handleOf({ ok: true, evaluations: [evaluation] }),
    explain: () => {
      explainCalls += 1;
      return handleOf(VALID_EXPLAIN);
    },
  });
  assert.equal(again.ok, true);
  assert.equal(explainCalls, 1);
  const sealed = readAnnotationExactFile(dir, item.detailRef, 'explanation');
  assert.equal(sealed.status, 'ready');
});

test('evaluator failure records pending[decisionId] without an item', async () => {
  const dir = tmp();
  const token = 'tok';
  writeLastHand(dir, { token });
  const result = await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf(token),
    owner: 'owner-1',
    evaluate: () => handleOf({ ok: false, code: 'EVALUATE_FAILED' }),
  });
  assert.equal(result.ok, false);
  const auth = createTrainingControl().loadAuthority(dir);
  assert.equal(auth.pending['d-1-preflop-0'].reason, 'EVALUATE_FAILED');
  assert.equal(Object.keys(auth.items).length, 0);
});

test('archivePending lastHand evaluate then archive repair is a reconcile no-op', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  let evaluateCalls = 0;
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      evaluateCalls += 1;
      return handleOf({ ok: true, evaluations: [evaluation] });
    },
  });
  fs.mkdirSync(path.join(dir, 'hands'));
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), JSON.stringify({
    handNo: 1,
    decisions: [snapshotOf()],
  }));
  const recon = await pipeline.reconcileSession({
    sessionDir: dir,
    gameEpoch,
    owner: 'owner-1',
    lastHand: { handNo: 1, decisions: [snapshotOf()] },
    evaluate: () => {
      evaluateCalls += 1;
      return [evaluation];
    },
  });
  assert.equal(evaluateCalls, 1);
  assert.equal((recon.missing ?? []).length, 0);
});

test('in-flight duplicate runHandPipeline of the same digest is a no-op', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const started = [];
  const first = pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      started.push('a');
      return handleOf({ ok: true, evaluations: [evaluation] }, { delayMs: 40 });
    },
  });
  const second = pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      started.push('b');
      return handleOf({ ok: true, evaluations: [evaluation] });
    },
  });
  const results = await Promise.all([first, second]);
  assert.equal(results.every((row) => row.ok), true);
  const auth = createTrainingControl().loadAuthority(dir);
  assert.equal(Object.keys(auth.items).length, 1);
});
