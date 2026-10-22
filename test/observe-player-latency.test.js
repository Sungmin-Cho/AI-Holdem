// #312: 실제 game-loop 경로에서 Codex 플레이어 지연을 관측하는 러너.
// 모든 테스트는 가짜 loop(`test/helpers/fake-game-loop.mjs`)·가짜 relay·주입한 학습 서비스·identity·listener 함수만 쓴다 — 실제 codex·엔진·store는 쓰지 않는다.
// 실제 실행과 SIGTERM 정지 계약은 POSIX 전용이라 가짜 loop를 띄우는 시험은 Windows에서 건너뛴다(러너도 Windows --live를 거부한다).
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
  createActionPost,
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
  readHumanTurn,
  scanLoopLog,
  seatActionFor,
  summarizeMetrics,
  validateObservationOptions,
} from '../tools/observe-player-latency.js';

const FAKE_LOOP = fileURLToPath(new URL('./helpers/fake-game-loop.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const posixOnly = { skip: !POSIX && 'the live runner and its SIGTERM contract are POSIX-only' };
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
  const log = path.join(dir, 'fake.log');
  const release = scenario.release === true ? path.join(dir, 'release') : null;
  const spawned = [];
  let unrefs = 0;
  // 한 teardown이 순서대로 정리한다: release로 붙잡힌 가짜 loop를 풀고 끝을 확인한 뒤 디렉터리를 지운다(단언 실패와 무관).
  t.after(async () => {
    if (release) fs.writeFileSync(release, '');
    for (const pid of spawned) await waitDead(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const studyCalls = [];
  const listenerCalls = [];
  const targets = { storeDir: path.join(dir, 'store'), out: path.join(dir, 'out.json') };
  const deps = {
    spawnLoop: (args, { stdout, stderr }) => {
      const child = spawn(process.execPath, [FAKE_LOOP, ...args], {
        detached: true, stdio: ['ignore', stdout, stderr], env: { ...process.env, FAKE_LOOP_SCENARIO: JSON.stringify({ log, ...scenario, release }) },
      });
      if (child.pid) spawned.push(child.pid);
      const unref = child.unref.bind(child);
      child.unref = () => { unrefs += 1; unref(); };
      return child;
    },
    inspectStudy: async (store) => { studyCalls.push(['inspect', store]); return { status: 'running', instanceId: 'inst-1' }; },
    stopStudy: async (store, options) => { studyCalls.push(['stop', store, options]); },
    environment: { sha: () => 'f'.repeat(40), codexVersion: () => 'codex-cli test', loadavg: () => [1, 1, 1], codexProcesses: () => 0 },
    identityStatus: (pid) => (alive(pid) ? 'alive' : 'dead'),
    listenerOwnedBy: async (pid, port) => { listenerCalls.push([pid, port]); return true; },
    pollMs: 20,
    stopGraceMs: 1500,
    ...extra,
  };
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  // 가짜 loop가 playing을 쓰고 남기는 준비 줄을 기다린다. 시간 대신 이 줄로 정지 시점을 맞춘다.
  const ready = async (ms = 15_000) => {
    const until = Date.now() + ms;
    while (!events().some((event) => event.ready) && Date.now() < until) await sleep(10);
    assert.ok(events().some((event) => event.ready), 'fake loop never became ready');
  };
  const signals = () => events().filter((event) => event.signal);
  return { dir, targets, deps, studyCalls, listenerCalls, events, ready, signals, unrefs: () => unrefs };
}

const base = { hands: 3, ai: 2, pace: 'instant', maxPlayerCalls: 400, budgetMs: 60_000, bootTimeoutMs: 30_000 };
const leaks = (file) => fs.readFileSync(file, 'utf8').match(/SECRET-[A-Z0-9-]*/g) ?? [];

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

test('targets: refuse a relative, in-repo, existing store and an existing or misplaced output before creating anything', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ok = { storeDir: path.join(dir, 'new-store'), out: path.join(dir, 'out.json') };
  assert.deepEqual(checkTargets(ok), ok);
  assert.equal(fs.existsSync(ok.storeDir), false, 'checking must not create the store');
  assert.throws(() => checkTargets({ ...ok, storeDir: 'relative/store' }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: 'out.json' }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(ROOT, 'tmp-store') }), { code: 'STORE_IN_REPO' });
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(ROOT, '..observation-store') }), { code: 'STORE_IN_REPO' }, "'..name' is a child, not the parent");
  fs.mkdirSync(path.join(dir, 'empty'));
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'empty') }), { code: 'STORE_EXISTS' }, 'even an empty store is someone else\'s');
  assert.throws(() => checkTargets({ ...ok, storeDir: path.join(dir, 'missing', 'store') }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: path.join(ok.storeDir, 'out.json') }), { code: 'BAD_ARGS' });
  assert.throws(() => checkTargets({ ...ok, out: path.join(dir, 'missing', 'out.json') }), { code: 'BAD_ARGS' });
  fs.writeFileSync(outputFiles(ok.out).stderr, 'earlier evidence');
  assert.throws(() => checkTargets(ok), { code: 'OUT_EXISTS' }, 'a leftover sidecar without its JSON is still evidence');
});

