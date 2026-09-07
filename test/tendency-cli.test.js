import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { readGeneratedRecord } from './helpers/gen-hh-fixtures.js';
import { referenceClaimAllowed } from '../shared/reference.js';
import { TENDENCY_MIN_HANDS, assertTendency } from '../training/tendency/contracts.js';
import { collectStoreTendency, listGameOverSessions } from '../tools/self-opponents.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/tendency-cli.js');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeSession(storeDir, gameId, {
  gameOver = true,
  seats = 6,
  mode = 'cash-training',
  opponentRuntime = 'policy',
  records = [],
  extraHandName,
  extraHandBody,
} = {}) {
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', gameId);
  fs.mkdirSync(path.join(sessionDir, 'hands'), { recursive: true });
  const seatList = [{ playerId: 'user', stack: 5000, out: false }];
  for (let i = 1; i < seats; i += 1) seatList.push({ playerId: `p${i}`, stack: 5000, out: false });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    gameOver,
    seats: seatList,
    config: { mode, aiCount: seats - 1 },
    ...(opponentRuntime === 'policy' ? { policySeed: 'ab'.repeat(32) } : {}),
  }));
  fs.writeFileSync(path.join(sessionDir, 'loop-state.json'), JSON.stringify({ opponentRuntime }));
  records.forEach((record, index) => {
    const name = `hand-${String(index + 1).padStart(4, '0')}.json`;
    fs.writeFileSync(path.join(sessionDir, 'hands', name), `${JSON.stringify(record)}\n`);
  });
  if (extraHandName) {
    fs.writeFileSync(path.join(sessionDir, 'hands', extraHandName), extraHandBody);
  }
  return sessionDir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('collectStoreTendency skips live sessions and broken hands and does not touch .training', () => {
  const storeDir = createOwnedTempDir('holdem-tendency-store');
  const record = readGeneratedRecord('uncalled');
  writeSession(storeDir, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    gameOver: true,
    records: [record],
    extraHandName: 'hand-0002.json',
    extraHandBody: '{not-json',
  });
  writeSession(storeDir, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
    gameOver: true,
    records: [record],
    mode: 'tournament',
    opponentRuntime: 'llm',
  });
  writeSession(storeDir, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
    gameOver: false,
    records: [record],
  });

  const listed = listGameOverSessions(storeDir);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((row) => row.gameId).sort(), [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]);

  const first = collectStoreTendency(storeDir);
  assert.equal(first.sources.length, 2);
  assert.equal(first.skippedSessions, 1);
  assert.equal(first.skippedHands, 1);
  assertTendency(first.tendency);
  assert.equal(first.tendency.hands, 2);
  assert.equal(fs.existsSync(path.join(storeDir, '.training')), false);

  const trainingDir = path.join(storeDir, '.training');
  fs.mkdirSync(trainingDir, { recursive: true });
  const marker = path.join(trainingDir, 'profile.json');
  const payload = Buffer.from('{"keep":true}\n');
  fs.writeFileSync(marker, payload);
  const before = sha256(fs.readFileSync(marker));
  const second = collectStoreTendency(storeDir);
  assert.equal(second.sources.length, 2);
  assert.equal(sha256(fs.readFileSync(marker)), before);
});

function storeWithHands(n) {
  const storeDir = createOwnedTempDir(`holdem-tendency-${n}`);
  const record = readGeneratedRecord('uncalled');
  writeSession(storeDir, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    records: Array.from({ length: n }, () => record),
  });
  return storeDir;
}

test('tendency-cli check exits 1 below 60 hands and 0 at 60', () => {
  const short = storeWithHands(59);
  const failed = runCli(['check', '--store-dir', short]);
  assert.equal(failed.status, 1);
  const failLines = failed.stdout.trim().split('\n').filter(Boolean);
  assert.equal(failLines.length, 1);

  const enough = storeWithHands(TENDENCY_MIN_HANDS);
  const passed = runCli(['check', '--store-dir', enough]);
  assert.equal(passed.status, 0);
  const passLines = passed.stdout.trim().split('\n').filter(Boolean);
  assert.equal(passLines.length, 1);
});

test('tendency-cli show --json schema and text pass referenceClaimAllowed', () => {
  const storeDir = storeWithHands(3);
  const jsonRun = runCli(['show', '--store-dir', storeDir, '--json']);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.hands, 3);
  assert.equal(payload.minHands, 60);
  assert.equal(payload.minHandsMet, false);
  assert.equal(typeof payload.sessions, 'number');
  assert.equal(payload.indicators.vpip.n, 3);
  assert.equal(typeof payload.indicators.vpip.rate, 'number');
  assert.equal('traits' in payload, false);

  const textRun = runCli(['show', '--store-dir', storeDir]);
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /핸드/);
  assert.match(textRun.stdout, /자발적 참여|VPIP/);
  assert.equal(referenceClaimAllowed(textRun.stdout), true);
});
