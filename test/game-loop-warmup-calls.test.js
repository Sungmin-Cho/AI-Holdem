// #312: 게임 시작·재개 warmup도 호출별 기록(`player-call`)과 묶음 기록(`player-warmup-batch`)을 남기고,
// warmup·결정 기록에 어댑터가 관측한 구간 시각(`timing`)을 싣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGameLoop } from '../tools/game-loop.js';
import { WARMUP_TIMEOUT_MS } from '../tools/player-runtime.js';
import {
  WIN32_SCALE,
  initGame,
  makeAdapter,
  putAiFirst,
  readLoopLog,
  resolverFor,
  startRun,
  stopRun,
  tmpGame,
  waitForUserSnapshot,
  writeLoopStateFixture,
} from './helpers/game-loop-fixtures.mjs';

const TIMING = Object.freeze({
  bootMs: 210, turnStartMs: 260, turnEndMs: 4100, signalMs: null, exitMs: 4400, closeMs: 4420,
  turnMs: 3840, censored: false, exitToCloseMs: 20,
});

function withTimingAdapter(options = {}) {
  const adapter = makeAdapter(options);
  const warmup = adapter.warmup.bind(adapter);
  adapter.warmup = async (input) => ({ ...(await warmup(input)), timing: { ...TIMING } });
  return adapter;
}

const warmupCalls = (gameDir, purpose) => readLoopLog(gameDir)
  .filter((entry) => entry.event === 'player-call' && entry.purpose === purpose);
const batches = (gameDir) => readLoopLog(gameDir).filter((entry) => entry.event === 'player-warmup-batch');

test('#312 start warmups log one player-call per AI seat with one shared batch and the applied cap', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const adapter = withTimingAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());
  await loop.bootstrap({ ai: 3, stack: 100 });

  assert.equal(adapter.maxInFlight, 3, 'start warmups still run in parallel');
  assert.deepEqual(adapter.calls.map((call) => call.timeoutMs), [WARMUP_TIMEOUT_MS, WARMUP_TIMEOUT_MS, WARMUP_TIMEOUT_MS]);
  const calls = warmupCalls(gameDir, 'start-warmup');
  assert.equal(calls.length, 3);
  const batchId = calls[0].batch.id;
  assert.equal(typeof batchId, 'string');
  assert.deepEqual(calls.map((entry) => entry.batch.index).sort(), [0, 1, 2]);
  for (const entry of calls) {
    assert.deepEqual(entry.batch, { id: batchId, size: 3, index: entry.batch.index });
    assert.equal(entry.timeoutMs, WARMUP_TIMEOUT_MS);
    assert.equal(entry.code, 'RESPONSE_RECEIVED');
    assert.equal(entry.category, 'response');
    assert.equal(entry.censored, false);
    assert.equal(entry.decisionId, null);
    assert.equal(entry.generation, null);
    assert.equal(entry.runtime, 'fake');
    assert.ok(Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0);
    assert.deepEqual(entry.timing, TIMING);
  }
  const [batch] = batches(gameDir);
  assert.equal(batches(gameDir).length, 1);
  assert.equal(batch.purpose, 'start-warmup');
  assert.equal(batch.batchId, batchId);
  assert.equal(batch.size, 3);
  assert.equal(batch.answered, 3);
  assert.equal(batch.failed, 0);
  assert.deepEqual(batch.codes, {});
  assert.ok(Number.isFinite(batch.wallMs) && batch.wallMs >= 0);
  // 기록에는 세션 id·프롬프트가 실리지 않는다.
  const text = fs.readFileSync(path.join(gameDir, 'loop.log'), 'utf8');
  assert.doesNotMatch(text, /session-p1|session-p2|session-p3/);
});

