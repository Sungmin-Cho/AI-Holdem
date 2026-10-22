// #312: 실제 game-loop 경로에서 Codex 플레이어 지연을 관측하는 러너.
// 모든 테스트는 가짜 loop(`test/helpers/fake-game-loop.mjs`)·가짜 relay·주입한 학습 서비스·identity 함수만 쓴다 — 실제 codex·엔진·store는 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_CRITERIA,
  checkTargets,
  claimTargets,
  createEventCounter,
  createRelayGuard,
  createSeatDriver,
  evaluateObservation,
  gitShaOf,
  loopArgs,
  main,
  observationPlan,
  observeOnce,
  outputFiles,
  scanLoopLog,
  seatActionFor,
  summarizeMetrics,
  validateObservationOptions,
} from '../tools/observe-player-latency.js';

const FAKE_LOOP = fileURLToPath(new URL('./helpers/fake-game-loop.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-observe-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function waitDead(pid, ms = 10_000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await sleep(20);
  assert.equal(alive(pid), false, `fake loop ${pid} must end`);
}

function harness(t, scenario, extra = {}) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'fake.log');
  const studyCalls = [];
  const listenerCalls = [];
  const targets = { storeDir: path.join(dir, 'store'), out: path.join(dir, 'out.json') };
  const deps = {
    spawnLoop: (args, { stdout, stderr }) => spawn(process.execPath, [FAKE_LOOP, ...args], {
      detached: true, stdio: ['ignore', stdout, stderr], env: { ...process.env, FAKE_LOOP_SCENARIO: JSON.stringify({ log, ...scenario }) },
    }),
    inspectStudy: async (store) => { studyCalls.push(['inspect', store]); return { status: 'running', instanceId: 'inst-1' }; },
    stopStudy: async (store, options) => { studyCalls.push(['stop', store, options]); },
    environment: { sha: () => 'f'.repeat(40), codexVersion: () => 'codex-cli test', loadavg: () => [1, 1, 1], codexProcesses: () => 0 },
    identityStatus: (pid) => (alive(pid) ? 'alive' : 'dead'),
    listenerOwnedBy: async (pid, port) => { listenerCalls.push([pid, port]); return true; },
    pollMs: 20,
    stopGraceMs: 400,
    ...extra,
  };
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { dir, targets, deps, studyCalls, listenerCalls, events };
}

const base = { hands: 3, ai: 2, pace: 'instant', maxPlayerCalls: 400, budgetMs: 20_000, bootTimeoutMs: 10_000 };
const leaks = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return text.match(/SECRET-[A-Z0-9-]*/g) ?? [];
};

test('options: defaults follow the lobby game (AI 5, 20 hands, normal pace); bounds and unknown keys are refused', () => {
  const o = validateObservationOptions({});
  assert.deepEqual(o, { hands: 20, ai: 5, pace: 'normal', maxPlayerCalls: 400, budgetMs: 3_600_000, bootTimeoutMs: 600_000 });
  for (const bad of [{ hands: 0 }, { hands: 61 }, { ai: 9 }, { pace: 'turbo' }, { maxPlayerCalls: 0 }, { budgetMs: 10 }, { port: 8899 }, { hands: 1.5 }]) {
    assert.throws(() => validateObservationOptions(bad), { code: 'BAD_ARGS' }, JSON.stringify(bad));
  }
  assert.deepEqual(loopArgs(o, '/s'), ['--store-dir', '/s', '--ai', '5', '--player-runtime', 'codex', '--opponent-runtime', 'llm',
    '--hands', '20', '--pace', 'normal', '--port', '0']);
  assert.equal(observationPlan({}).expectedStartWarmups, 5);
});

test('targets: refuse a relative, in-repo, existing or linked store and an existing or misplaced output before creating anything', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ok = { storeDir: path.join(dir, 'new-store'), out: path.join(dir, 'out.json') };
  assert.deepEqual(checkTargets(ok), ok);
  assert.equal(fs.existsSync(ok.storeDir), false, 'checking must not create the store');
  assert.throws(() => checkTargets({ ...ok, storeDir: 'relative/store' }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: 'out.json' }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(ROOT, 'tmp-store') }), { code: 'STORE_IN_REPO' });
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'empty') }), { code: 'STORE_EXISTS' }, 'even an empty store is someone else\'s');
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'dangling') }), { code: 'STORE_EXISTS' });
  fs.symlinkSync(ROOT, path.join(dir, 'repo-link'));
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'repo-link', 'x') }), { code: 'STORE_IN_REPO' });
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'missing', 'store') }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: path.join(ok.storeDir, 'out.json') }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: path.join(dir, 'missing', 'out.json') }), { code: 'BAD_ARGS' });
  fs.writeFileSync(outputFiles(ok.out).stderr, 'earlier evidence');
  assert.throws(() => checkTargets(ok), { code: 'OUT_EXISTS' }, 'a leftover sidecar without its JSON is still evidence');
});

