import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameLoop } from '../tools/game-loop.js';
import { gameEpochOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl } from '../tools/training-control.js';
import { startServer } from '../server/server.js';
import * as pipeline from '../tools/training-pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID_REVIEW = [
  '## 내 성향 통계',
  'VPIP와 PFR은 참고용 표본으로 해석합니다.',
  '## 결정적 핸드 2~3개 리플레이',
  '결정 시점의 공개 정보로 과정을 복기합니다.',
  '## 각 AI의 실제 아키타입 공개 + 읽기 평가',
  '상대 성향을 맞게 읽은 부분과 놓친 부분을 구분합니다.',
  '## 다음 게임에서 연습할 것',
  '팟 오즈 확인과 포지션별 오픈 범위를 연습합니다.',
].join('\n\n');
const VALID_EXPLAIN = 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.';

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tasync-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw new Error(`${message}: ${lastError.message}`);
  assert.fail(message);
}

async function waitForUserSnapshot(gameDir, timeoutMs = 8_000) {
  return waitFor(async () => {
    const lock = readJson(path.join(gameDir, 'lock.json'));
    const response = await fetch(
      `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
    );
    if (!response.ok) return null;
    const snapshot = await response.json();
    return snapshot.view?.legal?.toAct === 'user' ? { lock, snapshot } : null;
  }, 'user snapshot did not become available', timeoutMs);
}

async function snapshotOf(gameDir) {
  const lock = readJson(path.join(gameDir, 'lock.json'));
  const response = await fetch(
    `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
  );
  if (!response.ok) return null;
  return response.json();
}

async function postUserAction(lock, action) {
  const response = await fetch(
    `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    },
  );
  return response.json();
}

function startRun(loop) {
  const promise = loop.run();
  promise.catch(() => {});
  return promise;
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

function userDecision(sessionDir, handNo) {
  const state = readJson(path.join(sessionDir, 'state.json'));
  const record = state.lastHand?.handNo === handNo
    ? state.lastHand
    : JSON.parse(fs.readFileSync(path.join(sessionDir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`), 'utf8'));
  return (record.decisions ?? []).find((snap) => snap.actorId === 'user') ?? null;
}