test('targets: a dangling link is an existing store and a linked repository is still the repository', { skip: !POSIX && 'symlinks need privileges on Windows' }, (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out.json');
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling'));
  assert.throws(() => checkTargets({ storeDir: path.join(dir, 'dangling'), out }), { code: 'STORE_EXISTS' });
  fs.symlinkSync(ROOT, path.join(dir, 'repo-link'));
  assert.throws(() => checkTargets({ storeDir: path.join(dir, 'repo-link', 'x'), out }), { code: 'STORE_IN_REPO' });
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

test('human turn: read from the relay snapshot file without a token; legal actions only for the same decision', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (value) => fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(readHumanTurn(dir), null);
  write('{"decision":');
  assert.equal(readHumanTurn(dir), null, 'a half-written file is skipped');
  write({ decision: { decisionId: 'd1', toAct: 'user' }, view: { legal: { decisionId: 'd1', toAct: 'user', canCheck: true } } });
  assert.deepEqual(readHumanTurn(dir), { decisionId: 'd1', toAct: 'user', canCheck: true });
  write({ decision: { decisionId: 'd2', toAct: 'user' }, view: { legal: { decisionId: 'd1', canCheck: true } } });
  assert.deepEqual(readHumanTurn(dir), { decisionId: 'd2', toAct: 'user', canCheck: null });
  write({ decision: { decisionId: 'd3', toAct: 'p2' }, view: {} });
  assert.deepEqual(readHumanTurn(dir), { decisionId: 'd3', toAct: 'p2', canCheck: null });
  assert.equal(seatActionFor({ canCheck: true }), 'check');
  assert.equal(seatActionFor({ canCheck: false }), 'fold');
});

test('seat driver: answers only the human turn, once per decision, resends the same request, tells 409 codes apart', async () => {
  const sent = [];
  const replies = [];
  let clock = 1000;
  const driver = createSeatDriver({ now: () => clock, attempts: 3, post: async (body) => { sent.push(body); return replies.shift(); } });
  await driver.tick({ decisionId: 'd-ai', toAct: 'p2', canCheck: null });
  await driver.tick(null);
  await driver.tick({ decisionId: 'd-0', toAct: 'user', canCheck: null });
  assert.equal(sent.length, 0, 'AI turns and unknown legal actions send nothing');
  replies.push({ status: 503, body: { code: 'CONTROL_BUSY' } }, null, { status: 409, body: { code: 'ACTION_REJECTED' } }, { status: 200, body: { ok: true } });
  for (let i = 0; i < 4; i += 1) { await driver.tick({ decisionId: 'd-1', toAct: 'user', canCheck: false }); clock += 100; }
  assert.equal(sent.length, 4);
  assert.ok(sent.every((body) => body === sent[0]), 'the same requestId and body every time');
  assert.deepEqual(JSON.parse(sent[0]).action, 'fold');
  await driver.tick({ decisionId: 'd-1', toAct: 'user', canCheck: false });
  assert.equal(sent.length, 4, 'an accepted decision is not sent again');
  let summary = driver.summary();
  assert.deepEqual([summary.fold, summary.actionErrors, summary.unsent, summary.acceptedMs.max], [1, 2, 1, 300], 'an unsent tick is not an attempt');
  replies.push({ status: 409, body: { code: 'STALE_DECISION' } }, { status: 409, body: { code: 'ACTION_ALREADY_RECEIVED' } });
  await driver.tick({ decisionId: 'd-2', toAct: 'user', canCheck: true });
  await driver.tick({ decisionId: 'd-3', toAct: 'user', canCheck: true });
  await driver.tick({ decisionId: 'd-3', toAct: 'user', canCheck: true });
  summary = driver.summary();
  assert.deepEqual([summary.stale, summary.alreadyReceived, sent.length], [1, 1, 6]);
  replies.push(...Array(3).fill({ status: 409, body: { code: 'ACTION_RECEIPT_CAPACITY' } }));
  for (let i = 0; i < 3; i += 1) await driver.tick({ decisionId: 'd-4', toAct: 'user', canCheck: true });
  assert.equal(driver.stuck, true);
});

async function relay(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, seen };
}