test('claim: exclusive creation; a collision removes only what this claim created and keeps earlier bytes', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const targets = { storeDir: path.join(dir, 'store'), out: path.join(dir, 'out.json') };
  fs.writeFileSync(outputFiles(targets.out).json, 'earlier');
  assert.throws(() => claimTargets(targets), { code: 'OUT_EXISTS' });
  assert.equal(fs.existsSync(targets.storeDir), false);
  assert.equal(fs.existsSync(outputFiles(targets.out).stdout), false);
  assert.equal(fs.existsSync(outputFiles(targets.out).stderr), false);
  assert.equal(fs.readFileSync(outputFiles(targets.out).json, 'utf8'), 'earlier');
  fs.rmSync(outputFiles(targets.out).json);
  fs.mkdirSync(targets.storeDir);
  assert.throws(() => claimTargets(targets), { code: 'STORE_EXISTS' });
  assert.equal(fs.existsSync(targets.storeDir), true, 'a store this claim did not create is left alone');
});

test('seat: check when it is allowed, otherwise fold', () => {
  assert.equal(seatActionFor({ canCheck: true }), 'check');
  assert.equal(seatActionFor({ canCheck: false, canRaise: true }), 'fold');
  assert.equal(seatActionFor(undefined), 'fold');
});

async function relay(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, path: new URL(req.url, 'http://x').pathname, body: body ? JSON.parse(body) : null });
      const reply = handler(req, seen);
      if (reply === null) return; // 응답하지 않는다
      res.writeHead(reply[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply[1]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, seen };
}

test('seat driver: answers only the human turn, once per decision, and never acts on an AI turn', async (t) => {
  let legal = { toAct: 'p2', decisionId: 'd-ai' };
  const { port, seen } = await relay(t, (req) => (req.method === 'GET' ? [200, { view: { legal } }] : [200, { ok: true }]));
  let clock = 1000;
  const driver = createSeatDriver({ now: () => clock });
  await driver.tick({ port, sessionToken: 'tok' });
  assert.equal(seen.filter((r) => r.method === 'POST').length, 0, 'AI turn: nothing is sent');
  legal = { toAct: 'user', decisionId: 'd-1', canCheck: false };
  await driver.tick({ port, sessionToken: 'tok' });
  clock = 1300;
  await driver.tick({ port, sessionToken: 'tok' });
  const posts = seen.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1, 'one accepted answer per decision');
  assert.deepEqual({ action: posts[0].body.action, decisionId: posts[0].body.decisionId }, { action: 'fold', decisionId: 'd-1' });
  assert.match(posts[0].body.requestId, /^[0-9a-f-]{36}$/);
  legal = { toAct: 'user', decisionId: 'd-2', canCheck: true };
  await driver.tick({ port, sessionToken: 'tok' });
  const summary = driver.summary();
  assert.deepEqual([summary.check, summary.fold, summary.stale, summary.actionErrors], [1, 1, 0, 0]);
  assert.equal(driver.stuck, false);
});

test('seat driver: a failed send is resent with the same requestId and body; 409 codes are told apart', async (t) => {
  const replies = [];
  const legal = { toAct: 'user', decisionId: 'd-1', canCheck: false };
  const { port, seen } = await relay(t, (req) => (req.method === 'GET' ? [200, { view: { legal } }] : replies.shift()));
  const driver = createSeatDriver({ attempts: 3 });
  replies.push([503, { ok: false, code: 'CONTROL_BUSY' }], [409, { ok: false, code: 'ACTION_REJECTED' }], [200, { ok: true }]);
  for (let i = 0; i < 3; i += 1) await driver.tick({ port, sessionToken: 'tok' });
  const posts = seen.filter((r) => r.method === 'POST').map((r) => r.body);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((body) => JSON.stringify(body) === JSON.stringify(posts[0])), 'the same request is resent');
  assert.equal(driver.summary().actionErrors, 2);
  assert.equal(driver.summary().fold, 1);
  legal.decisionId = 'd-2';
  replies.push([409, { ok: false, code: 'STALE_DECISION' }]);
  await driver.tick({ port, sessionToken: 'tok' });
  legal.decisionId = 'd-3';
  replies.push([409, { ok: false, code: 'ACTION_ALREADY_RECEIVED' }]);
  await driver.tick({ port, sessionToken: 'tok' });
  await driver.tick({ port, sessionToken: 'tok' });
  assert.equal(seen.filter((r) => r.method === 'POST').length, 5, 'closed decisions are not sent again');
  assert.deepEqual([driver.summary().stale, driver.summary().alreadyReceived], [1, 1]);
  legal.decisionId = 'd-4';
  replies.push(...Array(3).fill([409, { ok: false, code: 'ACTION_RECEIPT_CAPACITY' }]));
  for (let i = 0; i < 3; i += 1) await driver.tick({ port, sessionToken: 'tok' });
  assert.equal(driver.stuck, true);
});