function handleOf(result, { delayMs = 0, gate = null, onTerminate } = {}) {
  let timer = null;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    const finish = () => resolve(typeof result === 'function' ? result() : result);
    const run = async () => {
      if (gate) await gate;
      if (cancelled) {
        resolve({ ok: false, code: 'TERMINATED' });
        return;
      }
      if (delayMs > 0) timer = setTimeout(finish, delayMs);
      else finish();
    };
    run();
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

function makeEvaluate({ delayMs = 0, failTimes = 0, gate = null, calls } = {}) {
  const log = calls ?? [];
  return (sessionDir, handNo) => {
    log.push({ sessionDir, handNo, at: Date.now() });
    if (log.length <= failTimes) {
      return handleOf({ ok: false, code: 'EVALUATE_FAILED' }, { delayMs, gate });
    }
    return handleOf(() => {
      const state = readJson(path.join(sessionDir, 'state.json'));
      const snap = userDecision(sessionDir, handNo);
      if (!snap) return { ok: false, code: 'NO_DECISION' };
      return {
        ok: true,
        evaluations: [cannedEvaluation(snap.decisionId, gameEpochOf(state.sessionToken))],
      };
    }, { delayMs, gate });
  };
}

function makeExplain({ delayMs = 0, gate = null, calls, text = VALID_EXPLAIN } = {}) {
  const log = calls ?? [];
  return (evaluation) => {
    log.push(evaluation?.evaluationId ?? null);
    return handleOf(text, { delayMs, gate });
  };
}

function makeCoachAdapter() {
  return {
    kind: 'coach-fake',
    oneshotStart(input) {
      const stage = input.prompt.includes('역할: 격리 evaluator')
        ? 'evaluator'
        : input.prompt.includes('역할: 종합자')
          ? 'synthesizer'
          : input.prompt.includes('역할: 학습 해설')
            ? 'explain'
            : 'coach';
      const raw = stage === 'evaluator'
        ? '표본 30핸드 미만이므로 참고용입니다.'
        : stage === 'synthesizer'
          ? VALID_REVIEW
          : stage === 'explain'
            ? JSON.stringify({ evaluationId: 'mismatch', explanation: VALID_EXPLAIN })
            : JSON.stringify({ handNo: 1, text: '코치' });
      let timer = null;
      const done = new Promise((resolve) => {
        const delay = stage === 'explain' ? 5_000 : 0;
        timer = setTimeout(() => resolve({ raw }), delay);
      });
      return {
        done,
        async terminate() {
          if (timer) clearTimeout(timer);
          return { confirmed: true };
        },
      };
    },
    async dispose() {},
  };
}

async function playUntil(loop, gameDir, { until, timeoutMs = 20_000 } = {}) {
  const running = startRun(loop);
  const sent = new Set();
  const driver = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let loopState = null;
      try { loopState = readJson(path.join(gameDir, 'loop-state.json')); } catch { /* */ }
      if (loopState && until(loopState, gameDir)) return;
      if (loopState?.halt) return;
      try {
        const { lock, snapshot } = await waitForUserSnapshot(gameDir, 250);
        const legal = snapshot.view.legal;
        if (!sent.has(legal.decisionId)) {
          sent.add(legal.decisionId);
          const action = legal.canRaise
            ? { decisionId: legal.decisionId, action: 'raise', amount: legal.minRaiseTo }
            : { decisionId: legal.decisionId, action: legal.canCheck ? 'check' : 'fold' };
          await postUserAction(lock, action);
        }
      } catch { /* AI turn or terminal */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  await driver;
  return { running, sent };
}

function envelopeFromPublishArgs(args) {
  const index = args.indexOf('--from');
  if (index === -1) return null;
  const file = args[index + 1];
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('turn loop does not wait on training; machine UI arrives before explanation', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const explainCalls = [];
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      log: (record) => logs.push(record),
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain({ delayMs: 5_000, calls: explainCalls }),
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 2,
    opponentRuntime: 'policy',
  });
  const hand1DoneAt = { t: null };
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => {
      if (state.handNo >= 1 && hand1DoneAt.t == null) {
        try {
          const engine = readJson(path.join(gameDir, 'state.json'));
          if (engine.lastHand?.handNo === 1) hand1DoneAt.t = Date.now();
        } catch { /* */ }
      }
      return state.handNo >= 2 || state.phase === 'finalizing' || state.phase === 'done';
    },
  });
  const nextHandAt = Date.now();
  assert.ok(hand1DoneAt.t, 'hand 1 did not complete');
  assert.equal(nextHandAt - hand1DoneAt.t < 1_000, true, `next hand waited on training (${nextHandAt - hand1DoneAt.t}ms)`);

  const machine = await waitFor(async () => {
    const snap = await snapshotOf(gameDir);
    return snap?.training?.length ? snap : null;
  }, 'machine training card did not reach UI');
  const first = machine.training[0];
  assert.equal(first.explanation, undefined);
  assert.equal((machine.trainingAnnotations ?? []).length, 0);

  const withExplain = await waitFor(async () => {
    const snap = await snapshotOf(gameDir);
    const ann = (snap.trainingAnnotations ?? []).find((row) => row.field === 'explanation');
    return ann?.status === 'ready' ? snap : null;
  }, 'explanation annotation did not follow', 12_000);
  const filled = (withExplain.trainingAnnotations ?? []).find((row) => row.field === 'explanation');
  assert.equal(filled.status, 'ready');
  assert.equal(withExplain.training[0].payloadSha256, first.payloadSha256);
  await loop.requestStop();
  await running.catch(() => {});
});