test('#312 a failed start warmup is logged with its code, category and timing; the batch counts it', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const adapter = makeAdapter();
  const warmup = adapter.warmup.bind(adapter);
  adapter.warmup = async (input) => {
    if (input.playerId === 'p2') {
      adapter.calls.push(input);
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT', timing: { ...TIMING, turnEndMs: null, turnMs: null, censored: true, signalMs: 120000 } });
    }
    return warmup(input);
  };
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop().catch(() => {}));
  await assert.rejects(loop.bootstrap({ ai: 2, stack: 100 }), { code: 'TIMEOUT' });

  const calls = warmupCalls(gameDir, 'start-warmup');
  assert.equal(calls.length, 2);
  const failed = calls.find((entry) => entry.code === 'TIMEOUT');
  assert.equal(failed.category, 'timeout');
  assert.equal(failed.censored, true);
  assert.equal(failed.timing.signalMs, 120000);
  assert.equal(failed.timing.censored, true);
  const ok = calls.find((entry) => entry.code === 'RESPONSE_RECEIVED');
  assert.equal(ok.timing, null, 'an adapter without timing logs null, not a guess');
  const [batch] = batches(gameDir);
  assert.equal(batch.size, 2);
  assert.equal(batch.answered, 1);
  assert.equal(batch.failed, 1);
  assert.deepEqual(batch.codes, { TIMEOUT: 1 });
});

test('#312 resume logs restore-warmup only for the seats it recreates', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  const state = writeLoopStateFixture(gameDir, init.sessionToken);
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify({
    p1: { runtime: 'fake', sessionId: 'persisted-p1', createdAt: '2026-08-29T01:00:00.000Z' },
    p2: { runtime: 'fake', sessionId: '--evil', createdAt: state.startedAt },
  }));
  const adapter = withTimingAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0 } });
  t.after(() => loop.requestStop());
  await loop.resume();

  assert.deepEqual(adapter.calls.map((call) => call.playerId), ['p2']);
  assert.equal(warmupCalls(gameDir, 'start-warmup').length, 0);
  const calls = warmupCalls(gameDir, 'restore-warmup');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batch.size, 1);
  assert.equal(calls[0].batch.index, 0);
  assert.equal(calls[0].timeoutMs, WARMUP_TIMEOUT_MS);
  assert.deepEqual(calls[0].timing, TIMING);
  const [batch] = batches(gameDir);
  assert.equal(batch.purpose, 'restore-warmup');
  assert.equal(batch.size, 1);
  assert.equal(batch.answered, 1);
});

test('#312 a resume that reuses every session logs no warmup and no batch', { timeout: 10_000 * WIN32_SCALE }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  writeLoopStateFixture(gameDir, init.sessionToken);
  fs.writeFileSync(path.join(gameDir, '.player-sessions.json'), JSON.stringify({
    p1: { runtime: 'fake', sessionId: 'persisted-p1', createdAt: '2026-08-29T01:00:00.000Z' },
    p2: { runtime: 'fake', sessionId: 'persisted-p2', createdAt: '2026-08-29T01:00:00.000Z' },
  }));
  const adapter = makeAdapter();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
  t.after(() => loop.requestStop());
  await loop.resume();
  assert.equal(adapter.calls.length, 0);
  assert.equal(readLoopLog(gameDir).filter((entry) => entry.event === 'player-call').length, 0);
  assert.equal(batches(gameDir).length, 0);
});

test('#312 decision player-calls carry the adapter timing, and null when the adapter reports none', { timeout: 15_000 * WIN32_SCALE }, async (t) => {
  for (const reported of [true, false]) {
    await t.test(reported ? 'reported' : 'absent', async (st) => {
      const gameDir = tmpGame();
      const adapter = makeAdapter({
        onDecide: async ({ message }) => {
          const decisionId = /decisionId:\s*([^\s]+)/.exec(message)?.[1];
          return { raw: JSON.stringify({ decisionId, action: 'fold' }), ...(reported ? { timing: { ...TIMING } } : {}) };
        },
      });
      const loop = createGameLoop({ gameDir, resolver: resolverFor(adapter), opts: { port: 0, waitMs: 0 } });
      st.after(() => loop.requestStop());
      await loop.bootstrap({ ai: 1, stack: 100 });
      putAiFirst(gameDir);
      const running = startRun(loop);
      await waitForUserSnapshot(gameDir);
      await stopRun(loop, running);
      const decisions = readLoopLog(gameDir).filter((entry) => entry.event === 'player-call' && entry.purpose === 'decision');
      assert.ok(decisions.length >= 1);
      for (const entry of decisions) assert.deepEqual(entry.timing, reported ? TIMING : null);
    });
  }
});
