import { test } from 'node:test';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameEpochOf } from '../publish-contract.js';
import { createGameLoop } from '../tools/game-loop.js';
import { resolveRuntimes } from '../tools/player-runtime.js';
import { decide, stampPlayerPolicies } from '../tools/policy-player.js';
import { assignmentFor, policyById } from '../training/policies/catalog.js';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');

function tmp() {
  return createOwnedTempDir('holdem-policy-loop');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

test('policy bootstrap skips player warmup, stamps policy, hides seed from view', async (t) => {
  const gameDir = tmp();
  let need = null;
  const loop = createGameLoop({
    gameDir,
    resolver: async (input) => {
      need = input.need;
      return { player: null, upper: null, notices: [] };
    },
    opts: { port: 0, waitMs: 0, opponentRuntime: 'policy' },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100, opponentRuntime: 'policy' });
  assert.equal(need, 'upper-only');
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  const players = readJson(path.join(gameDir, 'players.json'));
  assert.ok(players[1].policy.policyId);
  assert.match(players[1].policy.configDigest, /^[0-9a-f]{64}$/);
  const state = readJson(path.join(gameDir, 'state.json'));
  assert.match(state.policySeed, /^[0-9a-f]{64}$/);
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.opponentRuntime, 'policy');
});

test('policy resume re-stamps seats missing after init crash and reproduces init actions', { timeout: 15_000 }, async (t) => {
  const gameDir = tmp();
  const init = JSON.parse(execFileSync(process.execPath, [
    ENGINE, 'init', '--ai', '2', '--opponent-runtime', 'policy', '--game-dir', gameDir,
  ], { encoding: 'utf8' }).trim());
  const unstamped = readJson(path.join(gameDir, 'players.json'));
  assert.equal(unstamped.some((player) => player.playerId !== 'user' && player.policy), false);
  const expected = unstamped.map((player) => (
    player.playerId === 'user' ? player : { ...player, policy: assignmentFor(player.archetype) }
  ));

  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap',
    sessionToken: init.sessionToken,
    gameEpoch: gameEpochOf(init.sessionToken),
    ownerSessionId: '00000000-0000-4000-8000-000000000000',
    opponentRuntime: 'policy',
    startedAt: '2026-09-02T00:00:00.000Z',
    notices: [],
    metrics: [],
  }));

  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 0, opponentRuntime: 'policy' },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  const resumed = await loop.resume();
  assert.equal(resumed.phase, 'playing');

  const stamped = readJson(path.join(gameDir, 'players.json'));
  for (const player of stamped.filter((row) => row.playerId !== 'user')) {
    assert.deepEqual(player.policy, assignmentFor(player.archetype));
  }
  assert.deepEqual(
    stamped.filter((row) => row.playerId !== 'user').map((row) => row.policy),
    expected.filter((row) => row.playerId !== 'user').map((row) => row.policy),
  );

  const seed = readJson(path.join(gameDir, 'state.json')).policySeed;
  const epoch = gameEpochOf(init.sessionToken);
  const snapshot = {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    street: 'preflop',
    holeCards: ['Ah', 'Ad'],
    board: [],
    blinds: [50, 100],
    toCall: 0,
    position: 'UTG',
    publicSeats: stamped.map((player) => ({ playerId: player.playerId, out: false })),
    priorActions: [],
    effectiveStack: 10000,
  };
  const legal = {
    canCheck: false, canRaise: true, callAmount: 50, minRaiseTo: 200, maxRaiseTo: 10000,
  };
  const seat = stamped.find((player) => player.playerId === 'p1');
  const fromResume = decide({
    snapshot, legal, policy: seat.policy, policySeed: seed, gameEpoch: epoch,
  });
  const fromInit = decide({
    snapshot, legal, policy: assignmentFor(seat.archetype), policySeed: seed, gameEpoch: epoch,
  });
  assert.deepEqual(fromResume, fromInit);
  stampPlayerPolicies(gameDir);
  assert.deepEqual(readJson(path.join(gameDir, 'players.json')), stamped);
});