test('last-hand kill → finalizing resume publishes machine before cutoff and annotation after', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const evalGate = {};
  evalGate.promise = new Promise((resolve) => { evalGate.release = resolve; });
  const publishes = [];
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_500,
      onPublishInvoke: (args) => publishes.push({ args, envelope: envelopeFromPublishArgs(args), at: Date.now() }),
      training: {
        evaluate: makeEvaluate({ gate: evalGate.promise }),
        explain: makeExplain({ delayMs: 20_000 }),
      },
    },
  });
  t.after(() => first.requestStop().catch(() => {}));
  await first.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 1,
    opponentRuntime: 'policy',
  });
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.phase === 'finalizing',
  });
  await first.requestStop().catch(() => {});
  await running.catch(() => {});

  const logs = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 8_000,
      finalizeCutoffLeadMs: 3_000,
      log: (record) => logs.push(record),
      onPublishInvoke: (args) => publishes.push({ args, envelope: envelopeFromPublishArgs(args), at: Date.now() }),
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain({ delayMs: 20_000 }),
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));
  const state = await resumed.resume();
  assert.equal(state.phase, 'finalizing');
  const finished = await resumed.run();
  assert.notEqual(finished.halt?.code, 'REVIEW_GATE_CLOSED');
  assert.equal(finished.phase, 'done');

  const registerAt = logs.findIndex((row) => row.event === 'training-reconcile-registered');
  const settleStart = logs.findIndex((row) => row.event === 'training-settle-start');
  const settleReturn = logs.findIndex((row) => row.event === 'training-settle-return');
  assert.notEqual(registerAt, -1, 'reconcile did not register training tasks');
  assert.equal(settleStart === -1 || registerAt <= settleStart, true, 'settle started before reconcile registered tasks');
  assert.equal(settleReturn === -1 || registerAt < settleReturn, true, 'settle returned before reconcile registered tasks');

  const machinePubs = publishes.filter((row) => Array.isArray(row.envelope?.training) && row.envelope.training.length);
  const annPubs = publishes.filter((row) => Array.isArray(row.envelope?.trainingAnnotations) && row.envelope.trainingAnnotations.length);
  assert.equal(machinePubs.length, 1);
  assert.ok(annPubs.length >= 1);
  const codes = JSON.stringify(logs.map((row) => row.code).filter(Boolean));
  assert.equal(codes.includes('STALE'), false, codes);
  assert.equal(codes.includes('PLAYTIME_PUBLISH_STOPPED'), false, codes);
  const auth = createTrainingControl().loadAuthority(gameDir);
  const item = Object.values(auth.items)[0];
  assert.ok(item);
  assert.equal(item.annotations.explanation.status, 'unavailable');
});

test('mid-hand kill → playing resume has the same machine-then-annotation shape', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      training: {
        evaluate: makeEvaluate({ delayMs: 30_000 }),
        explain: makeExplain({ delayMs: 30_000 }),
      },
    },
  });
  t.after(() => first.requestStop().catch(() => {}));
  await first.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 2,
    opponentRuntime: 'policy',
  });
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.handNo >= 1 && readJson(path.join(gameDir, 'state.json')).lastHand?.handNo === 1,
  });
  await first.requestStop().catch(() => {});
  await running.catch(() => {});
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).phase, 'playing');

  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain(),
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));
  const state = await resumed.resume();
  assert.equal(state.phase, 'playing');
  startRun(resumed);
  const machine = await waitFor(async () => {
    const snap = await snapshotOf(gameDir);
    return snap?.training?.length ? snap : null;
  }, 'resumed machine card missing');
  assert.equal(machine.training[0].explanation, undefined);
  const explained = await waitFor(async () => {
    const snap = await snapshotOf(gameDir);
    return (snap.trainingAnnotations ?? []).some((row) => row.field === 'explanation' && row.status === 'ready')
      ? snap
      : null;
  }, 'resumed explanation missing');
  assert.equal(explained.training[0].evaluationId, machine.training[0].evaluationId);
  await resumed.requestStop().catch(() => {});
});

test('coach settle and training settle share result-wait cutoff without REVIEW_GATE_CLOSED', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 8_000,
      finalizeCutoffLeadMs: 3_000,
      log: (record) => logs.push(record),
      training: {
        evaluate: makeEvaluate({ delayMs: 200 }),
        explain: makeExplain({ delayMs: 200 }),
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 1,
    opponentRuntime: 'policy',
  });
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => state.phase === 'done' || Boolean(state.halt),
  });
  const finished = await running;
  assert.equal(finished.phase, 'done');
  assert.notEqual(finished.halt?.code, 'REVIEW_GATE_CLOSED');
  const settleEvents = logs.filter((row) => row.event === 'training-settle-start' || row.event === 'finalize-coach-settled');
  assert.ok(settleEvents.length >= 1);
});

