import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGameLoop } from '../tools/game-loop.js';
import { createTrainingControl } from '../tools/training-control.js';
import { createProfileStore } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

function tmp() {
  return createOwnedTempDir('holdem-p11');
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
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null },
      { action: 'fold', frequency: 0.15, evBb: null },
    ],
    chosen: { action: 'fold', frequency: 0.15, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'off-policy',
    forced: false,
    source: {
      id: 'local-preflop-baseline', version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
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
  assert.equal(installed.schemaVersion, 2);
  assert.equal(installed.origin, 'game');
  assert.equal(installed.goal.id, 'preflop.rfi.BTN');
  assert.equal(installed.leaks, undefined);
  assert.equal(installed.focus, 'preflop.rfi.BTN');
  assert.equal(
    createTrainingControl({ storeDir }).loadAuthority(sessionA).items[evaluation.evaluationId].consumers.profiled,
    true,
  );
});

test('consumer replay and later practice preserve exactly-once game evidence', async () => {
  const storeDir = createOwnedTempDir('profile-once-store');
  const sessionDir = createOwnedTempDir('profile-once-session');
  const source = {
    id: 'local-preflop-baseline',
    version: '1.0.0',
    contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
  };
  const game = evaluationRow({
    source,
    origin: 'game',
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null },
      { action: 'fold', frequency: 0.15, evBb: null },
    ],
  });
  const tc = createTrainingControl({ storeDir });
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: 'ab'.repeat(32), owner: 'owner-1', handNo: 1, evaluations: [game],
  });
  assert.equal((await tc.consumeTrainingItems(sessionDir, { storeDir })).applied, 1);
  const store = createProfileStore(storeDir);
  const gameBefore = structuredClone((await store.show()).game);
  const eventBytes = fs.readFileSync(store.eventsPath);

  assert.equal((await tc.consumeTrainingItems(sessionDir, { storeDir })).applied, 0);
  assert.deepEqual(fs.readFileSync(store.eventsPath), eventBytes);

  await store.apply(evaluationRow({
    decisionId: 'd-2-preflop-0',
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-2-preflop-0',
      providerId: source.id,
      providerVersion: source.version,
    }),
    payloadSha256: 'bb'.repeat(32),
    source,
    origin: 'practice',
    assistance: {schemaVersion:1,hintShown:false,exposureId:null},
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null },
      { action: 'fold', frequency: 0.15, evBb: null },
    ],
  }));
  const afterPractice = await store.show();
  assert.deepEqual(afterPractice.game, gameBefore);
  assert.equal(afterPractice.practice.overall.evaluatedDecisions, 1);
});
