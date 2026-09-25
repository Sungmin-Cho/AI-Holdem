import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSessionManager } from '../tools/session-manager.js';
import { startAppServer } from '../tools/app-server.js';
import { resolveRuntimes } from '../tools/player-runtime.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';

const TIMEOUT = process.platform === 'win32' ? 300000 : 30000;
const PROGRESS_KEYS = ['boot', 'notices', 'pausing', 'upperStatus'];

const cas = (manager, kind = 'start') => {
  const s = manager.snapshot();
  return {
    requestId: randomUUID(), expectedInstanceId: s.instanceId, expectedAppRevision: s.appRevision,
    expectedGameId: s.gameId, expectedSelectionVersion: s.selectionVersion, kind,
  };
};
const settle = async (manager, id) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const row = manager.receipt(id);
    if (row.status !== 'accepted') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('receipt timeout');
};
const until = async (predicate, label) => {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout: ${label}`);
};
const run = async (manager, kind, extra = {}) => {
  const body = { ...cas(manager, kind), ...extra };
  assert.equal(manager.command(body).status, 'accepted');
  const done = await settle(manager, body.requestId);
  assert.equal(done.status, 'succeeded', `${kind}: ${done.error} state=${manager.snapshot().state}`);
};
// Six seats at 100BB keeps the GTO baseline notice out of the way.
const setup = { mode: 'cash-training', aiCount: 5, opponentRuntime: 'policy', hints: 'off', dealBias: 'off' };
const PREVIOUS_GAME_NOTICE = '컨테인먼트 실패(claude/claude-sonnet-5): 도구·MCP 표면이 비어 있지 않습니다.';
const RAW_SECRET = 'decision-meta dropped: /Users/someone/.secret --operator-confirmed 1 (pid: 4242)';

test('host snapshot exposes boot stages and projected notices bound to the launching game', { timeout: TIMEOUT * 2 }, async (t) => {
  const storeDir = createOwnedTempDir('app-snapshot-fields');
  let gate = null;
  const upper = { kind: 'claude', async dispose() {} };
  const stagesAtResolve = [];
  let manager;
  const resolver = async ({ onProbe }) => {
    stagesAtResolve.push(manager.snapshot().boot?.stage);
    if (!gate) return { player: null, upper: null, notices: [PREVIOUS_GAME_NOTICE, RAW_SECRET] };
    onProbe?.({ tier: 'upper', runtime: 'claude', round: 0, ok: null, elapsedMs: 0 });
    await gate.promise;
    return { player: null, upper, notices: [] };
  };
  const seen = [];
  manager = createSessionManager({ storeDir, resolver, onChange: (snap) => seen.push(snap) });
  t.after(() => manager.close());
  await manager.initialize();

  // Game 1: resolver returns an operator notice plus one that must never leak.
  await run(manager, 'start', { setup });
  await until(() => manager.snapshot().state === 'playing', 'game 1 playing');
  const first = manager.snapshot();
  assert.deepEqual(stagesAtResolve, ['runtime-probe'], 'the resolver runs inside the runtime-probe stage');
  assert.equal(manager.session.loop.bootStage.stage, 'ready');
  assert.ok(Date.parse(manager.session.loop.bootStage.startedAt) <= Date.parse(manager.session.loop.bootStage.stageAt));
  assert.equal(first.boot, null, 'boot is only present while starting');
  assert.equal(first.pausing, null);
  assert.equal(first.upperStatus, 'unavailable');
  assert.deepEqual(first.notices.items.map((item) => item.code), ['RUNTIME_CONTAINMENT_FAILED']);
  assert.ok(first.notices.unclassified >= 1);
  assert.doesNotMatch(JSON.stringify(first), /operator-confirmed|4242|\.secret|sonnet/);

  // Pausing carries its start time and per-kind waiting counts.
  await run(manager, 'pause');
  const pausing = seen.find((snap) => snap.state === 'pausing');
  assert.ok(pausing, 'onChange saw the pausing state');
  assert.equal(typeof pausing.pausing.since, 'string');
  assert.deepEqual(Object.keys(pausing.pausing.waitingFor).sort(),
    ['coach', 'evaluate', 'explain', 'other', 'resolver', 'solve', 'training']);
  assert.equal(manager.snapshot().pausing, null, 'pausing is cleared once paused');
  await run(manager, 'end');
  assert.equal(manager.snapshot().upperStatus, null, 'no upper status once the game has ended');

  // Game 2: hold the resolver open and look at the boot screen fields.
  let release;
  gate = { promise: new Promise((resolve) => { release = resolve; }) };
  seen.length = 0;
  const body = { ...cas(manager, 'start'), setup };
  assert.equal(manager.command(body).status, 'accepted');
  const probing = await until(() => {
    const snap = manager.snapshot();
    return snap.state === 'starting' && snap.boot?.stage === 'runtime-probe' && snap.boot.probe ? snap : null;
  }, 'runtime-probe stage');
  assert.deepEqual(probing.boot.probe, { tier: 'upper', runtime: 'claude', round: 0, ok: null, elapsedMs: 0 });
  assert.equal(typeof probing.boot.startedAt, 'string');
  assert.ok(Date.parse(probing.boot.stageAt) >= Date.parse(probing.boot.startedAt));
  assert.deepEqual(probing.notices.items, [], 'the previous game\'s notices never reach the boot screen');
  assert.equal(probing.upperStatus, null);
  const firstStarting = seen.find((snap) => snap.state === 'starting');
  assert.equal(firstStarting.boot.stage, 'preparing');
  assert.equal(firstStarting.notices, null, 'before the new loop exists there is nothing to show');
  release();
  const done = await settle(manager, body.requestId);
  assert.equal(done.status, 'succeeded', done.error);
  await until(() => manager.snapshot().state === 'playing', 'game 2 playing');
  const second = manager.snapshot();
  assert.equal(second.boot, null);
  assert.equal(second.upperStatus, 'ready');
  assert.deepEqual(second.notices.items, []);
  const stages = seen.filter((snap) => snap.state === 'starting').map((snap) => snap.boot.stage);
  assert.equal(stages[0], 'preparing');
  await run(manager, 'pause');
  await run(manager, 'end');
});

test('participant state never carries host progress fields', { timeout: TIMEOUT }, async (t) => {
  const storeDir = createOwnedTempDir('app-snapshot-participant');
  const manager = createSessionManager({ storeDir, resolver: async () => ({ player: null, upper: null, notices: [RAW_SECRET] }) });
  t.after(() => manager.close());
  await manager.initialize();
  const token = 'b'.repeat(64);
  const app = await startAppServer({ manager, token, storeDir, port: 0, publicPort: 0 });
  registerOwnedServer(app.server, 'app-loopback');
  t.after(() => app.close());
  const opened = await fetch(`${app.origin}/api/room`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 6, actionTimeoutSec: 60 }),
  });
  const room = await opened.json();
  assert.equal(opened.status, 200, JSON.stringify(room));
  const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
  const joined = await (await fetch(`${publicOrigin}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: room.joinCode, name: '민준' }),
  })).json();
  assert.ok(joined.participantToken);
  await run(manager, 'start', { setup: { mode: 'cash-training', totalSeats: 6, opponentRuntime: 'policy', hints: 'off', dealBias: 'off' } });
  await until(() => manager.snapshot().state === 'playing', 'playing');
  const host = await (await fetch(`${app.origin}/api/app`, { headers: { authorization: `Bearer ${token}` } })).json();
  for (const key of PROGRESS_KEYS) assert.ok(Object.hasOwn(host, key), `host snapshot has ${key}`);
  const participant = await (await fetch(`${publicOrigin}/api/p/state`, {
    headers: { authorization: `Bearer ${joined.participantToken}` },
  })).json();
  const text = JSON.stringify(participant);
  for (const key of PROGRESS_KEYS) assert.doesNotMatch(text, new RegExp(`"${key}"`), key);
  assert.doesNotMatch(text, /secret|4242/);
  await run(manager, 'pause');
  await run(manager, 'end');
});

test('resolveRuntimes reports probe progress without letting the observer change the outcome', async () => {
  const createRuntime = (kind) => ({
    kind,
    async probe({ upper }) {
      if (kind === 'claude') return { ok: false, notice: `컨테인먼트 실패(${kind}/m): x` };
      if (kind === 'codex' && upper) throw Object.assign(new Error('boom'), { code: 'SPAWN_FAILED' });
      return { ok: true, upper: !!upper, containment: true };
    },
    async dispose() {},
  });
  const events = [];
  const resolved = await resolveRuntimes({
    preferred: 'claude', need: 'upper-only', createRuntime,
    onProbe: (event) => { events.push(event); throw new Error('observer failure must be ignored'); },
  });
  assert.equal(resolved.upper.kind, 'grok');
  assert.deepEqual(events.map(({ tier, runtime, round, ok }) => [tier, runtime, round, ok]), [
    ['upper', 'claude', 0, null], ['upper', 'claude', 0, false],
    ['upper', 'codex', 1, null], ['upper', 'codex', 1, false],
    ['upper', 'grok', 2, null], ['upper', 'grok', 2, true],
  ]);
  for (const event of events) assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
});
