import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameEpochOf } from '../publish-contract.js';
import { createGameLoop } from '../tools/game-loop.js';
import { stampPlayerPolicies } from '../tools/policy-player.js';
import { assignmentFor } from '../training/policies/catalog.js';
import {
  readJson,
  tmpQ3,
  writeJson,
} from './helpers/q3-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine', 'cli.js');

function seedFinalizingPolicyResume(t, { stamp = false } = {}) {
  const gameDir = tmpQ3('holdem-q3-policy-resume-');
  t.after(() => fs.rmSync(gameDir, { recursive: true, force: true }));
  const initialized = JSON.parse(execFileSync(process.execPath, [
    ENGINE,
    'init',
    '--ai', '2',
    '--opponent-runtime', 'policy',
    '--game-dir', gameDir,
  ], { encoding: 'utf8' }).trim());
  if (stamp) stampPlayerPolicies(gameDir);
  writeJson(path.join(gameDir, 'loop-state.json'), {
    phase: 'finalizing',
    handNo: 0,
    port: null,
    sessionToken: initialized.sessionToken,
    gameEpoch: gameEpochOf(initialized.sessionToken),
    ownerSessionId: 'owner-before-q3-resume',
    stopping: false,
    lastPublishId: null,
    playerRuntime: null,
    upperRuntime: null,
    opponentRuntime: 'policy',
    startedAt: '2026-09-04T00:00:00.000Z',
    notices: [],
    metrics: [],
  });
  return { gameDir, initialized };
}

function testLoopLock(gameDir) {
  const dir = path.join(gameDir, 'loop.lock.d');
  const startTime = 'q3-test-owned-lock';
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pid'), `${process.pid}\n${startTime}`);
  const stat = fs.statSync(dir, { bigint: true });
  return { dir, pid: process.pid, startTime, dev: stat.dev, ino: stat.ino };
}

function loopForInvalidServerPort(gameDir) {
  return createGameLoop({
    gameDir,
    initialLockHandle: testLoopLock(gameDir),
    resolver: async ({ need }) => {
      assert.equal(need, 'upper-only');
      return { player: null, upper: null, notices: [] };
    },
    opts: {
      port: 70_000,
      waitMs: 0,
      opponentRuntime: 'policy',
      trainingEnabled: true,
    },
  });
}

test('Q3 M15: finalizing policy resume re-stamps before attempting to start the server', async (t) => {
  const { gameDir } = seedFinalizingPolicyResume(t);
  const before = readJson(path.join(gameDir, 'players.json'));
  assert.equal(before.some((player) => player.playerId !== 'user' && player.policy), false);
  const loop = loopForInvalidServerPort(gameDir);
  t.after(() => loop.requestStop().catch(() => {}));

  await assert.rejects(loop.resume({ skipLock: true }), { code: 'BAD_SERVER_PORT' });

  const after = readJson(path.join(gameDir, 'players.json'));
  for (const player of after.filter((entry) => entry.playerId !== 'user')) {
    assert.deepEqual(player.policy, assignmentFor(player.archetype));
  }
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);
});

test('Q3 M15: config mismatch fails closed before server or exploit generation', async (t) => {
  const { gameDir } = seedFinalizingPolicyResume(t, { stamp: true });
  const playersPath = path.join(gameDir, 'players.json');
  const players = readJson(playersPath);
  players.find((player) => player.playerId !== 'user').policy.configDigest = '00'.repeat(32);
  writeJson(playersPath, players);
  const loop = loopForInvalidServerPort(gameDir);
  t.after(() => loop.requestStop().catch(() => {}));

  await assert.rejects(loop.resume({ skipLock: true }), { code: 'POLICY_CONFIG_MISMATCH' });

  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false, 'server started before policy validation');
  const annotationDir = path.join(gameDir, 'training', 'annotations');
  const exploitFiles = fs.existsSync(annotationDir)
    ? fs.readdirSync(annotationDir).filter((name) => name.endsWith('.exploit.json'))
    : [];
  assert.deepEqual(exploitFiles, []);
});

test('Q3 M15: matching catalog remains byte-stable across finalizing re-stamp', async (t) => {
  const { gameDir } = seedFinalizingPolicyResume(t, { stamp: true });
  const playersPath = path.join(gameDir, 'players.json');
  const before = fs.readFileSync(playersPath);
  const beforeInode = fs.statSync(playersPath, { bigint: true }).ino;
  const loop = loopForInvalidServerPort(gameDir);
  t.after(() => loop.requestStop().catch(() => {}));

  await assert.rejects(loop.resume({ skipLock: true }), { code: 'BAD_SERVER_PORT' });

  assert.deepEqual(fs.readFileSync(playersPath), before);
  assert.notEqual(
    fs.statSync(playersPath, { bigint: true }).ino,
    beforeInode,
    'matching policy bytes were not re-stamped before the server boundary',
  );
  assert.equal(fs.existsSync(path.join(gameDir, 'lock.json')), false);
});