test('action post: a deadline bounds a silent relay and a stalled body; cancel ends it at once; redirects are not followed', async (t) => {
  const silent = await relay(t, () => {});
  const post = createActionPost({ requestTimeoutMs: 150 });
  let started = Date.now();
  await assert.rejects(post({ port: silent.port, sessionToken: 'tok' }, '{}'));
  assert.ok(Date.now() - started < 1500, 'bounded by the request deadline');
  const stalled = await relay(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":'); });
  started = Date.now();
  await assert.rejects(post({ port: stalled.port, sessionToken: 'tok' }, '{}'));
  assert.ok(Date.now() - started < 1500, 'the body read shares the deadline');
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 50);
  started = Date.now();
  await assert.rejects(createActionPost({ requestTimeoutMs: 60_000, cancel: cancel.signal })({ port: silent.port, sessionToken: 'tok' }, '{}'));
  assert.ok(Date.now() - started < 1500);
  const moved = await relay(t, (req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${silent.port}/elsewhere` }); res.end(); });
  const before = silent.seen.length;
  await assert.rejects(post({ port: moved.port, sessionToken: 'tok' }, '{}'));
  assert.equal(silent.seen.length, before, 'the token never follows a redirect');
  const ok = await relay(t, (req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"code":"STALE_DECISION"}'); });
  assert.deepEqual(await post({ port: ok.port, sessionToken: 'a b' }, '{"x":1}'), { status: 409, body: { code: 'STALE_DECISION' } });
  assert.equal(ok.seen[0].url, '/api/action?token=a%20b');
});

test('relay guard: every send re-proves lock, loop state, listener and identity; a change during the listener probe refuses', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = (value) => fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'loop-state.json'), JSON.stringify({ port: 4100, sessionToken: 'tok' }));
  let status = 'alive';
  let owned = true;
  let duringProbe = null;
  let stopping = false;
  const probes = [];
  const guard = createRelayGuard({
    identityStatus: () => status, isStopping: () => stopping,
    listenerOwnedBy: async (pid, port) => { probes.push([pid, port]); duringProbe?.(); return owned; },
  });
  const sends = [];
  const send = (access) => { sends.push(access); return 'sent'; };
  assert.equal(await guard.use(dir, send), null, 'no lock');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'other' });
  assert.equal(await guard.use(dir, send), null, 'token mismatch');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4101, sessionToken: 'tok' });
  assert.equal(await guard.use(dir, send), null, 'port mismatch');
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'tok' });
  owned = false;
  assert.equal(await guard.use(dir, send), null, 'another listener');
  owned = null;
  assert.equal(await guard.use(dir, send), null, 'listener unknown');
  owned = true;
  status = 'unknown';
  assert.equal(await guard.use(dir, send), null, 'identity unknown');
  status = 'alive';
  duringProbe = () => lock({ serverPid: 12, serverStartTime: 'T', port: 4100, sessionToken: 'tok' });
  assert.equal(await guard.use(dir, send), null, 'the lock changed while the listener was probed');
  duringProbe = () => { stopping = true; };
  assert.equal(await guard.use(dir, send), null, 'a stop that began during the probe');
  duringProbe = null;
  stopping = false;
  const realStatus = () => status;
  const changing = createRelayGuard({
    listenerOwnedBy: async () => true,
    identityStatus: () => { lock({ serverPid: 13, serverStartTime: 'U', port: 4100, sessionToken: 'tok' }); return 'alive'; },
  });
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'tok' });
  assert.equal(await changing.use(dir, send), null, 'the lock changed during the synchronous identity read');
  assert.deepEqual(changing.denied(), { CHANGED: 1 });
  lock({ serverPid: 11, serverStartTime: 'S', port: 4100, sessionToken: 'tok' });
  assert.equal(realStatus(), 'alive');
  assert.equal(await guard.use(dir, send), 'sent');
  assert.equal(await guard.use(dir, send), 'sent');
  assert.deepEqual(sends, [{ port: 4100, sessionToken: 'tok' }, { port: 4100, sessionToken: 'tok' }]);
  assert.equal(probes.length, 7, 'the listener is probed for every send that passes the file checks — nothing is cached');
  status = 'dead';
  assert.equal(await guard.use(dir, send), null, 'a dead relay is refused at once');
  assert.deepEqual(guard.denied(), { LOCK_MISSING: 1, LOCK_STATE_MISMATCH: 2, LISTENER_MISMATCH: 1, LISTENER_UNKNOWN: 1, IDENTITY_UNKNOWN: 2, CHANGED: 1, STOPPING: 1 });
});

test('event counter and log scan: names only, partial last line deferred, failures and rejections projected to allowed fields', (t) => {
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
    { event: 'player-decision-rejected', at: 'T', decisionId: 'SECRET-A', code: 'ILLEGAL_ACTION', detail: 'raise-below-min', callNo: 1, raw: 'SECRET-REPLY', projection: { x: 'SECRET-P' } },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const scan = scanLoopLog(file, { limit: 1 });
  assert.equal(scan.decisions, 1);
  assert.equal(scan.runtimeModels.player.model, 'gpt-6.1-sol');
  assert.equal(scan.failures.length, 1);
  assert.equal(scan.failuresOmitted, 1, 'the slow second call is counted as omitted');
  assert.equal(scan.timingMissing, 1);
  assert.deepEqual(scan.rejections, [{ at: 'T', code: 'ILLEGAL_ACTION', detail: 'raise-below-min', callNo: 1 }]);
  assert.doesNotMatch(JSON.stringify(scan), /SECRET-/);
});

test('observe: a game that ends by itself passes, answers the human seat, stops the study service and leaks nothing', posixOnly, async (t) => {
  const h = harness(t, { kind: 'done' });
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, null);
  assert.deepEqual(report.run.exit, { code: 0, signal: null });
  assert.equal(report.run.finalPhase, 'done');
  assert.equal(report.run.handsCompleted, 3);
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(report.seat.check + report.seat.fold, 3);
  assert.equal(h.signals().length, 0, 'no signal for a game that ends by itself');
  assert.equal(new Set(h.events().filter((event) => event.action).map((event) => event.requestId)).size, 3);
  assert.deepEqual(h.events().filter((event) => event.request), [], 'no token-bearing request other than the three actions');
  assert.equal(h.listenerCalls.length, 3, 'the listener is proved for each send');
  assert.deepEqual(h.studyCalls, [['inspect', h.targets.storeDir], ['stop', h.targets.storeDir, { expectedInstanceId: 'inst-1' }]]);
  assert.equal(report.criteria.pass, true, JSON.stringify(report.criteria));
  assert.equal(report.criteria.o2.calls, 2);
  assert.equal(report.criteria.o3.decisions, 9);
  assert.deepEqual(report.run.effort.player, ['-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.targets.out, 'utf8')).criteria, report.criteria);
  assert.deepEqual(leaks(h.targets.out), [], 'no decision id, session id, token, card, raw stdout/stderr or study URL in the output');
  assert.equal(fs.statSync(h.targets.out).mode & 0o777, 0o600);
});

test('observe: a decision left for recovery or unsafe stops the loop with one SIGTERM, is never retried and keeps its wait', posixOnly, async (t) => {
  for (const kind of ['recovery', 'unsafe']) {
    const h = harness(t, { kind, pendingMs: 310_000 });
    const report = await observeOnce(base, h.targets, h.deps);
    assert.equal(report.run.stopReason, 'DECISION_FAILURE');
    assert.equal(h.signals().length, 1);
    assert.equal(h.events().filter((event) => event.action).length, 0, 'the runner answers nothing for the failed AI decision');
    assert.deepEqual(report.criteria.o3.unresolved, { status: kind === 'unsafe' ? 'unsafe' : 'recovery_required', elapsedMs: 310_000 });
    assert.equal(report.criteria.o3.overHard300s, 1, 'the failed decision\'s observed wait is counted');
    assert.equal(report.criteria.o3.pass, false);
    assert.equal(report.criteria.o4.pass, false);
    assert.deepEqual(leaks(h.targets.out), []);
  }
});

test('observe: a halt ends the run as an observed failure with at most one SIGTERM', posixOnly, async (t) => {
  const h = harness(t, { kind: 'halt' });
  const report = await observeOnce(base, h.targets, h.deps);
  // 가짜 loop는 halt를 쓰고 스스로 끝난다. 러너가 halt를 먼저 보면 SIGTERM 한 번을 보낸다 — 어느 쪽이든 재시도는 없다.
  assert.ok(h.signals().length <= 1);
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(report.run.finalHalt, 'FAKE_HALT');
  assert.equal(report.criteria.o4.pass, false);
});

test('observe: the call threshold, the budget and the boot timeout each stop the loop with one SIGTERM', posixOnly, async (t) => {
  const cap = harness(t, { kind: 'calls' });
  const capped = await observeOnce({ ...base, maxPlayerCalls: 20 }, cap.targets, cap.deps);
  assert.equal(capped.run.stopReason, 'CALL_CAP');
  assert.equal(cap.signals().length, 1);
  assert.ok(capped.run.playerCallsAtStop >= 20);
  // boot-hang은 loop-state를 쓴 뒤(핸들러 설치 뒤) bootstrap에 머문다. 기동이 느려도 신호는 state가 생긴 뒤에만 간다.
  const boot = harness(t, { kind: 'boot-hang' });
  const booted = await observeOnce({ ...base, bootTimeoutMs: 300 }, boot.targets, boot.deps);
  assert.equal(booted.run.stopReason, 'BOOT_TIMEOUT');
  assert.equal(booted.run.playingAfterMs, null);
  assert.equal(boot.signals().length, 1);
  const budget = harness(t, { kind: 'boot-hang' });
  const spent = await observeOnce({ ...base, budgetMs: 300 }, budget.targets, budget.deps);
  assert.equal(spent.run.stopReason, 'BUDGET');
  for (const report of [capped, booted, spent]) {
    assert.equal(report.run.terminationConfirmed, true);
    assert.equal(report.run.exit.signal, null, 'stopped by its own handler, not by the default signal action');
    assert.equal(report.criteria.o0.pass, false);
  }
});

test('observe: a stop before the loop wrote its state waits for the handler, then signals once', posixOnly, async (t) => {
  const controller = new AbortController();
  const h = harness(t, { kind: 'done', stateDelayMs: 300 }, { stopSignal: controller.signal });
  controller.abort();
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'OPERATOR_STOP');
  assert.equal(report.run.preHandler, false);
  // 핸들러 전에 SIGTERM이 갔다면 가짜 loop는 기본 동작으로 죽어 신호 기록도 없고 exit.signal이 SIGTERM이다.
  assert.equal(h.signals().length, 1, 'the signal reached the installed handler');
  assert.deepEqual(report.run.exit, { code: 0, signal: null });
});

test('observe: a loop that never installs its handler is never signalled and is recorded unconfirmed', posixOnly, async (t) => {
  const h = harness(t, { kind: 'never-state', release: true }, { stopGraceMs: 300 });
  const report = await observeOnce({ ...base, bootTimeoutMs: 200 }, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'BOOT_TIMEOUT');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.preHandler, true);
  assert.equal(h.signals().length, 0, 'no signal before the handler exists');
  assert.equal(report.run.study.code, 'LOOP_ALIVE');
});

test('observe: a loop that ignores SIGTERM is left alive and recorded unconfirmed — no SIGKILL, no study stop, store kept', posixOnly, async (t) => {
  const controller = new AbortController();
  const h = harness(t, { kind: 'ignore-term', release: true }, { stopSignal: controller.signal, stopGraceMs: 300 });
  h.ready().then(() => controller.abort());
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'OPERATOR_STOP');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.exit, null);
  assert.equal(alive(report.run.loopPid), true, 'the runner sends no SIGKILL');
  assert.equal(h.signals().length, 1, 'exactly one SIGTERM');
  assert.deepEqual(h.studyCalls, [], 'the study service is left to the live loop');
  assert.equal(fs.existsSync(path.join(h.targets.storeDir, '.session-store')), true);
});

test('observe: an unverified relay gets no token and the human seat is never answered', posixOnly, async (t) => {
  const h = harness(t, { kind: 'done', badLock: true });
  const report = await observeOnce({ ...base, budgetMs: 1500 }, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'BUDGET');
  assert.equal(h.events().filter((event) => event.action || event.request).length, 0, 'no request reached the relay');
  assert.ok(report.run.relayUnverified.LOCK_STATE_MISMATCH > 0);
  const refused = harness(t, { kind: 'done' }, { listenerOwnedBy: async () => false });
  const denied = await observeOnce({ ...base, budgetMs: 1500 }, refused.targets, refused.deps);
  assert.equal(refused.events().filter((event) => event.action || event.request).length, 0);
  assert.ok(denied.run.relayUnverified.LISTENER_MISMATCH > 0);
  assert.equal(denied.seat.unsent > 0, true);
});

test('observe: an exception inside supervision takes the same stop path — one SIGTERM, cleanup, a report', posixOnly, async (t) => {
  const h = harness(t, { kind: 'done' }, { readHumanTurn: () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.stopReason, 'RUNNER_ERROR');
  assert.deepEqual(report.run.runnerErrors, ['EIO']);
  assert.equal(h.signals().length, 1);
  assert.equal(report.run.terminationConfirmed, true);
  assert.equal(h.studyCalls.length, 2);
  assert.ok(report.criteria.o0.reasons.includes('RUNNER_ERROR'));
});

test('observe: an error after spawn (a failed signal delivery) is not an exit — wait, then unconfirmed, unref, no study stop', posixOnly, async (t) => {
  const controller = new AbortController();
  const failedSignal = (child) => child.emit('error', Object.assign(new Error('kill failed'), { code: 'EPERM' }));
  const h = harness(t, { kind: 'ignore-term', release: true }, { stopSignal: controller.signal, stopGraceMs: 300, signal: failedSignal });
  h.ready().then(() => controller.abort());
  const report = await observeOnce(base, h.targets, h.deps);
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.exit, null);
  assert.deepEqual(report.run.childErrors, ['EPERM']);
  assert.equal(h.signals().length, 0, 'the delivery failed, so the loop saw no signal');
  assert.deepEqual(h.studyCalls, []);
  assert.equal(h.unrefs(), 1, 'the runner lets go of the live child');
  assert.ok(report.criteria.o0.reasons.includes('CHILD_ERROR'));
});

// 이벤트 순서를 결정적으로 만드는 가짜 ChildProcess. spawnLoop가 세션 파일을 동기로 써 두어 "핸들러 설치 뒤" 상태를 만든다.
function scriptedChild(t, { spawnEvent, killError, exitAfterKillMs = null, errorBeforeSpawn = false, stopGraceMs = 200 }) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const targets = { storeDir: path.join(dir, 'store'), out: path.join(dir, 'out.json') };
  const child = new EventEmitter();
  child.pid = 4_000_001;
  child.kills = [];
  child.unrefs = 0;
  child.unref = () => { child.unrefs += 1; };
  child.kill = (name) => {
    child.kills.push(name);
    if (killError) child.emit('error', Object.assign(new Error('kill failed'), { code: 'EPERM' }));
    if (exitAfterKillMs !== null) setTimeout(() => child.emit('exit', 0, null), exitAfterKillMs);
    return false;
  };
  const studyCalls = [];
  let writes = 0;
  const deps = {
    spawnLoop: (args) => {
      const store = args[args.indexOf('--store-dir') + 1];
      const session = path.join(store, '.session-store', 'sessions', 'g1');
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(store, '.session-store', 'current.json'), JSON.stringify({ sessionRel: 'sessions/g1' }));
      fs.writeFileSync(path.join(session, 'loop-state.json'), JSON.stringify({ phase: 'bootstrap' }));
      if (errorBeforeSpawn) process.nextTick(() => child.emit('error', Object.assign(new Error('early'), { code: 'EPERM' })));
      if (spawnEvent === 'nextTick') process.nextTick(() => child.emit('spawn'));
      return child;
    },
    // manifest 쓰기를 실패시켜 첫 동기 감시 단계에서 바로 정지 경로로 들어가게 한다.
    writeReport: () => { writes += 1; if (writes === 1) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
    inspectStudy: async (store) => { studyCalls.push(store); return { status: 'stopped' }; },
    stopStudy: async () => {},
    environment: { sha: () => null, codexVersion: () => null, loadavg: () => [0, 0, 0], codexProcesses: () => 0 },
    identityStatus: () => 'dead', listenerOwnedBy: async () => false, pollMs: 10, stopGraceMs,
  };
  return { targets, deps, child, studyCalls };
}

test('observe: before the spawn is confirmed no signal goes; a stop then ends unconfirmed with unref and no study stop', async (t) => {
  const s = scriptedChild(t, { spawnEvent: 'never', killError: true });
  const report = await observeOnce(base, s.targets, s.deps);
  assert.equal(report.run.stopReason, 'RUNNER_ERROR');
  assert.deepEqual(s.child.kills, [], 'no signal to a child whose spawn was never confirmed');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(report.run.exit, null);
  assert.equal(s.child.unrefs, 1);
  assert.deepEqual(s.studyCalls, []);
});

test('observe: an error from a child that has a pid is never a spawn failure, even before any spawn event', async (t) => {
  const s = scriptedChild(t, { spawnEvent: 'never', killError: false, errorBeforeSpawn: true });
  const report = await observeOnce(base, s.targets, s.deps);
  assert.deepEqual(report.run.childErrors, ['EPERM']);
  assert.equal(report.run.exit, null, 'not recorded as a spawn failure');
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(s.child.unrefs, 1);
  assert.deepEqual(s.studyCalls, []);
});

test('observe: a kill error raised synchronously is never taken for an exit, even right after the spawn event', async (t) => {
  const s = scriptedChild(t, { spawnEvent: 'nextTick', killError: true });
  const report = await observeOnce(base, s.targets, s.deps);
  assert.deepEqual(s.child.kills, ['SIGTERM']);
  assert.deepEqual(report.run.childErrors, ['EPERM']);
  assert.equal(report.run.exit, null);
  assert.equal(report.run.terminationConfirmed, false);
  assert.equal(s.child.unrefs, 1);
  assert.deepEqual(s.studyCalls, []);
});

test('observe: after a child error the runner waits for the real exit, then cleans up and fails O0 with CHILD_ERROR', async (t) => {
  // 유예(10초)를 exit 지연(50ms)보다 훨씬 길게 두어 느린 이벤트 루프에서도 종료 미확인으로 새지 않게 한다.
  const s = scriptedChild(t, { spawnEvent: 'nextTick', killError: true, exitAfterKillMs: 50, stopGraceMs: 10_000 });
  const report = await observeOnce(base, s.targets, s.deps);
  assert.deepEqual(report.run.exit, { code: 0, signal: null });
  assert.equal(report.run.terminationConfirmed, true);
  assert.deepEqual(report.run.childErrors, ['EPERM']);
  assert.equal(s.child.unrefs, 0);
  assert.equal(s.studyCalls.length, 1, 'study cleanup only after the real exit');
  assert.ok(report.criteria.o0.reasons.includes('CHILD_ERROR'));
});

test('observe: a failed manifest write takes the stop path; a failed final write keeps the report for stdout', posixOnly, async (t) => {
  let calls = 0;
  const failFirst = harness(t, { kind: 'done' }, { writeReport: () => { calls += 1; if (calls === 1) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  const stopped = await observeOnce(base, failFirst.targets, failFirst.deps);
  assert.equal(stopped.run.stopReason, 'RUNNER_ERROR');
  assert.deepEqual(stopped.run.runnerErrors, ['ENOSPC']);
  assert.equal(stopped.run.terminationConfirmed, true);
  assert.equal(failFirst.signals().length, 1);
  assert.equal(stopped.run.outputError, null);
  let writes = 0;
  const failLast = harness(t, { kind: 'done' }, { writeReport: () => { writes += 1; if (writes === 2) throw Object.assign(new Error('io'), { code: 'EIO' }); } });
  const out = [];
  const code = await main(['--live', '--store-dir', failLast.targets.storeDir, '--out', failLast.targets.out, '--hands', '3', '--ai', '2', '--pace', 'instant'],
    { stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} }, deps: { ...failLast.deps, signalSource: new EventEmitter() } });
  assert.equal(code, 1);
  const printed = JSON.parse(out.join(''));
  assert.equal(printed.run.outputError, 'EIO');
  assert.equal(printed.criteria.pass, true, 'the full report survives on stdout without --json');
});

test('observe: a relay alive under its recorded identity, a failed study cleanup and a spawn error each fail O0', posixOnly, async (t) => {
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
  assert.ok(spawned.criteria.o0.reasons.includes('SPAWN_FAILED'));
});

test('observe: an off-target model, a rejected reply and slow whole decisions are judged from the loop records', posixOnly, async (t) => {
  const luna = harness(t, { kind: 'done', model: 'gpt-6-luna' });
  assert.ok((await observeOnce(base, luna.targets, luna.deps)).criteria.o0.reasons.includes('NOT_TARGET_RUNTIME'));
  const upper = harness(t, { kind: 'done', upperRuntime: 'claude' });
  assert.ok((await observeOnce(base, upper.targets, upper.deps)).criteria.o0.reasons.includes('NOT_TARGET_RUNTIME'));
  const rejected = harness(t, { kind: 'done', rejected: 1 });
  const legality = (await observeOnce(base, rejected.targets, rejected.deps)).criteria;
  assert.deepEqual([legality.o5.pass, legality.o5.decisionRejected, legality.pass], [false, 1, false]);
  // 결정 9개 중 하나가 결정 전체 40초다(호출은 20초) — 호출 단위로는 25초 초과가 없어도 결정 단위로 센다.
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

test('criteria: thresholds use the raw fractional waits; only displayed values are rounded', () => {
  const metrics = metricsOf([...Array(94).fill(4000), ...Array(5).fill(26_000), 25_000.1]);
  assert.equal(metrics.overSoft25s, 6, '25,000.1 ms is over 25 s');
  assert.equal(judge([warm(), decide(100)], { metrics }).o3.pass, false, '6 % is over the 5 % bound');
  const hard = metricsOf([...Array(99).fill(4000), 300_000.1]);
  assert.deepEqual([hard.overHard300s, hard.maxMs], [1, 300_000]);
  assert.equal(judge([warm(), decide(100)], { metrics: hard }).o3.pass, false);
  assert.deepEqual([metricsOf([25_000, 300_000]).overSoft25s, metricsOf([25_000, 300_000]).overHard300s], [1, 0], 'the bounds themselves are not over');
});

test('criteria: a decision left unresolved keeps its observed wait in O3 and blocks a pass', () => {
  const pending = judge([warm(), decide(100)], { finalPending: { status: 'recovery_required', code: 'TIMEOUT', elapsedMs: 40_000 } });
  assert.deepEqual(pending.o3.unresolved, { status: 'recovery_required', elapsedMs: 40_000 });
  assert.equal(pending.o3.overSoft25s, 1);
  assert.equal(pending.o3.pass, false);
  const unknown = judge([warm(), decide(100)], { finalPending: { status: 'unsafe', code: 'CHILD_SIGNAL_FAILED', elapsedMs: null } });
  assert.equal(unknown.o3.overSoft25s, 0, 'an unobserved wait is not counted as fast or slow');
  assert.equal(unknown.o3.pass, false);
});

test('CLI: without --live only the plan is printed and nothing is spawned; argument, target and platform errors exit 2', async (t) => {
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
  const windows = io();
  assert.equal(await main(['--live', '--store-dir', path.join(dir, 's'), '--out', path.join(dir, 'o.json')], { ...windows, deps: { ...deps, platform: 'win32' } }), 2);
  assert.match(windows.out.join(''), /PLATFORM_UNSUPPORTED/);
  assert.equal(spawned, 0);
  assert.equal(fs.existsSync(path.join(dir, 's')), false);
  assert.equal(fs.existsSync(path.join(dir, 'o.json')), false);
});

test('CLI: exit 0 for a pass, 3 for a run that is not a pass, 1 for an unconfirmed termination or a spawn error', posixOnly, async (t) => {
  const io = () => ({ stdout: { write: () => {} }, stderr: { write: () => {} } });
  const run = async (scenario, extra = [], depsExtra = {}) => {
    const h = harness(t, scenario, depsExtra);
    const code = await main(['--live', '--store-dir', h.targets.storeDir, '--out', h.targets.out, '--hands', '3', '--ai', '2', '--pace', 'instant', ...extra],
      { ...io(), deps: { ...h.deps, signalSource: new EventEmitter() } });
    return { code, h };
  };
  assert.equal((await run({ kind: 'done' })).code, 0);
  assert.equal((await run({ kind: 'recovery' })).code, 3);
  assert.equal((await run({ kind: 'ignore-term', release: true }, ['--budget-ms', '300'], { stopGraceMs: 300 })).code, 1);
  const missing = { spawnLoop: (args, { stdout, stderr }) => spawn('/nonexistent/holdem-loop', args, { stdio: ['ignore', stdout, stderr] }) };
  assert.equal((await run({ kind: 'done' }, [], missing)).code, 1);
});

test('CLI: an operator signal stops the loop once and still writes the report', posixOnly, async (t) => {
  const signals = new EventEmitter();
  const h = harness(t, { kind: 'boot-hang' });
  const code = main(['--live', '--store-dir', h.targets.storeDir, '--out', h.targets.out, '--hands', '3', '--ai', '2'],
    { stdout: { write: () => {} }, stderr: { write: () => {} }, deps: { ...h.deps, signalSource: signals } });
  // boot-hang은 준비 줄을 남기지 않는다. loop-state가 생긴 뒤 신호를 보낸다.
  const until = Date.now() + 15_000;
  while (!fs.existsSync(path.join(h.targets.storeDir, '.session-store', 'current.json')) && Date.now() < until) await sleep(10);
  signals.emit('SIGINT');
  assert.equal(await code, 3);
  assert.equal(JSON.parse(fs.readFileSync(h.targets.out, 'utf8')).run.stopReason, 'OPERATOR_STOP');
  assert.equal(h.signals().length, 1);
});