test('seat driver: a relay that never answers costs one bounded request per tick, and cancel stops it at once', async (t) => {
  const { port } = await relay(t, () => null);
  const driver = createSeatDriver({ requestTimeoutMs: 150 });
  const started = Date.now();
  await driver.tick({ port, sessionToken: 'tok' });
  assert.ok(Date.now() - started < 1000, 'bounded by the request deadline');
  assert.equal(driver.summary().snapshotErrors, 1);
  const cancel = new AbortController();
  const cancelled = createSeatDriver({ requestTimeoutMs: 60_000, cancel: cancel.signal });
  setTimeout(() => cancel.abort(), 50);
  const begun = Date.now();
  await cancelled.tick({ port, sessionToken: 'tok' });
  assert.ok(Date.now() - begun < 1000, 'cancel ends the in-flight request');
});

test('relay guard: the token goes only to a relay whose lock matches the loop state, whose identity is alive and which owns the port', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = (value) => fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(value));
  const state = { port: 4100, sessionToken: 'tok' };
  let status = 'alive';
  let owned = true;
  let clock = 0;
  const listener = [];
  const guard = createRelayGuard({ now: () => clock, identityStatus: () => status, listenerOwnedBy: async (pid, port) => { listener.push([pid, port]); return owned; } });
  assert.equal(await guard.access(dir, state), null, 'no lock');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'other' });
  assert.equal(await guard.access(dir, state), null, 'token mismatch');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4101, sessionToken: 'tok' });
  assert.equal(await guard.access(dir, state), null, 'port mismatch');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'tok' });
  status = 'unknown';
  assert.equal(await guard.access(dir, state), null, 'identity unknown');
  status = 'alive';
  owned = false;
  assert.equal(await guard.access(dir, state), null, 'another listener');
  owned = true;
  assert.deepEqual(await guard.access(dir, state), { port: 4100, sessionToken: 'tok' });
  const probes = listener.length;
  await guard.access(dir, state);
  assert.equal(listener.length, probes, 'the listener is proved once per binding');
  status = 'dead';
  assert.deepEqual(await guard.access(dir, state), { port: 4100, sessionToken: 'tok' }, 'identity is re-read only after the recheck interval');
  clock = 10_000;
  assert.equal(await guard.access(dir, state), null, 'a dead relay after the interval');
  assert.deepEqual(guard.denied(), { LOCK_MISSING: 1, LOCK_STATE_MISMATCH: 2, IDENTITY_UNKNOWN: 2, LISTENER_MISMATCH: 1 });
});

test('event counter and log scan: names only, partial last line deferred, failures projected to allowed fields', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'loop.log');
  fs.writeFileSync(file, '{"event":"player-call","decisionId":"x"}\n{"event":"player-ca');
  const counter = createEventCounter();
  assert.deepEqual(counter.read(file), { 'player-call': 1 });
  fs.appendFileSync(file, 'll"}\nnot json\n{"event":"BAD NAME"}\n');
  assert.deepEqual(counter.read(file), { 'player-call': 2 });
  const rows = [
    { event: 'runtime-models', player: { runtime: 'codex', model: 'gpt-6.1-sol', source: 'catalog' }, upper: { runtime: 'codex', model: 'gpt-6.1-sol' } },
    { event: 'player-call', purpose: 'decision', decisionId: 'SECRET-A', code: 'TIMEOUT', category: 'timeout', elapsedMs: 300000, prompt: 'SECRET-PROMPT', timing: { bootMs: 1, raw: 'SECRET-RAW' } },
    { event: 'player-call', purpose: 'decision', decisionId: 'SECRET-A', callNo: 2, code: 'RESPONSE_RECEIVED', elapsedMs: 26000 },
    { event: 'player-call', purpose: 'start-warmup', code: 'RESPONSE_RECEIVED', elapsedMs: 4000, timing: { bootMs: 1 } },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const scan = scanLoopLog(file, { limit: 1 });
  assert.equal(scan.decisions, 1);
  assert.equal(scan.runtimeModels.player.model, 'gpt-6.1-sol');
  assert.equal(scan.failures.length, 1);
  assert.equal(scan.failuresOmitted, 1, 'the slow second call is counted as omitted');
  assert.equal(scan.timingMissing, 1);
  assert.doesNotMatch(JSON.stringify(scan), /SECRET-/);
});