test('game-loop policy stamps pass appendNotice at bootstrap and both resume sites', () => {
  const src = fs.readFileSync(new URL('../tools/game-loop.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/stampPlayerPolicies\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.match(args, /onNotice:\s*appendNotice/);
  }
});

test('early learning defaults preserve a legacy v1 policy session on resume', { timeout: 15000 }, async (t) => {
  const gameDir = tmp();
  execFileSync(process.execPath, [ENGINE, 'init', '--ai', '2', '--stack', '900', '--opponent-runtime', 'policy', '--game-dir', gameDir], {
    encoding: 'utf8', timeout: 10000,
  });
  const playersPath = path.join(gameDir, 'players.json');
  const players = readJson(playersPath);
  const policy = policyById('baseline-v1');
  for (const player of players) {
    if (player.playerId !== 'user') player.policy = {
      policyId: policy.policyId, policyVersion: policy.policyVersion, configDigest: policy.configDigest,
    };
  }
  fs.writeFileSync(playersPath, JSON.stringify(players));
  const beforePlayers = fs.readFileSync(playersPath);
  const before = readJson(path.join(gameDir, 'state.json'));
  let need;
  const loop = createGameLoop({ gameDir, opts: { port: 0 }, resolver: async (input) => {
    need = input.need;
    return { player: null, upper: null, notices: [] };
  } });
  t.after(() => loop.requestStop());
  const resumed = await loop.resume();
  assert.equal(need, 'upper-only');
  assert.equal(resumed.opponentRuntime, 'policy');
  assert.deepEqual(fs.readFileSync(playersPath), beforePlayers);
  const after = readJson(path.join(gameDir, 'state.json'));
  assert.deepEqual(after.config, before.config);
  assert.equal(after.policySeed, before.policySeed);
  assert.equal(fs.existsSync(path.join(gameDir, '.player-sessions.json')), false);
  const pid = loop.serverPid;
  await loop.requestStop();
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
});

test('policy mode reaches done without an LLM player runtime', { timeout: 40_000 }, async (t) => {
  const gameDir = tmp();
  const loop = createGameLoop({
    gameDir,
    resolver: ({ need, canaryAbsPath, registerAdapter }) => resolveRuntimes({
      need, canaryAbsPath, onAdapterCreated: registerAdapter,
      createRuntime: (kind) => ({
        kind,
        async probe() { return { ok: false, upper: false, containment: false }; },
        async dispose() {},
      }),
    }),
    opts: { port: 0, waitMs: 40, opponentRuntime: 'policy' },
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
  const running = loop.run();
  running.catch(() => {});
  const sent = new Set();
  const driver = (async () => {
    for (let i = 0; i < 80; i += 1) {
      const loopState = readJson(path.join(gameDir, 'loop-state.json'));
      if (loopState.phase === 'done' || loopState.halt) return;
      try {
        const { lock, snapshot } = await waitForUserSnapshot(gameDir, 400);
        const decisionId = snapshot.view.legal.decisionId;
        if (!sent.has(decisionId)) {
          sent.add(decisionId);
          const legal = snapshot.view.legal;
          await postUserAction(lock, {
            decisionId,
            action: legal.canCheck ? 'check' : 'fold',
          });
        }
      } catch { /* AI turn or terminal */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const finished = await running;
  await driver;
  assert.equal(finished.phase, 'done');
  assert.ok(finished.notices.some((notice) => /LLM.*코치.*리뷰/.test(notice)));
  assert.equal(finished.notices.some((notice) => notice.includes('리뷰는 생성되지 않습니다')), false);
  const review = fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8');
  assert.match(review, /LLM.*설명.*제공할 수 없/);
  assert.match(review, /플레이한 핸드/);
  assert.match(review, /설정된 성향/);
  assert.match(review, /관찰/);
  assert.doesNotMatch(review, /agentHandle|policyModelKind|policyTraitsEvidence|"playerId"|"vpip"|machine-only|"kind"/);
  assert.match(review, /## 각 AI의 실제 아키타입 공개/);
  assert.equal(review.includes(readJson(path.join(gameDir, 'state.json')).policySeed), false);
});

test('self-opponent policy game assigns seats, reviews them, and keeps identity private until done', { timeout: 120_000 }, async (t) => {
  const { collectStoreTendency } = await import('../tools/self-opponents.js');
  const { readGeneratedRecord } = await import('./helpers/gen-hh-fixtures.js');
  const storeDir = tmp();
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  fs.mkdirSync(path.join(sessionDir, 'hands'), { recursive: true });
  const record = readGeneratedRecord('uncalled');
  for (let i = 0; i < 60; i += 1) {
    fs.writeFileSync(
      path.join(sessionDir, 'hands', `hand-${String(i + 1).padStart(4, '0')}.json`),
      `${JSON.stringify(record)}\n`,
    );
  }
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    gameOver: true,
    seats: [{ playerId: 'user' }, { playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }, { playerId: 'p4' }, { playerId: 'p5' }],
    config: { mode: 'cash-training', aiCount: 5 },
    policySeed: 'ab'.repeat(32),
  }));
  const collected = collectStoreTendency(storeDir);
  assert.equal(collected.tendency.hands, 60);

  const gameDir = tmp();
  const privacy = /SelfMirror|SelfExploiter|self-mirror-v1|self-exploiter-v1|strategy-mirror-v1|mirror-[a-z0-9]|observed-tendency/;
  const loop = createGameLoop({
    gameDir,
    resolver: ({ need, canaryAbsPath, registerAdapter }) => resolveRuntimes({
      need, canaryAbsPath, onAdapterCreated: registerAdapter,
      createRuntime: (kind) => ({
        kind,
        async probe() { return { ok: false, upper: false, containment: false }; },
        async dispose() {},
      }),
    }),
    opts: {
      port: 0,
      waitMs: 40,
      opponentRuntime: 'policy',
      selfOpponents: {
        requested: { mirror: true, exploiter: true },
        tendency: collected.tendency,
        sources: collected.sources,
        chooseSeat: () => 0,
      },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 3,
    mode: 'cash-training',
    stackBb: 100,
    blinds: '50/100',
    hands: 20,
    opponentRuntime: 'policy',
  });
  const assigned = readJson(path.join(gameDir, 'players.json'));
  const mirror = assigned.find((row) => row.archetype === 'SelfMirror');
  const exploiter = assigned.find((row) => row.archetype === 'SelfExploiter');
  assert.ok(mirror);
  assert.ok(exploiter);
  const digest = mirror.policy.configDigest;
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.doesNotMatch(JSON.stringify(loopState), privacy);
  assert.equal(JSON.stringify(loopState).includes(mirror.playerId), false);

  const running = loop.run();
  running.catch(() => {});
  const sent = new Set();
  const driver = (async () => {
    for (let i = 0; i < 4000; i += 1) {
      const state = readJson(path.join(gameDir, 'loop-state.json'));
      if (state.phase === 'done' || state.halt) return;
      try {
        const { lock, snapshot } = await waitForUserSnapshot(gameDir, 250);
        const decisionId = snapshot.view.legal.decisionId;
        if (!sent.has(decisionId)) {
          sent.add(decisionId);
          const legal = snapshot.view.legal;
          await postUserAction(lock, {
            decisionId,
            action: legal.canCheck ? 'check' : 'fold',
          });
        }
      } catch { /* AI turn or terminal */ }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  const finished = await running;
  await driver;
  assert.equal(finished.phase, 'done');
  const review = fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8');
  assert.match(review, /## 나를 닮은 상대와의 비교/);
  assert.match(review, /## 나를 공략한 상대/);
  assert.match(review, new RegExp(mirror.name));
  assert.doesNotMatch(review, /agentHandle|policyModelKind|policyTraitsEvidence|"playerId"|"vpip"|machine-only|"kind"/);
  const snapshotPath = path.join(gameDir, 'ui-snapshot.json');
  if (fs.existsSync(snapshotPath)) {
    const published = fs.readFileSync(snapshotPath, 'utf8');
    assert.doesNotMatch(published, privacy);
    assert.equal(published.includes(digest), false);
  }
  assert.doesNotMatch(JSON.stringify(readJson(path.join(gameDir, 'loop-state.json'))), privacy);
  const handsDir = path.join(gameDir, 'hands');
  const handFiles = fs.existsSync(handsDir) ? fs.readdirSync(handsDir).filter((name) => name.startsWith('hand-')) : [];
  assert.equal(handFiles.length, 20);
  let sawMirrorAction = false;
  for (const name of handFiles) {
    const hand = readJson(path.join(handsDir, name));
    for (const action of hand.actions ?? []) {
      if (action.playerId === mirror.playerId && action.policyId) {
        assert.equal(action.policyId, 'self-mirror-v1');
        sawMirrorAction = true;
      }
    }
  }
  assert.equal(sawMirrorAction, true);
});


test('hint-enabled policy sidecar publishes only after durable exposure', {timeout:40_000},async t=>{
 const {resolveSessionReference}=await import('../tools/reference-source.js');
 const gameDir=tmp();
 const loop=createGameLoop({gameDir,resolver:async()=>({player:null,upper:null,notices:[]}),
  opts:{port:0,waitMs:10_000,opponentRuntime:'policy',hints:'on'}});
 t.after(()=>loop.requestStop().catch(()=>{}));
 // Start without a relay so the fixed session source exists before its readiness probe.
 await loop.bootstrap({ai:5,mode:'cash-training',stackBb:100,hands:1,opponentRuntime:'policy',hints:'on'});
 resolveSessionReference(gameDir,{createNew:true});
 // Restart the owned relay to validate the newly installed fixture source.
 await loop.requestStop();
 const resumed=createGameLoop({gameDir,resolver:async()=>({player:null,upper:null,notices:[]}),
  opts:{port:0,waitMs:10_000,opponentRuntime:'policy',hints:'on'}});
 t.after(()=>resumed.requestStop().catch(()=>{}));
 await resumed.resume();
 const running=resumed.run();running.catch(()=>{});
 const {snapshot}=await waitForUserSnapshot(gameDir,20_000);
 assert.ok(snapshot.hint,'sidecar publishes a supported or explicit unsupported hint');
 if(snapshot.hint.status==='supported') {
  const state=readJson(path.join(gameDir,'state.json'));
  assert.equal(state.hand.hintExposures[snapshot.hint.decisionId].exposureId,snapshot.hint.exposureId);
 }
 await resumed.requestStop();await running;
});
