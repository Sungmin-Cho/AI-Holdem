import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameEpochOf } from '../publish-contract.js';
import { createGameLoop } from '../tools/game-loop.js';
import { decide, stampPlayerPolicies } from '../tools/policy-player.js';
import { assignmentFor } from '../training/policies/catalog.js';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-policy-loop-'));
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

test('policy mode reaches done without an LLM player runtime', { timeout: 40_000 }, async (t) => {
  const gameDir = tmp();
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
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
  const review = fs.readFileSync(path.join(gameDir, 'review.md'), 'utf8');
  assert.match(review, /machine-only/);
  assert.match(review, /## 각 AI의 실제 아키타입 공개/);
  assert.equal(review.includes(readJson(path.join(gameDir, 'state.json')).policySeed), false);
});