test('observe: a game that ends by itself passes, answers the human seat, stops the study service and leaks nothing', async (t) => {
  const h = harness(t, { kind: 'done' });
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, null);
  assert.deepEqual(report.run.exit, { code: 0, signal: null });
  assert.equal(report.run.finalPhase, 'done');
  assert.equal(report.run.handsCompleted, 3);
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(report.seat.check + report.seat.fold, 3);
  assert.equal(h.events().filter((event) => event.signal).length, 0, 'no signal for a game that ends by itself');
  assert.equal(new Set(h.events().filter((event) => event.action).map((event) => event.requestId)).size, 3);
  assert.deepEqual(h.studyCalls, [['inspect', h.targets.storeDir], ['stop', h.targets.storeDir, { expectedInstanceId: 'inst-1' }]]);
  assert.equal(h.listenerCalls.length, 1, 'one relay binding, proved once');
  assert.equal(report.criteria.pass, true, JSON.stringify(report.criteria));
  assert.equal(report.criteria.o2.calls, 2);
  assert.equal(report.criteria.o3.decisions, 9);
  assert.deepEqual(report.run.effort.player, ['-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.targets.out, 'utf8')).criteria, report.criteria);
  assert.deepEqual(leaks(h.targets.out), [], 'no decision id, session id, token, raw stdout/stderr or study URL in the output');
  assert.equal(fs.statSync(h.targets.out).mode & 0o777, 0o600);
});

test('observe: a decision left for recovery or unsafe stops the loop with one SIGTERM and is never retried', async (t) => {
  for (const kind of ['recovery', 'unsafe']) {
    const h = harness(t, { kind });
    const report = await observeOnce(base, h.targets, h.deps);
    assert.equal(report.run.stopReason, 'DECISION_FAILURE');
    assert.equal(h.events().filter((event) => event.signal === 'SIGTERM').length, 1);
    assert.equal(h.events().filter((event) => event.action).length, 0, 'the runner answers nothing for the failed AI decision');
    assert.equal(report.run.finalPending.status, kind === 'unsafe' ? 'unsafe' : 'recovery_required');
    assert.equal(report.criteria.o4.pass, false);
    assert.equal(report.criteria.pass, false);
    assert.deepEqual(leaks(h.targets.out), []);
  }
});

test('observe: a halt ends the run as an observed failure with at most one SIGTERM', async (t) => {
  const h = harness(t, { kind: 'halt' });
  const report = await observeOnce(base, h.targets, h.deps);
  // 가짜 loop는 halt를 쓰고 스스로 끝난다. 러너가 halt를 먼저 보면 SIGTERM 한 번을 보낸다 — 어느 쪽이든 재시도는 없다.
  assert.ok(h.events().filter((event) => event.signal).length <= 1);
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(report.run.finalHalt, 'FAKE_HALT');
  assert.equal(report.criteria.o4.pass, false);
  assert.equal(report.criteria.pass, false);
});

test('observe: the call threshold, the budget and the boot timeout each stop the loop with one SIGTERM', async (t) => {
  const cap = harness(t, { kind: 'calls' });
  const capped = await observeOnce({ ...base, maxPlayerCalls: 20 }, cap.targets, cap.deps);
  assert.equal(capped.run.stopReason, 'CALL_CAP');
  assert.equal(cap.events().filter((event) => event.signal).length, 1);
  assert.ok(capped.run.playerCallsAtStop >= 20);

  const boot = harness(t, { kind: 'boot-hang' });
  const booted = await observeOnce({ ...base, bootTimeoutMs: 300 }, boot.targets, boot.deps);
  assert.equal(booted.run.stopReason, 'BOOT_TIMEOUT');
  assert.equal(booted.run.playingAfterMs, null);
  assert.equal(boot.events().filter((event) => event.signal).length, 1, 'loop-state exists, so the handler is installed and is signalled');

  const budget = harness(t, { kind: 'boot-hang' });
  const spent = await observeOnce({ ...base, budgetMs: 300 }, budget.targets, budget.deps);
  assert.equal(spent.run.stopReason, 'BUDGET');
  for (const report of [capped, booted, spent]) {
    assert.equal(report.run.terminationConfirmed, true);
    assert.equal(report.criteria.o0.pass, false);
  }
});

test('observe: a stop before the loop wrote its state waits for the handler, then signals once', async (t) => {
  const controller = new AbortController();
  const h = harness(t, { kind: 'done', stateDelayMs: 300 }, { stopSignal: controller.signal, stopGraceMs: 3000 });
  setTimeout(() => controller.abort(), 30);
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'OPERATOR_STOP');
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(report.run.preHandler, false);
  assert.equal(h.events().filter((event) => event.signal).length, 1);
  assert.ok(Date.parse(report.run.stopSignalledAt) - Date.parse(report.run.stopRequestedAt) >= 200, 'the signal waited for the state');
});

