import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { createGameLoop } from '../tools/game-loop.js';
import { createSessionManager } from '../tools/session-manager.js';

// R2 (docs: design §11.2): policy/JEV games open the table while the upper-model
// probe runs in the background. These tests pin the safety rules: coach work
// waits for the probe instead of falling back, finalization budgets start only
// after it settles, stop/pause wait for it, and nothing is written after stop.
const SCALE = process.platform === 'win32' ? 10 : 1;
const VALID_REVIEW = [
  '## 내 성향 통계', 'VPIP와 PFR은 참고용 표본으로 해석합니다.',
  '## 결정적 핸드 2~3개 리플레이', '결정 시점의 공개 정보로 과정을 복기합니다.',
  '## 각 AI의 실제 아키타입 공개 + 읽기 평가', '상대 성향을 맞게 읽은 부분과 놓친 부분을 구분합니다.',
  '## 다음 게임에서 연습할 것', '팟 오즈 확인과 포지션별 오픈 범위를 연습합니다.',
].join('\n\n');
const FINALIZE_BUDGET_MS = 8_000 * SCALE;
const RESULT_WAIT_MS = 3_000 * SCALE;
// Published coach note for a hand (what the player actually sees), if any.
const publishedNote = (dir, handNo) => (readJson(path.join(dir, 'ui-snapshot.json')).coach ?? []).find((row) => row.handNo === handNo);
const POLICY_GAME = { ai: 1, mode: 'cash-training', stackBb: 100, blinds: '50/100', opponentRuntime: 'policy' };

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Every test releases its gate in cleanup: stop waits for the owned probe
// promise, so a failed assertion would otherwise hang the run.
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function waitFor(predicate, message, timeoutMs = 15_000 * SCALE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch { /* retry */ }
    await sleep(20);
  }
  assert.fail(message);
}

function coachUpper({ coachDelayMs = 0 } = {}) {
  const starts = [];
  const coachHands = [];
  let disposed = 0;
  return {
    kind: 'coach-fake',
    starts,
    coachHands,
    get disposed() { return disposed; },
    disposeConfirmsChildren: true,
    oneshotStart(input) {
      const stage = input.prompt.includes('역할: 격리 evaluator') ? 'evaluator'
        : input.prompt.includes('역할: 종합자') ? 'synthesizer'
        : input.prompt.includes('역할: 학습 해설') ? 'explain' : 'coach';
      const handNo = Number(/hand (\d+) \(redacted\):/.exec(input.prompt)?.[1] ?? 1);
      starts.push(stage);
      if (stage === 'coach') coachHands.push(handNo);
      const raw = stage === 'evaluator' ? '표본 30핸드 미만이므로 참고용입니다. 공개 정보 기준 과정 평가는 안정적이었습니다.'
        : stage === 'synthesizer' ? VALID_REVIEW
        : stage === 'explain' ? '{}' : JSON.stringify({ handNo, text: '기본 코치 응답' });
      const done = stage === 'coach' && coachDelayMs > 0 ? sleep(coachDelayMs).then(() => ({ raw })) : Promise.resolve({ raw });
      return { pid: 930_000 + starts.length, startTime: `r2-${starts.length}`, done, async terminate() { return { confirmed: true }; } };
    },
    async dispose() { disposed += 1; },
  };
}

