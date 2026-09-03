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
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    const finish = () => resolve(cancelled ? { ok: false, code: 'TERMINATED' } : result);
    if (delayMs > 0) timer = setTimeout(finish, delayMs);
    else finish();
  });
  return {
    promise,
    async terminate() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      resolvePromise?.({ ok: false, code: 'TERMINATED' });
      onTerminate?.();
      return { confirmed: true };
    },
  };
}

function writeLastHand(dir, {
  token = 'tok', handNo = 1, decisionId = 'd-1-preflop-0', decisionIds,
} = {}) {
  const ids = decisionIds ?? [decisionId];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: token,
    lastHand: { handNo, decisions: ids.map((id) => snapshotOf(id)) },
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
  let evaluateCalls = 0;
  let explainCalls = 0;
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const result = await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      evaluateCalls += 1;
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
    evaluate: () => {
      evaluateCalls += 1;
      return handleOf({ ok: true, evaluations: [evaluation] });
    },
    explain: () => {
      explainCalls += 1;
      return handleOf(VALID_EXPLAIN);
    },
  });
  assert.equal(again.ok, true);
  assert.equal(evaluateCalls, 1);
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
  assert.equal(started.length, 1);
  const auth = createTrainingControl().loadAuthority(dir);
  assert.equal(Object.keys(auth.items).length, 1);
});

test('delayed consume does not delay machine publish', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  let releaseConsume;
  const consumeGate = new Promise((resolve) => { releaseConsume = resolve; });
  const order = [];
  const running = pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => handleOf({ ok: true, evaluations: [evaluation] }),
    explain: () => handleOf(VALID_EXPLAIN),
    publish: (kind) => { order.push(`publish:${kind}`); },
    consume: async () => {
      order.push('consume-start');
      await consumeGate;
      order.push('consume-end');
    },
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !order.includes('publish:machine')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(order.includes('publish:machine'), true, 'machine publish waited on consume');
  assert.equal(order.includes('consume-end'), false);
  releaseConsume();
  await running;
  assert.ok(order.indexOf('publish:machine') < order.indexOf('consume-start')
    || order.indexOf('publish:machine') < order.indexOf('consume-end'));
});

test('concurrent machine and annotation flushes cannot publish the other producer body', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => handleOf({ ok: true, evaluations: [evaluation] }),
    explain: () => handleOf(VALID_EXPLAIN),
  });
  let inPublish = 0;
  let releaseBoth;
  const bothInPublish = new Promise((resolve) => { releaseBoth = resolve; });
  const seen = [];
  const executePublish = async (args) => {
    const file = args[args.indexOf('--from') + 1];
    const atEnter = JSON.parse(fs.readFileSync(file, 'utf8'));
    inPublish += 1;
    if (inPublish >= 2) releaseBoth();
    await Promise.race([
      bothInPublish,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    const atRead = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen.push({ atEnter, atRead });
    return { ok: true };
  };
  await Promise.all([
    pipeline.flushMachinePublish(dir, { gameEpoch, executePublish }),
    pipeline.flushAnnotationPublish(dir, { gameEpoch, executePublish }),
  ]);
  assert.equal(seen.length >= 2, true);
  assert.equal(seen.some((row) => Array.isArray(row.atEnter.training) && row.atEnter.training.length), true);
  assert.equal(
    seen.some((row) => Array.isArray(row.atEnter.trainingAnnotations) && row.atEnter.trainingAnnotations.length),
    true,
  );
  for (const row of seen) {
    assert.deepEqual(row.atRead, row.atEnter);
  }
});

test('partial hand with one item and one pending still evaluates the missing decision', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token, decisionIds: ['d-1-preflop-0', 'd-1-flop-0'] });
  const first = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const second = cannedEvaluation('d-1-flop-0', gameEpoch);
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [first],
  });
  await tc.recordPending(dir, 'd-1-flop-0', {
    handNo: 1,
    reason: 'EVALUATE_FAILED',
    gameEpoch,
    owner: 'owner-1',
  });
  const originalSha = tc.loadAuthority(dir).items[first.evaluationId].payloadSha256;
  const mutatedFirst = {
    ...first,
    source: { id: 'local-preflop-baseline', version: '9.9.9' },
    evaluationId: evaluationIdOf({
      gameEpoch,
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '9.9.9',
    }),
  };
  let evaluateCalls = 0;
  const result = await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      evaluateCalls += 1;
      return handleOf({ ok: true, evaluations: [mutatedFirst, second] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(evaluateCalls, 1);
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[first.evaluationId].decisionId, 'd-1-preflop-0');
  assert.equal(auth.items[first.evaluationId].payloadSha256, originalSha);
  assert.equal(auth.items[mutatedFirst.evaluationId], undefined);
  assert.equal(auth.items[second.evaluationId].decisionId, 'd-1-flop-0');
  assert.equal(auth.pending['d-1-flop-0'], undefined);
  assert.equal(Object.keys(auth.items).length, 2);
});

test('explain concurrency is 1 across hands', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token, handNo: 2, decisionId: 'd-2-preflop-0' });
  fs.mkdirSync(path.join(dir, 'hands'));
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), JSON.stringify({
    handNo: 1,
    decisions: [snapshotOf('d-1-preflop-0')],
  }));
  const first = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const second = cannedEvaluation('d-2-preflop-0', gameEpoch);
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch, owner: 'owner-1', handNo: 1, evaluations: [first],
  });
  await tc.acceptEvaluations(dir, {
    gameEpoch, owner: 'owner-1', handNo: 2, evaluations: [second],
  });
  let inExplain = 0;
  let overlap = 0;
  const explain = () => {
    inExplain += 1;
    if (inExplain > 1) overlap += 1;
    return {
      promise: new Promise((resolve) => {
        setTimeout(() => {
          inExplain -= 1;
          resolve(VALID_EXPLAIN);
        }, 40);
      }),
      terminate: async () => ({ confirmed: true }),
    };
  };
  const results = await Promise.all([
    pipeline.runHandPipeline({
      sessionDir: dir,
      handNo: 1,
      gameEpoch,
      owner: 'owner-1',
      evaluate: () => { throw new Error('hand 1 must not re-evaluate'); },
      explain,
    }),
    pipeline.runHandPipeline({
      sessionDir: dir,
      handNo: 2,
      gameEpoch,
      owner: 'owner-1',
      evaluate: () => { throw new Error('hand 2 must not re-evaluate'); },
      explain,
    }),
  ]);
  assert.equal(results.every((row) => row.ok), true);
  assert.equal(overlap, 0);
});

test('in-flight explain remains ready when only the process-local cutoff exists', async () => {
  const dir = tmp();
  const token = 'tok';
  const gameEpoch = gameEpochOf(token);
  writeLastHand(dir, { token });
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  const { enterExplanationCutoff } = await import('../tools/training-control.js');
  if (typeof enterExplanationCutoff === 'function') enterExplanationCutoff(dir);
  assert.equal(fs.existsSync(path.join(dir, 'training', '.cutoff')), false);
  await pipeline.runHandPipeline({
    sessionDir: dir,
    handNo: 1,
    gameEpoch,
    owner: 'owner-1',
    evaluate: () => {
      throw new Error('already-itemized decision must not be re-evaluated');
    },
    explain: () => handleOf(VALID_EXPLAIN),
  });
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations?.explanation?.status, 'ready');
  assert.equal(auth.items[evaluation.evaluationId].annotations?.explanation?.sealReason, undefined);
});