test('observe: a loop that never installs its handler is never signalled and is recorded unconfirmed', async (t) => {
  const release = path.join(os.tmpdir(), `holdem-observe-release-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(release, { force: true }));
  const h = harness(t, { kind: 'never-state', release });
  const report = await observeOnce({ ...base, bootTimeoutMs: 200 }, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'BOOT_TIMEOUT');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.preHandler, true);
  assert.equal(h.events().filter((event) => event.signal).length, 0, 'no signal before the handler exists');
  fs.writeFileSync(release, '');
  await waitDead(report.run.loopPid);
});

test('observe: a loop that ignores SIGTERM is left alive and recorded unconfirmed — no SIGKILL, no study stop, store kept', async (t) => {
  const release = path.join(os.tmpdir(), `holdem-observe-release-${process.pid}-${Date.now()}-b`);
  t.after(() => fs.rmSync(release, { force: true }));
  const h = harness(t, { kind: 'ignore-term', release });
  const report = await observeOnce({ ...base, budgetMs: 300 }, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'BUDGET');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.exit, null);
  assert.equal(alive(report.run.loopPid), true, 'the runner sends no SIGKILL');
  assert.equal(h.events().filter((event) => event.signal).length, 1, 'exactly one SIGTERM');
  assert.deepEqual(h.studyCalls, [], 'the study service is left to the live loop');
  assert.equal(fs.existsSync(path.join(h.targets.storeDir, '.session-store')), true);
  fs.writeFileSync(release, '');
  await waitDead(report.run.loopPid);
});

test('observe: an unverified relay gets no token and the human seat is never answered', async (t) => {
  const h = harness(t, { kind: 'done', badLock: true });
  const report = await observeOnce({ ...base, budgetMs: 600 }, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'BUDGET');
  assert.equal(h.events().filter((event) => event.action).length, 0);
  assert.ok(report.run.relayUnverified.LOCK_STATE_MISMATCH > 0);
  const listenerRefused = harness(t, { kind: 'done' }, { listenerOwnedBy: async () => false });
  const refused = await observeOnce({ ...base, budgetMs: 600 }, listenerRefused.targets, listenerRefused.deps);
  assert.equal(listenerRefused.events().filter((event) => event.action).length, 0);
  assert.ok(refused.run.relayUnverified.LISTENER_MISMATCH > 0);
});

test('observe: a relay alive under its recorded identity, a failed study cleanup and a spawn error each fail O0', async (t) => {
  const same = harness(t, { kind: 'done', lockPid: process.pid, lockStartTime: 'T0' });
  const report = await observeOnce(base, same.targets, same.deps);
  assert.deepEqual(report.run.relay, { recorded: true, alive: true, identity: 'alive' });
  assert.ok(report.criteria.o0.reasons.includes('RELAY_NOT_CONFIRMED_DEAD'));
  const study = harness(t, { kind: 'done' }, { inspectStudy: async () => { throw Object.assign(new Error('x'), { code: 'STUDY_DESCRIPTOR_CORRUPT' }); } });
  const failed = await observeOnce(base, study.targets, study.deps);
  assert.deepEqual(failed.run.study, { ok: false, status: null, stopped: false, code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.ok(failed.criteria.o0.reasons.includes('STUDY_CLEANUP'));
  const missing = harness(t, { kind: 'done' }, { spawnLoop: (args, { stdout, stderr }) => spawn('/nonexistent/holdem-loop', args, { stdio: ['ignore', stdout, stderr] }) });
  const spawned = await observeOnce(base, missing.targets, missing.deps);
  assert.equal(spawned.run.exit.error, 'ENOENT');
  assert.equal(spawned.run.terminationConfirmed, true);
  assert.equal(spawned.criteria.pass, false);
});

test('observe: an off-target model, a rejected reply and slow whole decisions are judged from the loop records', async (t) => {
  const luna = harness(t, { kind: 'done', model: 'gpt-6-luna' });
  assert.ok((await observeOnce(base, luna.targets, luna.deps)).criteria.o0.reasons.includes('NOT_TARGET_RUNTIME'));
  const upper = harness(t, { kind: 'done', upperRuntime: 'claude' });
  assert.ok((await observeOnce(base, upper.targets, upper.deps)).criteria.o0.reasons.includes('NOT_TARGET_RUNTIME'));
  const rejected = harness(t, { kind: 'done', rejected: 1 });
  const legality = (await observeOnce(base, rejected.targets, rejected.deps)).criteria;
  assert.deepEqual([legality.o5.pass, legality.o5.decisionRejected, legality.pass], [false, 1, false]);
  // 결정 9개 중 하나가 결정 전체 40초다(호출은 20초씩) — 호출 단위로는 25초 초과가 없어도 결정 단위로 센다.
  const slow = harness(t, { kind: 'done', decisionMs: [3000, 3000, 3000, 3000, 40_000, 3000, 3000, 3000, 3000] });
  const o3 = (await observeOnce(base, slow.targets, slow.deps)).criteria.o3;
  assert.deepEqual([o3.overSoft25s, o3.decisions, o3.pass], [1, 9, false]);
});

const group = (kind, fields = {}) => ({
  runtime: 'codex', model: 'gpt-6.1-sol', kind, batchSize: kind === 'decision' ? null : 5, calls: 0,
  outcomes: { answered: 0, timeout: 0, interrupted: 0, failed: {} }, answeredMs: { n: 0, max: null, median: null }, over: {}, ...fields,
});
const metricsOf = (elapsed) => summarizeMetrics({ metrics: elapsed.map((elapsedMs) => ({ runtime: 'codex', outcome: 'accepted', elapsedMs })), metricsDropped: 0 });
const cleanRun = (decisions = 100) => ({
  exit: { code: 0, signal: null }, finalPhase: 'done', handsCompleted: 20, stopReason: null, terminationConfirmed: true,
  study: { ok: true }, relay: { alive: false }, finalHalt: null, finalPending: null, eventCounts: {}, failures: [],
  runtimeModels: { player: { runtime: 'codex', model: 'gpt-6.1-sol' }, upper: { runtime: 'codex', model: 'gpt-6.1-sol' } },
  runtimes: { player: 'codex', upper: 'codex' }, metrics: metricsOf(Array(decisions).fill(4000)), decisions, logUnparsable: 0,
});
const judge = (groups, run = {}) => evaluateObservation({ run: { ...cleanRun(), ...run }, latency: { groups, skipped: { oversizeFile: 0, oversizeLines: 0, unparsableLines: 0 } }, options: { hands: 20, ai: 5 } });
const warm = (fields = {}) => group('start-warmup', { calls: 5, outcomes: { answered: 5, timeout: 0, interrupted: 0, failed: {} }, answeredMs: { n: 5, max: 6000 }, ...fields });
const decide = (answered, fields = {}) => group('decision', { calls: answered, outcomes: { answered, timeout: 0, interrupted: 0, failed: {} }, answeredMs: { n: answered, max: 9000, median: 4000 }, ...fields });

test('criteria: O2 and decision-level O3 follow the pre-fixed bounds (warmup cap 120 s, soft 25 s at most 5 %, hard 300 s, no timeout)', () => {
  assert.equal(judge([warm(), decide(100)]).pass, true);
  assert.equal(judge([warm({ answeredMs: { n: 5, max: 120_000 } }), decide(100)]).o2.pass, true);
  assert.equal(judge([warm({ answeredMs: { n: 5, max: 120_001 } }), decide(100)]).o2.pass, false);
  const over60 = [{ purpose: 'start-warmup', elapsedMs: 61_000, at: 'x', timing: { bootMs: 300, turnMs: 60_000 } }];
  const slow = judge([warm({ over: { over60s: 1 }, answeredMs: { n: 5, max: 61_000 } }), decide(100)], { failures: over60 });
  assert.equal(slow.o2.pass, true, 'over 60 s is reported, not a violation');
  assert.deepEqual(slow.o2.over60sCalls, over60);
  assert.equal(judge([warm({ calls: 4, outcomes: { answered: 4, timeout: 0, failed: {} }, answeredMs: { n: 4, max: 6000 } }), decide(100)]).o2.pass, false);
  const five = [...Array(95).fill(4000), ...Array(5).fill(26_000)];
  assert.equal(judge([warm(), decide(100)], { metrics: metricsOf(five) }).o3.pass, true, '5 % is allowed');
  const six = [...Array(94).fill(4000), ...Array(6).fill(26_000)];
  assert.equal(judge([warm(), decide(100)], { metrics: metricsOf(six) }).o3.pass, false);
  assert.equal(judge([warm(), decide(100)], { metrics: metricsOf([...Array(99).fill(4000), 300_001]) }).o3.pass, false);
  assert.equal(judge([warm(), decide(100, { outcomes: { answered: 99, timeout: 1, failed: {} }, answeredMs: { n: 99 } })]).o3.pass, false);
  assert.equal(judge([warm()], { metrics: metricsOf([]), decisions: 0 }).o3.pass, false, 'no decision is no evidence');
});

test('criteria: termination fails O1, transport and halts fail O4, rejected or malformed replies fail O5', () => {
  const failed = (failures) => ({ outcomes: { answered: 100 - Object.values(failures).reduce((a, b) => a + b, 0), timeout: 0, failed: failures }, answeredMs: { n: 100 - Object.values(failures).reduce((a, b) => a + b, 0) } });
  assert.equal(judge([warm(), decide(100, failed({ termination: 1 }))]).o1.pass, false);
  assert.equal(judge([warm(), decide(100)], { terminationConfirmed: false }).o1.pass, false);
  assert.equal(judge([warm(), decide(100, failed({ transport: 1 }))]).o4.pass, false);
  assert.equal(judge([warm(), decide(100, failed({ session: 1 }))]).o4.pass, false);
  assert.equal(judge([warm(), decide(100), group('repair-warmup', { calls: 1, outcomes: { answered: 0, timeout: 1, failed: {} } })]).o4.pass, false);
  assert.equal(judge([warm(), decide(100)], { finalHalt: 'X' }).o4.pass, false);
  assert.equal(judge([warm(), decide(100, failed({ response_format: 1 }))]).o5.pass, false);
  assert.equal(judge([warm(), decide(100, failed({ illegal_action: 1 }))]).o5.pass, false);
  assert.equal(judge([warm(), decide(100)], { eventCounts: { 'player-decision-rejected': 1 } }).o5.pass, false);
});

test('criteria: an incomplete, unmeasured or off-target run never passes, but its violations are still counted', () => {
  const stopped = judge([warm(), decide(40, { outcomes: { answered: 40, timeout: 2, failed: {} }, answeredMs: { n: 40 } })],
    { stopReason: 'BUDGET', handsCompleted: 7, finalPhase: 'playing' });
  assert.equal(stopped.pass, false);
  assert.deepEqual(stopped.o0.reasons, ['NOT_DONE', 'HANDS_INCOMPLETE', 'STOP_BUDGET']);
  assert.equal(stopped.o3.callTimeouts, 2);
  for (const [run, reason] of [
    [{ runtimeModels: { player: { runtime: 'codex', model: 'gpt-6-luna' }, upper: { runtime: 'codex' } } }, 'NOT_TARGET_RUNTIME'],
    [{ runtimes: { player: 'claude', upper: 'codex' } }, 'NOT_TARGET_RUNTIME'],
    [{ metrics: { ...metricsOf(Array(100).fill(4000)), dropped: 3 } }, 'METRICS_INCOMPLETE'],
    [{ decisions: 101 }, 'METRICS_INCOMPLETE'],
    [{ logUnparsable: 1 }, 'LOG_UNPARSABLE'],
    [{ relay: { alive: null } }, 'RELAY_NOT_CONFIRMED_DEAD'],
  ]) assert.ok(judge([warm(), decide(100)], run).o0.reasons.includes(reason), reason);
  assert.ok(judge([warm({ model: 'gpt-6-luna' }), decide(100)]).o0.reasons.includes('NOT_TARGET_RUNTIME'));
  assert.ok(judge([warm(), decide(100, { answeredMs: { n: 98 } })]).o0.reasons.includes('LATENCY_INCOMPLETE'), 'answers without a latency');
  const skipped = evaluateObservation({ run: cleanRun(), latency: { groups: [warm(), decide(100)], skipped: { unparsableLines: 1 } }, options: { hands: 20, ai: 5 } });
  assert.ok(skipped.o0.reasons.includes('LATENCY_INCOMPLETE'));
  assert.ok(evaluateObservation({ run: cleanRun(), latency: null, options: { hands: 20, ai: 5 } }).o0.reasons.includes('NO_LATENCY_REPORT'));
  assert.equal(OBSERVATION_CRITERIA.playerModel.test('gpt-6.1-sol'), true);
});

test('sha: recorded only when the runner root is the top of a git work tree', () => {
  const sha = 'a'.repeat(40);
  assert.equal(gitShaOf(ROOT, (cmd, args) => (args[1] === '--show-toplevel' ? ROOT : sha)), sha);
  assert.equal(gitShaOf(ROOT, (cmd, args) => (args[1] === '--show-toplevel' ? path.dirname(ROOT) : sha)), null, 'an archive copy under another repository');
  assert.equal(gitShaOf(ROOT, () => null), null);
});

test('CLI: without --live only the plan is printed and nothing is spawned; argument and target errors exit 2', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let spawned = 0;
  const deps = { spawnLoop: () => { spawned += 1; throw new Error('must not spawn'); } };
  const io = () => { const out = []; return { out, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } }; };
  const plan = io();
  assert.equal(await main(['--store-dir', path.join(dir, 's'), '--out', path.join(dir, 'o.json'), '--json'], { ...plan, deps }), 0);
  assert.equal(JSON.parse(plan.out.join('')).executed, false);
  for (const argv of [[], ['--store-dir', path.join(dir, 's')], ['--store-dir', 'rel', '--out', path.join(dir, 'o.json')],
    ['--store-dir', path.join(dir, 's'), '--out', path.join(dir, 'o.json'), '--port', '8899'],
    ['--store-dir', path.join(dir, 's'), '--out', path.join(dir, 'o.json'), '--hands', 'x']]) {
    const e = io();
    assert.equal(await main(argv, { ...e, deps }), 2, JSON.stringify(argv));
  }
  assert.equal(spawned, 0);
  assert.equal(fs.existsSync(path.join(dir, 's')), false);
});

test('CLI: exit 0 for a pass, 3 for a run that is not a pass, 1 for an unconfirmed termination', async (t) => {
  const io = () => ({ stdout: { write: () => {} }, stderr: { write: () => {} } });
  const run = async (scenario, extra = []) => {
    const h = harness(t, scenario);
    const code = await main(['--live', '--store-dir', h.targets.storeDir, '--out', h.targets.out, '--hands', '3', '--ai', '2', '--pace', 'instant', ...extra],
      { ...io(), deps: { ...h.deps, signalSource: new EventEmitter() } });
    return { code, h };
  };
  assert.equal((await run({ kind: 'done' })).code, 0);
  assert.equal((await run({ kind: 'recovery' })).code, 3);
  const release = path.join(os.tmpdir(), `holdem-observe-cli-release-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(release, { force: true }));
  const { code, h } = await run({ kind: 'ignore-term', release }, ['--budget-ms', '300']);
  assert.equal(code, 1);
  const pid = JSON.parse(fs.readFileSync(h.targets.out, 'utf8')).run.loopPid;
  fs.writeFileSync(release, '');
  await waitDead(pid);
});

test('CLI: an operator signal stops the loop once and still writes the report', async (t) => {
  const signals = new EventEmitter();
  const h = harness(t, { kind: 'boot-hang' });
  setTimeout(() => signals.emit('SIGINT'), 200);
  const code = await main(['--live', '--store-dir', h.targets.storeDir, '--out', h.targets.out, '--hands', '3', '--ai', '2'],
    { stdout: { write: () => {} }, stderr: { write: () => {} }, deps: { ...h.deps, signalSource: signals } });
  assert.equal(code, 3);
  assert.equal(JSON.parse(fs.readFileSync(h.targets.out, 'utf8')).run.stopReason, 'OPERATOR_STOP');
  assert.equal(h.events().filter((event) => event.signal).length, 1);
});
