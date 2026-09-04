// 이 파일의 통합 테스트는 실제 사이드카·서버·엔진 자식 프로세스를 띄운다. GitHub 러너에서
// 같은 테스트의 실측 소요가 6.2s / 12.0s / 39.75s로 흔들렸고(마지막은 40s 예산에 250ms 남기고
// 통과), 그 다음 두 번은 40.5s·64.2s로 예산을 넘겨 실패했다. 바깥 timeout은 멈춘 테스트를
// 끊는 안전망일 뿐 성능 계약이 아니다 — 계약은 각 waitFor 예산과 "다음 핸드 < 1s" 단언이며
// 그 둘은 그대로다. 관측된 5배 변동을 덮도록 안전망만 넓힌다.
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
const VALID_EXPLAIN = 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.';

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tasync-'));
}

function putUserOnTheButton(gameDir) {
  const statePath = path.join(gameDir, 'state.json');
  const state = readJson(statePath);
  const userIdx = state.seats.findIndex((seat) => seat.playerId === 'user');
  state.button = (userIdx + state.seats.length - 1) % state.seats.length;
  fs.writeFileSync(statePath, JSON.stringify(state));
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
  let lock;
  try {
    lock = readJson(path.join(gameDir, 'lock.json'));
  } catch {
    return null;
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
    );
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
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

function handRecord(sessionDir, handNo) {
  const state = readJson(path.join(sessionDir, 'state.json'));
  if (state.lastHand?.handNo === handNo) return state.lastHand;
  try {
    return JSON.parse(fs.readFileSync(
      path.join(sessionDir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`),
      'utf8',
    ));
  } catch {
    return null;
  }
}

function userDecisions(sessionDir, handNo) {
  return (handRecord(sessionDir, handNo)?.decisions ?? []).filter((snap) => snap.actorId === 'user');
}

function userDecision(sessionDir, handNo) {
  return userDecisions(sessionDir, handNo)[0] ?? null;
}

function handleOf(result, { delayMs = 0, gate = null, onTerminate, terminateResult = { confirmed: true } } = {}) {
  let timer = null;
  let cancelled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
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
      resolvePromise?.({ ok: false, code: 'TERMINATED' });
      onTerminate?.();
      return typeof terminateResult === 'function' ? terminateResult() : terminateResult;
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
      const snaps = userDecisions(sessionDir, handNo);
      if (!snaps.length) return { ok: false, code: 'NO_DECISION' };
      return {
        ok: true,
        evaluations: snaps.map((snap) => cannedEvaluation(snap.decisionId, gameEpochOf(state.sessionToken))),
      };
    }, { delayMs: delayMs || 40, gate });
  };
}

function makeExplain({ delayMs = 0, gate = null, calls, text = VALID_EXPLAIN, terminateResult } = {}) {
  const log = calls ?? [];
  return (evaluation) => {
    log.push(evaluation?.evaluationId ?? null);
    return handleOf(text, { delayMs, gate, terminateResult });
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

test('turn loop does not wait on training; machine UI arrives before explanation', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const explainCalls = [];
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  putUserOnTheButton(gameDir);
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

  await waitFor(() => (
    Object.values(createTrainingControl().loadAuthority(gameDir)?.items ?? {})[0] ?? null
  ), 'machine training item was not accepted', 8_000);
  const machine = await waitFor(async () => {
    const snap = await snapshotOf(gameDir);
    return snap?.training?.length ? snap : null;
  }, 'machine training card did not reach UI', 12_000);
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

test('last-hand kill → finalizing resume publishes machine before cutoff and annotation after', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const evalGate = {};
  evalGate.promise = new Promise((resolve) => { evalGate.release = resolve; });
  const publishes = [];
  const ordered = [];
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_500,
      onPublishInvoke: (args) => {
        const envelope = envelopeFromPublishArgs(args);
        const kind = Array.isArray(envelope?.training) && envelope.training.length
          ? 'machine'
          : Array.isArray(envelope?.trainingAnnotations) && envelope.trainingAnnotations.length
            ? 'annotation'
            : 'other';
        publishes.push({ args, envelope, kind, at: Date.now() });
        if (kind === 'machine' || kind === 'annotation') ordered.push(kind);
      },
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.phase === 'finalizing',
  });
  await first.requestStop().catch(() => {});
  await running.catch(() => {});

  const logs = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 8_000,
      finalizeCutoffLeadMs: 3_000,
      log: (record) => {
        logs.push(record);
        if (record.event === 'training-cutoff-marker') ordered.push('cutoff');
      },
      onPublishInvoke: (args) => {
        const envelope = envelopeFromPublishArgs(args);
        const kind = Array.isArray(envelope?.training) && envelope.training.length
          ? 'machine'
          : Array.isArray(envelope?.trainingAnnotations) && envelope.trainingAnnotations.length
            ? 'annotation'
            : 'other';
        publishes.push({ args, envelope, kind, at: Date.now() });
        if (kind === 'machine' || kind === 'annotation') ordered.push(kind);
      },
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

  const machinePubs = publishes.filter((row) => row.kind === 'machine');
  const annPubs = publishes.filter((row) => row.kind === 'annotation');
  assert.equal(machinePubs.length, 1, `expected exactly one machine publish, got ${machinePubs.length}`);
  assert.ok(annPubs.length >= 1, 'expected annotation publish after cutoff');
  const cutoffAt = ordered.indexOf('cutoff');
  const machineAt = ordered.indexOf('machine');
  const annAt = ordered.indexOf('annotation');
  assert.notEqual(cutoffAt, -1, 'cutoff marker was not logged');
  assert.equal(machineAt !== -1 && machineAt < cutoffAt, true, `machine publish was not before cutoff: ${ordered.join(',')}`);
  assert.equal(annAt !== -1 && annAt > cutoffAt, true, `annotation publish was not after cutoff: ${ordered.join(',')}`);

  const codes = JSON.stringify(logs.map((row) => row.code).filter(Boolean));
  assert.equal(codes.includes('STALE'), false, codes);
  assert.equal(codes.includes('PLAYTIME_PUBLISH_STOPPED'), false, codes);
  const auth = createTrainingControl().loadAuthority(gameDir);
  const item = Object.values(auth.items)[0];
  assert.ok(item);
  assert.equal(item.status, 'published');
  assert.equal(item.annotations.explanation.status, 'unavailable');
});

test('mid-hand kill → playing resume has the same machine-then-annotation shape', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.handNo >= 1 && readJson(path.join(gameDir, 'state.json')).lastHand?.handNo === 1,
  });
  await first.requestStop().catch(() => {});
  await running.catch(() => {});
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).phase, 'playing');

  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  const item = await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    return Object.values(auth?.items ?? {})[0] ?? null;
  }, 'resumed machine item missing', 12_000);
  assert.equal(item.summary.explanation, undefined);
  const explained = await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    const live = Object.values(auth?.items ?? {})[0];
    return live?.annotations?.explanation?.status === 'ready' ? live : null;
  }, 'resumed explanation missing', 12_000);
  assert.equal(explained.evaluationId, item.evaluationId);
  await resumed.requestStop().catch(() => {});
});

test('coach settle and training settle share result-wait cutoff without REVIEW_GATE_CLOSED', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const logs = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => state.phase === 'done' || Boolean(state.halt),
  });
  const finished = await running;
  assert.equal(finished.phase, 'done');
  assert.notEqual(finished.halt?.code, 'REVIEW_GATE_CLOSED');
  const settleEvents = logs.filter((row) => row.event === 'training-settle-start' || row.event === 'finalize-coach-settled');
  assert.ok(settleEvents.length >= 1);
});

test('evaluator fail records pending; resume retries to evaluated', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(first, gameDir, {
    until: (state) => state.handNo >= 1 && readJson(path.join(gameDir, 'state.json')).lastHand?.handNo === 1,
  });
  await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    return auth && Object.keys(auth.pending ?? {}).length > 0;
  }, 'pending was not recorded');
  await first.requestStop().catch(() => {});
  await running.catch(() => {});

  const resumeLogs = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      log: (record) => resumeLogs.push(record),
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain(),
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));
  const resumedState = await resumed.resume();
  const resumedAuthority = createTrainingControl().loadAuthority(gameDir);
  assert.equal(resumedAuthority.ownerSessionId, resumedState.ownerSessionId);
  const ownerTransferAt = resumeLogs.findIndex((row) => row.event === 'training-owner-transferred');
  const reconcileAt = resumeLogs.findIndex((row) => row.event === 'training-reconcile-registered');
  assert.notEqual(ownerTransferAt, -1, 'no-store resume did not transfer training owner');
  assert.equal(ownerTransferAt < reconcileAt, true, 'no-store reconcile started before owner transfer');
  startRun(resumed);
  await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    const item = Object.values(auth?.items ?? {})[0];
    return item?.status === 'evaluated' || item?.status === 'published' ? item : null;
  }, 'resume did not promote pending to evaluated', 15_000);
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

test('unfinished explanation is sealed unavailable and published after cutoff', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const publishes = [];
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => state.phase === 'done' || Boolean(state.halt),
  });
  const finished = await running;
  assert.equal(finished.phase, 'done');
  const item = await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    return Object.values(auth?.items ?? {})[0] ?? null;
  }, 'unfinished explanation had no training item');
  assert.equal(item.annotations.explanation.status, 'unavailable');
  // exploit annotation(P1-5)이 같은 봉투에 먼저 실릴 수 있으므로 인덱스가 아니라
  // field로 찾는다. 단언 대상은 그대로 "미완 해설이 unavailable로 게시된다"이다.
  const annPub = publishes.find((row) => row.envelope?.trainingAnnotations
    ?.some((entry) => entry.field === 'explanation' && entry.status === 'unavailable'));
  assert.ok(annPub);
  const review = fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8');
  assert.match(review, /pending|미완|0/);
});

test('cutoff-marker write failure stops finalization before late ready seal', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const coachCalls = [];
  let releaseExplain;
  const explainGate = new Promise((resolve) => { releaseExplain = resolve; });
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_000,
      onCoachInvoke: (args) => coachCalls.push(args[0]),
      training: {
        evaluate: makeEvaluate(),
        explain: () => ({
          promise: explainGate.then(() => VALID_EXPLAIN),
          async terminate() {
            return { confirmed: false };
          },
        }),
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
  fs.mkdirSync(path.join(gameDir, 'training', '.cutoff'), { recursive: true });
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => Boolean(state.halt) || state.phase === 'done',
  });
  const finished = await running.catch((error) => error);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  const haltCode = finished?.code ?? loopState.halt?.code;
  assert.equal(haltCode, 'FINALIZATION_ABORTED');
  assert.notEqual(haltCode, 'REVIEW_GATE_CLOSED');
  assert.equal(coachCalls.includes('finalize-cutoff'), false, 'finalize-cutoff ran after marker write failure');
  assert.notEqual(loopState.phase, 'done');
  releaseExplain();
  const item = await waitFor(() => {
    const auth = createTrainingControl().loadAuthority(gameDir);
    return Object.values(auth?.items ?? {})[0] ?? null;
  }, 'training item missing after marker write failure');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sealed = createTrainingControl().loadAuthority(gameDir)?.items?.[item.evaluationId];
  const explanationStatus = sealed?.annotations?.explanation?.status;
  assert.equal(explanationStatus === undefined || explanationStatus === 'ready', true);
  assert.notEqual(explanationStatus, 'unavailable');
  const cutoff = path.join(gameDir, 'training', '.cutoff');
  assert.equal(fs.existsSync(cutoff) && fs.lstatSync(cutoff).isFile(), false);
});

test('cutoff-marker write failure still fail-closed when terminate throws', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const coachCalls = [];
  let releaseExplain;
  const explainGate = new Promise((resolve) => { releaseExplain = resolve; });
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_000,
      onCoachInvoke: (args) => coachCalls.push(args[0]),
      training: {
        evaluate: makeEvaluate(),
        explain: () => ({
          promise: explainGate.then(() => VALID_EXPLAIN),
          async terminate() {
            const error = new Error('terminate failed');
            error.code = 'TERMINATE_FAILED';
            throw error;
          },
        }),
      },
    },
  });
  t.after(() => {
    releaseExplain();
    return loop.requestStop().catch(() => {});
  });
  await loop.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 1,
    opponentRuntime: 'policy',
  });
  fs.mkdirSync(path.join(gameDir, 'training', '.cutoff'), { recursive: true });
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => Boolean(state.halt) || state.phase === 'done',
  });
  const finished = await running.catch((error) => error);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  const haltCode = finished?.code ?? loopState.halt?.code;
  assert.equal(haltCode, 'FINALIZATION_ABORTED');
  assert.equal(coachCalls.includes('finalize-cutoff'), false, 'finalize-cutoff ran after terminate throw');
  assert.notEqual(loopState.phase, 'done');
  releaseExplain();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const auth = createTrainingControl().loadAuthority(gameDir);
  const item = Object.values(auth?.items ?? {})[0];
  const explanationStatus = item?.annotations?.explanation?.status;
  assert.equal(explanationStatus === undefined || explanationStatus === 'ready', true);
  assert.notEqual(explanationStatus, 'unavailable');
  const cutoff = path.join(gameDir, 'training', '.cutoff');
  assert.equal(fs.existsSync(cutoff) && fs.lstatSync(cutoff).isFile(), false);
});

test('unconfirmed training child terminate fails closed', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      finalizeBudgetMs: 6_000,
      finalizeCutoffLeadMs: 2_000,
      training: {
        evaluate: makeEvaluate(),
        explain: makeExplain({ delayMs: 30_000, terminateResult: { confirmed: false } }),
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
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(loop, gameDir, {
    until: (state) => Boolean(state.halt) || state.phase === 'done',
  });
  const finished = await running.catch((error) => error);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  const haltCode = finished?.code ?? loopState.halt?.code;
  assert.equal(haltCode, 'FINALIZATION_ABORTED');
  assert.notEqual(loopState.phase, 'done');
  assert.equal(loopState.finalization?.cutoff?.terminationConfirmed, false);
});

test('resume of a published last hand does not re-evaluate', { timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const first = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  t.after(() => first.requestStop().catch(() => {}));
  await first.bootstrap({
    ai: 1,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 2,
    opponentRuntime: 'policy',
  });
  putUserOnTheButton(gameDir);
  const { running } = await playUntil(first, gameDir, {
    until: () => {
      const auth = createTrainingControl().loadAuthority(gameDir);
      const items = Object.values(auth?.items ?? {});
      if (!items.length) return false;
      const handNo = items[0].handNo;
      const handItems = items.filter((item) => item.handNo === handNo);
      let snaps = [];
      try { snaps = userDecisions(gameDir, handNo); } catch { /* archive may lag */ }
      if (snaps.length && handItems.length < snaps.length) return false;
      return handItems.every((item) => (
        (item.status === 'published' || item.status === 'evaluated')
        && (item.annotations?.explanation?.status === 'ready'
          || item.annotations?.explanation?.status === 'unavailable')
      ));
    },
  });
  await first.requestStop().catch(() => {});
  await running.catch(() => {});
  const publishedHandNo = Object.values(createTrainingControl().loadAuthority(gameDir)?.items ?? {})[0]?.handNo;
  const resumeCalls = [];
  const resumed = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      trainingEnabled: true,
      training: {
        evaluate: makeEvaluate({ calls: resumeCalls }),
        explain: makeExplain(),
      },
    },
  });
  t.after(() => resumed.requestStop().catch(() => {}));
  await resumed.resume();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const reevals = resumeCalls.filter((row) => row.handNo === publishedHandNo);
  assert.equal(
    reevals.length,
    0,
    `published last hand ${publishedHandNo} was re-evaluated (${JSON.stringify(resumeCalls)})`,
  );
  await resumed.requestStop().catch(() => {});
});
