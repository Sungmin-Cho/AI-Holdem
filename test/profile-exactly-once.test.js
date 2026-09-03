import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGameLoop } from '../tools/game-loop.js';
import { createTrainingControl } from '../tools/training-control.js';
import { createProfileStore } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-p11-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sessionDirOf(storeDir, id = '11111111-1111-4111-8111-111111111111') {
  const dir = path.join(storeDir, '.session-store', 'sessions', id);
  fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'loop-state.json'), JSON.stringify({ phase: 'done' }));
  return dir;
}

function evaluationRow(overrides = {}) {
  const decisionId = overrides.decisionId ?? 'd-1-preflop-0';
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    payloadSha256: overrides.payloadSha256 ?? 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null }],
    chosen: { action: 'fold', frequency: 0.15, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'off-policy',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    ...overrides,
  };
}

test('apply-failure injection then resume applies exactly once', async () => {
  const { sweepStore } = await import('../tools/profile-cli.js');
  assert.equal(typeof sweepStore, 'function');
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir);
  const tc = createTrainingControl({ storeDir });
  const evaluation = evaluationRow();
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
  const failed = await sweepStore(storeDir);
  assert.equal((failed.notices ?? []).length >= 1, true);
  assert.equal(tc.loadAuthority(sessionDir).items[evaluation.evaluationId].consumers.profiled, false);
  fs.unlinkSync(path.join(storeDir, '.training', 'profile.json'));
  const resumed = await sweepStore(storeDir);
  assert.equal(resumed.applied, 1);
  assert.equal((await createProfileStore(storeDir).show()).overall.evaluatedDecisions, 1);
  const again = await sweepStore(storeDir);
  assert.equal(again.applied, 0);
  assert.equal((await createProfileStore(storeDir).show()).overall.evaluatedDecisions, 1);
});

test('session A leak is auto-selected as session B practice-focus', { timeout: 15_000 }, async (t) => {
  const storeDir = tmp();
  const sessionA = sessionDirOf(storeDir);
  const evaluation = evaluationRow();
  await createTrainingControl({ storeDir }).acceptEvaluations(sessionA, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  assert.equal(fs.existsSync(path.join(storeDir, '.training', 'practice-focus.json')), false);

  const gameDir = tmp();
  const loop = createGameLoop({
    gameDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: {
      port: 0,
      waitMs: 0,
      storeDir,
      opponentRuntime: 'policy',
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({
    ai: 1,
    stack: 100,
    opponentRuntime: 'policy',
  });
  const installed = readJson(path.join(gameDir, '.practice-focus.json'));
  assert.equal(installed.focus, 'preflop.rfi.BTN');
  assert.equal(
    createTrainingControl({ storeDir }).loadAuthority(sessionA).items[evaluation.evaluationId].consumers.profiled,
    true,
  );
});