test('evaluator fail records pending; resume retries to evaluated', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      training: {
        evaluate: makeEvaluate({ failTimes: 99 }),
        explain: makeExplain(),
      },
    },
  });
  t.after(() => first.requestStop().catch(() => {}));
  await first.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 2,
    opponentRuntime: 'policy',
  });
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.handNo >= 1 && readJson(path.join(gameDir, 'state.json')).lastHand?.handNo === 1,
  });
  await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    return auth && Object.keys(auth.pending ?? {}).length > 0;
  }, 'pending was not recorded');
  await first.requestStop().catch(() => {});
  await running.catch(() => {});

  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain(),
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));
  await resumed.resume();
  startRun(resumed);
  await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    const item = Object.values(auth?.items ?? {})[0];
    return item?.status === 'evaluated' ? item : null;
  }, 'resume did not promote pending to evaluated');
  await resumed.requestStop().catch(() => {});
});

test('server respawn restores training and republish is a no-op', { timeout: 20_000 }, async () => {
  const dir = tmpGame();
  const token = 'tok-restore';
  const gameEpoch = gameEpochOf(token);
  const evaluation = cannedEvaluation('d-1-preflop-0', gameEpoch);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: token,
    lastHand: {
      handNo: 1,
      decisions: [{
        schemaVersion: 1,
        decisionId: 'd-1-preflop-0',
        actorId: 'user',
        street: 'preflop',
        position: 'BTN',
        holeCards: ['Ah', 'Ad'],
        blinds: [50, 100],
        effectiveStack: 10000,
        publicSeats: [],
        priorActions: [],
        chosenAction: { action: 'fold' },
        forced: false,
      }],
    },
  }));
  const started = await startServer({ gameDir: dir, port: 0, token });
  try {
    let publishes = 0;
    const publish = async () => {
      publishes += 1;
      const envelope = pipeline.unpublishedEnvelope(dir, { gameEpoch });
      if (!envelope) return;
      const file = pipeline.writeTrainingEnvelope(dir, envelope);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync(process.execPath, [
        path.join(ROOT, 'tools/publish.js'),
        '--from', file,
        '--game-dir', dir,
      ], { encoding: 'utf8', timeout: 10_000 });
      const tc = createTrainingControl();
      for (const item of envelope.training) {
        await tc.markPublished(dir, item.evaluationId, item.payloadSha256);
      }
    };
    await pipeline.runHandPipeline({
      sessionDir: dir,
      handNo: 1,
      gameEpoch,
      owner: 'owner-1',
      evaluate: () => handleOf({ ok: true, evaluations: [evaluation] }),
      publish,
    });
    assert.equal(publishes >= 1, true);
    const firstSnap = await (await fetch(`http://127.0.0.1:${started.port}/api/snapshot?token=${token}`)).json();
    assert.equal(firstSnap.training.length, 1);
  } finally {
    await started.close();
  }
  const restarted = await startServer({ gameDir: dir, port: 0, token });
  try {
    const snap = await (await fetch(`http://127.0.0.1:${restarted.port}/api/snapshot?token=${token}`)).json();
    assert.equal(snap.training.length, 1);
    const envelope = pipeline.unpublishedEnvelope(dir, { gameEpoch });
    assert.equal(envelope, null);
  } finally {
    await restarted.close();
  }
});

test('unfinished explanation is sealed unavailable and published after cutoff', { timeout: 40_000 }, async (t) => {
  const gameDir = tmpGame();
  const publishes = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: makeCoachAdapter(), notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_000,
      onPublishInvoke: (args) => publishes.push({ envelope: envelopeFromPublishArgs(args) }),
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain({ delayMs: 30_000 }),
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 1,
    opponentRuntime: 'policy',
  });
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => state.phase === 'done' || Boolean(state.halt),
  });
  const finished = await running;
  assert.equal(finished.phase, 'done');
  const auth = createTrainingControl().loadAuthority(gameDir);
  const item = Object.values(auth.items)[0];
  assert.equal(item.annotations.explanation.status, 'unavailable');
  const annPub = publishes.find((row) => row.envelope?.trainingAnnotations?.[0]?.status === 'unavailable');
  assert.ok(annPub);
  const review = fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8');
  assert.match(review, /pending|미완|0/);
});