// Plays the human seat (check or fold) until `isDone()`. `actedHands` collects
// the hands where the human really decided (only those get a coach note).
function driveHuman(gameDir, isDone, actedHands = new Set()) {
  const sent = new Set();
  return (async () => {
    while (!isDone()) {
      try {
        const lock = readJson(path.join(gameDir, 'lock.json'));
        const base = `http://127.0.0.1:${lock.port}`;
        const snapshot = await (await fetch(`${base}/api/snapshot?token=${lock.sessionToken}`)).json();
        const legal = snapshot.view?.legal;
        if (legal?.toAct === 'user' && !sent.has(legal.decisionId)) {
          sent.add(legal.decisionId);
          if (Number.isSafeInteger(snapshot.view?.handNo)) actedHands.add(snapshot.view.handNo);
          await fetch(`${base}/api/action?token=${lock.sessionToken}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decisionId: legal.decisionId, action: legal.canCheck ? 'check' : 'fold' }),
          });
        }
      } catch { /* server restarting or terminal */ }
      await sleep(20);
    }
  })();
}

test('R2: the table opens before the probe; coach notes and finalization wait for it without spending the budget', { timeout: 180_000 * SCALE }, async (t) => {
  const gameDir = createOwnedTempDir('holdem-r2-coach');
  const gate = deferred();
  // Each coach note takes longer than the last hand's result-wait window, so a
  // backlog squeezed into that window would be sealed unavailable.
  const upper = coachUpper({ coachDelayMs: RESULT_WAIT_MS + 1_000 });
  const events = [];
  const records = [];
  let resolverCalls = 0;
  const loop = createGameLoop({
    gameDir,
    resolver: async ({ need }) => {
      resolverCalls += 1;
      assert.equal(need, 'upper-only');
      await gate.promise;
      return { player: null, upper, notices: ['r2 resolver notice'] };
    },
    opts: {
      port: 0, waitMs: 40, opponentRuntime: 'policy',
      // The probe below outlives this whole finalization budget; if waiting for it
      // spent the budget, finalization would abort. The result-wait share stays
      // roomy so a loaded machine still settles both coach notes before cutoff.
      finalizeBudgetMs: FINALIZE_BUDGET_MS, finalizeCutoffLeadMs: FINALIZE_BUDGET_MS - RESULT_WAIT_MS,
      log: (record) => { events.push(record.event); records.push(record); },
    },
  });
  t.after(() => { gate.resolve(); return loop.requestStop().catch(() => {}); });
  const booted = await loop.bootstrap({ ...POLICY_GAME, hands: 5 });
  assert.equal(booted.phase, 'playing');
  assert.equal(booted.upperRuntime, null);
  assert.equal(resolverCalls, 1);
  assert.equal(loop.upperStatus, 'probing');

  let finished = false;
  const running = loop.run().finally(() => { finished = true; });
  running.catch(() => {});
  const acted = new Set();
  const driver = driveHuman(gameDir, () => finished, acted);
  await waitFor(() => readJson(path.join(gameDir, 'state.json')).gameOver === true, 'the game did not finish');
  await sleep(FINALIZE_BUDGET_MS + 500);
  const waiting = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(waiting.phase, 'playing', 'finalization must not begin before the probe settles');
  assert.equal(waiting.finalization, undefined);
  assert.deepEqual(upper.starts, [], 'no coach generation before the upper adapter exists');
  assert.equal(loop.upperStatus, 'probing');
  assert.equal(loop.pauseProgress.resolver, true);

  gate.resolve();
  const done = await running;
  await driver;
  assert.equal(done.phase, 'done', JSON.stringify(done.halt ?? null));
  // Every hand before the last one where the human decided waited on the probe;
  // each must end with the LLM note, not the unavailable seal.
  const backlog = [...acted].filter((handNo) => handNo < 5);
  assert.ok(backlog.length > 0, 'the human decided in at least one earlier hand');
  for (const handNo of backlog) {
    const note = publishedNote(gameDir, handNo);
    assert.ok(note && !note.unavailable && /기본 코치 응답/.test(note.text ?? ''),
      `hand ${handNo} note: ${JSON.stringify({ note, records: records.filter((r) => /coach|upper|final/.test(r.event)).slice(-20) })}`);
  }
  assert.ok(done.notices.includes('r2 resolver notice'));
  assert.equal(done.notices.some((notice) => notice.includes('고정 코치 문구')), false);
  assert.equal(done.upperRuntime, 'coach-fake');
  assert.match(fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8'), /## 내 성향 통계/);
  assert.ok(events.indexOf('upper-resolved') !== -1);
  assert.ok(events.indexOf('upper-resolved') < events.indexOf('finalize-start'));
});

test('R2: a failing background probe falls back to machine feedback and the game still finishes', { timeout: 60_000 * SCALE }, async (t) => {
  const gameDir = createOwnedTempDir('holdem-r2-fail');
  const gate = deferred();
  const loop = createGameLoop({
    gameDir,
    resolver: async () => { await gate.promise; throw Object.assign(new Error('probe crashed'), { code: 'PROBE_CRASHED' }); },
    opts: { port: 0, waitMs: 40, opponentRuntime: 'policy' },
  });
  t.after(() => { gate.resolve(); return loop.requestStop().catch(() => {}); });
  await loop.bootstrap({ ...POLICY_GAME, hands: 1 });
  gate.resolve();
  await waitFor(() => loop.upperStatus === 'unavailable', 'probe failure did not settle');
  let finished = false;
  const running = loop.run().finally(() => { finished = true; });
  running.catch(() => {});
  const driver = driveHuman(gameDir, () => finished);
  const done = await running;
  await driver;
  assert.equal(done.phase, 'done', JSON.stringify(done.halt ?? null));
  assert.ok(done.notices.some((notice) => notice.startsWith('상위 모델 런타임이 없습니다')));
  assert.equal(done.upperRuntime, null);
  assert.match(fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8'), /LLM.*설명.*제공할 수 없/);
});

test('R2: stop waits for the background probe, then writes nothing and closes the late adapter', { timeout: 30_000 * SCALE }, async (t) => {
  const gameDir = createOwnedTempDir('holdem-r2-stop');
  const gate = deferred();
  const upper = coachUpper();
  const loop = createGameLoop({
    gameDir,
    resolver: async () => { await gate.promise; return { player: null, upper, notices: ['late notice'] }; },
    opts: { port: 0, waitMs: 40, opponentRuntime: 'policy' },
  });
  t.after(() => { gate.resolve(); return loop.requestStop().catch(() => {}); });
  await loop.bootstrap({ ...POLICY_GAME, hands: 1 });
  let stopped = false;
  const stopping = loop.requestStop().then(() => { stopped = true; });
  await sleep(150);
  assert.equal(stopped, false, 'stop must wait for the owned probe promise');
  gate.resolve();
  await stopping;
  const after = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(after.upperRuntime ?? null, null);
  assert.equal((after.notices ?? []).includes('late notice'), false);
  assert.equal(upper.disposed, 1, 'an adapter that arrives after stop is still disposed');
  const bytes = fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8');
  await sleep(150);
  assert.equal(fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8'), bytes, 'no write after stop');
});

test('R2: pause waits for the probe, reports it, and stays frozen once paused', { timeout: 60_000 * SCALE }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-r2-pause');
  const gate = deferred();
  const seen = [];
  const manager = createSessionManager({
    storeDir,
    resolver: async () => { await gate.promise; return { player: null, upper: null, notices: ['paused probe notice'] }; },
    onChange: (snap) => seen.push(snap),
  });
  t.after(() => { gate.resolve(); return manager.close(); });
  await manager.initialize();
  const cas = (kind) => {
    const s = manager.snapshot();
    return { requestId: randomUUID(), expectedInstanceId: s.instanceId, expectedAppRevision: s.appRevision,
      expectedGameId: s.gameId, expectedSelectionVersion: s.selectionVersion, kind };
  };
  const settle = async (id) => waitFor(() => { const row = manager.receipt(id); return row.status !== 'accepted' ? row : null; }, 'receipt');
  const startedAt = Date.now();
  const start = { ...cas('start'), setup: { mode: 'cash-training', aiCount: 5, opponentRuntime: 'policy', hints: 'off', dealBias: 'off' } };
  manager.command(start);
  assert.equal((await settle(start.requestId)).status, 'succeeded');
  await waitFor(() => manager.snapshot().state === 'playing', 'playing');
  assert.ok(Date.now() - startedAt < 15_000 * SCALE, 'the table opens while the probe is still running');
  assert.equal(manager.snapshot().upperStatus, 'probing');

  const pause = cas('pause');
  manager.command(pause);
  const pausing = await waitFor(() => {
    const snap = manager.snapshot();
    return snap.state === 'pausing' && snap.pausing?.waitingFor?.resolver === true ? snap : null;
  }, 'pausing did not report the probe');
  assert.equal(typeof pausing.pausing.since, 'string');
  await sleep(300);
  assert.equal(manager.snapshot().state, 'pausing', 'pause cannot complete while the probe is open');
  gate.resolve();
  assert.equal((await settle(pause.requestId)).status, 'succeeded');
  assert.equal(manager.snapshot().state, 'paused');
  assert.equal(manager.snapshot().upperStatus, 'unavailable');
  const loopState = path.join(manager.current.sessionDir, 'loop-state.json');
  const frozen = fs.readFileSync(loopState, 'utf8');
  assert.ok(JSON.parse(frozen).notices.includes('paused probe notice'), 'the merge happened before paused');
  await sleep(300);
  assert.equal(fs.readFileSync(loopState, 'utf8'), frozen, 'paused means no loop-state writes');
  const end = cas('end');
  manager.command(end);
  assert.equal((await settle(end.requestId)).status, 'succeeded');
});

test('R2: a completed hand whose coach waits on the probe survives a pause and gets its LLM note after resume', { timeout: 90_000 * SCALE }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-r2-pause-coach');
  const gate = deferred();
  const upper = coachUpper();
  const manager = createSessionManager({
    storeDir,
    resolver: async () => { await gate.promise; return { player: null, upper, notices: [] }; },
  });
  t.after(() => { gate.resolve(); return manager.close(); });
  await manager.initialize();
  const cas = (kind) => {
    const s = manager.snapshot();
    return { requestId: randomUUID(), expectedInstanceId: s.instanceId, expectedAppRevision: s.appRevision,
      expectedGameId: s.gameId, expectedSelectionVersion: s.selectionVersion, kind };
  };
  const settle = async (id) => waitFor(() => { const row = manager.receipt(id); return row.status !== 'accepted' ? row : null; }, 'receipt');
  const start = { ...cas('start'), setup: { mode: 'cash-training', aiCount: 1, hands: 20, opponentRuntime: 'policy', hints: 'off', dealBias: 'off', pace: 'instant' } };
  manager.command(start);
  assert.equal((await settle(start.requestId)).status, 'succeeded');
  await waitFor(() => manager.snapshot().state === 'playing', 'playing');
  const sessionDir = manager.current.sessionDir;
  let stopDriving = false;
  const acted = new Set();
  const driver = driveHuman(sessionDir, () => stopDriving, acted);
  // A hand where the human decided is over (the engine moved past it) while the
  // probe is still open.
  const coachedHand = await waitFor(() => {
    const current = readJson(path.join(sessionDir, 'state.json')).handNo;
    return [...acted].find((handNo) => handNo < current) ?? null;
  }, 'a completed hand with a human decision');
  stopDriving = true;
  await driver;
  assert.equal(manager.snapshot().upperStatus, 'probing');

  const pause = cas('pause');
  manager.command(pause);
  await waitFor(() => manager.snapshot().pausing?.waitingFor?.resolver === true, 'pausing waits for the probe');
  // The lobby shows `pausing` before the loop raises its pause flag; release the
  // probe only once the loop itself is pausing (the control write precedes the
  // flag in the same continuation).
  await waitFor(() => manager.session?.loop.playState === 'pausing', 'loop pause flag');
  gate.resolve();
  assert.equal((await settle(pause.requestId)).status, 'succeeded');
  assert.equal(manager.snapshot().state, 'paused');
  assert.deepEqual(upper.coachHands, [], `no coach generation starts while paused\n${fs.readFileSync(path.join(sessionDir, 'loop.log'), 'utf8').split('\n').filter((line) => /coach-debug|upper-resolved|pause|hand/.test(line)).slice(-30).join('\n')}`);
  const frozenFiles = ['loop-state.json', '.coach-authority.json', 'ui-snapshot.json']
    .map((name) => path.join(sessionDir, name)).filter((file) => fs.existsSync(file));
  const frozen = frozenFiles.map((file) => fs.readFileSync(file, 'utf8'));
  await sleep(400);
  assert.deepEqual(frozenFiles.map((file) => fs.readFileSync(file, 'utf8')), frozen, 'paused means no loop, coach or publish writes');

  const resume = cas('resume');
  manager.command(resume);
  assert.equal((await settle(resume.requestId)).status, 'succeeded');
  try {
    await waitFor(() => {
      const note = publishedNote(sessionDir, coachedHand);
      return note && !note.unavailable && /기본 코치 응답/.test(note.text ?? '');
    }, `hand ${coachedHand} LLM coach note published after resume`, 15_000 * SCALE);
  } catch (error) {
    const log = fs.readFileSync(path.join(sessionDir, 'loop.log'), 'utf8').split('\n').filter((line) => /coach|upper|pause|resume|hand-/.test(line)).slice(-40);
    throw new Error(`${error.message}\n${JSON.stringify({ starts: upper.starts, notices: readJson(path.join(sessionDir, 'loop-state.json')).notices })}\n${log.join('\n')}`);
  }
  const pause2 = cas('pause');
  manager.command(pause2);
  assert.equal((await settle(pause2.requestId)).status, 'succeeded');
  const end = cas('end');
  manager.command(end);
  assert.equal((await settle(end.requestId)).status, 'succeeded');
});

test('the pause barrier drains follow-up work registered while it waits', async () => {
  const { settleUntilIdle } = await import('../tools/game-loop.js');
  const tasks = new Set();
  const track = (promise) => { tasks.add(promise); promise.finally(() => tasks.delete(promise)); return promise; };
  const order = [];
  let releaseSolve;
  // An evaluation that, once done, registers its solve — after the barrier's
  // first snapshot was taken.
  track((async () => {
    await sleep(20);
    order.push('evaluate');
    track(new Promise((resolve) => { releaseSolve = resolve; }).then(() => order.push('solve')));
  })());
  let idle = false;
  const barrier = settleUntilIdle(() => [...tasks]).then(() => { idle = true; });
  await sleep(80);
  assert.equal(idle, false, 'a single snapshot would already be idle here');
  releaseSolve();
  await barrier;
  assert.deepEqual(order, ['evaluate', 'solve']);
  // A stop between rounds ends the drain instead of waiting on the next round.
  let rounds = 0;
  const leftover = new Promise(() => {});
  await settleUntilIdle(() => (rounds++ === 0 ? [Promise.resolve()] : [leftover]), () => rounds > 1);
  assert.equal(rounds, 2);
});

test('a pause that lands after the coach reserved keeps that reservation and runs it on resume', { timeout: 60_000 * SCALE }, async (t) => {
  const gameDir = createOwnedTempDir('holdem-coach-reserved-pause');
  const upper = coachUpper();
  let loop;
  let pausedAtSpawn = null;
  loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper, notices: [] }),
    opts: {
      port: 0, waitMs: 40, opponentRuntime: 'policy', controlProtocolVersion: 1,
      // The first coach reaching its spawn point triggers a real pause and waits
      // until the loop is pausing, so the reserved coach must stop before spawning.
      coachSpawnCheckpoint: async ({ handNo, attempt }) => {
        if (pausedAtSpawn !== null) return {};
        pausedAtSpawn = { handNo, attempt, pause: loop.pause() };
        pausedAtSpawn.pause.catch(() => {});
        await waitFor(() => loop.playState === 'pausing', 'loop pausing');
        return {};
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ...POLICY_GAME, hands: 20 });
  await waitFor(() => loop.upperStatus === 'ready', 'upper resolved');
  let finished = false;
  const running = loop.run().finally(() => { finished = true; });
  running.catch(() => {});
  const driver = driveHuman(gameDir, () => finished || pausedAtSpawn !== null);
  await waitFor(() => pausedAtSpawn !== null, 'a coach reached its spawn point', 30_000 * SCALE);
  assert.equal((await pausedAtSpawn.pause).state, 'paused');
  await driver;
  assert.deepEqual(upper.coachHands, [], 'the reserved coach did not spawn while pausing');
  const authority = path.join(gameDir, '.coach-authority.json');
  const frozen = fs.readFileSync(authority, 'utf8');
  await sleep(300);
  assert.equal(fs.readFileSync(authority, 'utf8'), frozen, 'paused keeps the coach authority unchanged');
  await loop.resumePlay();
  await waitFor(() => {
    const note = publishedNote(gameDir, pausedAtSpawn.handNo);
    return note && !note.unavailable && /기본 코치 응답/.test(note.text ?? '');
  }, `hand ${pausedAtSpawn.handNo} LLM note after resume`, 20_000 * SCALE);
});
