import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameEpochOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import {
  completeSessionStoreMigrations,
  sweepStore,
} from '../tools/profile-cli.js';
import { createTrainingControl } from '../tools/training-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_CLI = path.join(ROOT, 'tools', 'profile-cli.js');
const EPOCH = 'ab'.repeat(32);

function tmp(prefix = 'holdem-q2b-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sessionDirOf(storeDir, id) {
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', id);
  fs.mkdirSync(path.join(sessionDir, 'training'), { recursive: true });
  return sessionDir;
}

function evaluation(decisionId = 'd-1-preflop-0', overrides = {}) {
  const providerId = overrides.source?.id ?? 'local-preflop-baseline';
  const providerVersion = overrides.source?.version ?? '1.0.0';
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: overrides.gameEpoch ?? EPOCH,
      decisionId,
      providerId,
      providerVersion,
    }),
    decisionId,
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
    source: { id: providerId, version: providerVersion },
    ...overrides,
  };
}

function flopSnapshot(decisionId) {
  return {
    schemaVersion: 1,
    decisionId,
    actorId: 'user',
    street: 'flop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    board: ['Ks', 'Qd', '2c'],
    blinds: [50, 100],
    potBefore: 200,
    currentBet: 0,
    actorBet: 0,
    toCall: 0,
    minRaiseTo: 100,
    maxRaiseTo: 10_000,
    effectiveStack: 10_000,
    forced: false,
    publicSeats: ['user', 'p1'].map((playerId) => ({
      playerId,
      out: false,
      folded: false,
      allIn: false,
      stack: 10_000,
      bet: 0,
      contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'check', amount: 0 },
  };
}

function writeLoopPhase(sessionDir, phase) {
  fs.writeFileSync(path.join(sessionDir, 'loop-state.json'), JSON.stringify({ phase }));
}

function writeEmptyAuthority(sessionDir, {
  schemaVersion = 2,
  owner = 'owner-1',
  gameEpoch = EPOCH,
} = {}) {
  fs.mkdirSync(path.join(sessionDir, 'training'), { recursive: true });
  const auth = {
    schemaVersion,
    gameEpoch,
    ownerSessionId: owner,
    items: {},
    publishQueue: {},
    ...(schemaVersion === 2 ? { pending: {}, annotationQueue: {}, solveTasks: {} } : {}),
  };
  fs.writeFileSync(
    path.join(sessionDir, 'training', '.training-authority.json'),
    JSON.stringify(auth),
  );
  fs.writeFileSync(path.join(sessionDir, 'training', 'evaluations.jsonl'), '');
  return auth;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileHashes(root) {
  const out = {};
  const visit = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, rel);
      else out[rel] = sha256(fs.readFileSync(full));
    }
  };
  visit(root);
  return out;
}

test('Q2b reconcile rejects a stale owner before empty-authority reconstruction and preserves bytes', async () => {
  const sessionDir = tmp();
  const tc = createTrainingControl();
  await tc.reconcile(sessionDir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    lastHand: null,
    handsDir: path.join(sessionDir, 'hands'),
  });
  const authorityPath = path.join(sessionDir, 'training', '.training-authority.json');
  const before = fs.readFileSync(authorityPath);

  await assert.rejects(
    tc.reconcile(sessionDir, {
      gameEpoch: EPOCH,
      owner: 'stale-owner',
      lastHand: null,
      handsDir: path.join(sessionDir, 'hands'),
    }),
    { code: 'TRAINING_OWNER_MISMATCH' },
  );

  assert.deepEqual(fs.readFileSync(authorityPath), before);
});

test('Q2b takeoverOwner permits only terminal sweep takeover and records additive history', async () => {
  for (const phase of ['done', 'review_published']) {
    const sessionDir = tmp();
    const tc = createTrainingControl();
    writeEmptyAuthority(sessionDir);
    writeLoopPhase(sessionDir, phase);

    const result = await tc.takeoverOwner(sessionDir, 'sweep-owner', { reason: 'terminal-session' });
    const auth = tc.loadAuthority(sessionDir);

    assert.equal(result.transferred, true);
    assert.equal(auth.ownerSessionId, 'sweep-owner');
    assert.deepEqual(
      auth.ownerHistory.map(({ from, to, reason }) => ({ from, to, reason })),
      [{ from: 'owner-1', to: 'sweep-owner', reason: 'terminal-session' }],
    );
    const historyBeforeReconcile = structuredClone(auth.ownerHistory);
    await tc.reconcile(sessionDir, {
      gameEpoch: EPOCH,
      owner: 'sweep-owner',
      lastHand: null,
      handsDir: path.join(sessionDir, 'hands'),
    });
    assert.deepEqual(tc.loadAuthority(sessionDir).ownerHistory, historyBeforeReconcile);
  }

  const playing = tmp();
  const tc = createTrainingControl();
  writeEmptyAuthority(playing);
  writeLoopPhase(playing, 'playing');
  const before = fs.readFileSync(path.join(playing, 'training', '.training-authority.json'));
  await assert.rejects(
    tc.takeoverOwner(playing, 'sweep-owner', { reason: 'terminal-session' }),
    { code: 'SESSION_NOT_TERMINAL' },
  );
  assert.deepEqual(
    fs.readFileSync(path.join(playing, 'training', '.training-authority.json')),
    before,
  );
});

test('Q2b terminal sweep takes ownership before consumers and keeps one process identity', async () => {
  const storeDir = tmp();
  const firstDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const secondDir = sessionDirOf(storeDir, '22222222-2222-4222-8222-222222222222');
  const tc = createTrainingControl({ storeDir });
  await tc.acceptEvaluations(firstDir, {
    gameEpoch: EPOCH,
    owner: 'owner-a',
    handNo: 1,
    evaluations: [evaluation()],
  });
  writeEmptyAuthority(secondDir, { owner: 'owner-b' });
  writeLoopPhase(firstDir, 'done');
  writeLoopPhase(secondDir, 'review_published');

  await sweepStore(storeDir);

  const first = tc.loadAuthority(firstDir);
  const second = tc.loadAuthority(secondDir);
  assert.match(first.ownerSessionId, /^sweep:\d+@[^:]+:.+$/);
  assert.equal(second.ownerSessionId, first.ownerSessionId);
  assert.deepEqual(
    first.ownerHistory.map(({ from, to, reason }) => ({ from, to, reason })),
    [{ from: 'owner-a', to: first.ownerSessionId, reason: 'terminal-session' }],
  );
  await tc.acceptEvaluations(firstDir, {
    gameEpoch: EPOCH,
    owner: first.ownerSessionId,
    handNo: 2,
    evaluations: [evaluation('d-2-preflop-0')],
  });
});

test('Q2b sweep skips playing, finalizing, and missing-phase v1/v2 sessions byte-for-byte', async () => {
  const storeDir = tmp();
  const variants = [
    { id: '11111111-1111-4111-8111-111111111111', phase: 'playing', schemaVersion: 1 },
    { id: '22222222-2222-4222-8222-222222222222', phase: 'finalizing', schemaVersion: 1 },
    { id: '33333333-3333-4333-8333-333333333333', phase: null, schemaVersion: 1 },
    { id: '44444444-4444-4444-8444-444444444444', phase: 'finalizing', schemaVersion: 2 },
  ];
  const before = new Map();
  for (const variant of variants) {
    const sessionDir = sessionDirOf(storeDir, variant.id);
    writeEmptyAuthority(sessionDir, { schemaVersion: variant.schemaVersion });
    if (variant.phase) writeLoopPhase(sessionDir, variant.phase);
    if (variant.schemaVersion === 2) {
      fs.writeFileSync(
        path.join(sessionDir, 'training', '.migration-v2.json'),
        JSON.stringify({ status: 'session-done', completedAt: '2026-09-03T00:00:00.000Z' }),
      );
      fs.writeFileSync(
        path.join(sessionDir, 'training', '.digest-map-v2.json'),
        JSON.stringify({ schemaVersion: 1, oldToNew: {}, byEvaluationId: {} }),
      );
    }
    before.set(sessionDir, fileHashes(path.join(sessionDir, 'training')));
  }

  const swept = await sweepStore(storeDir);

  assert.equal(swept.notices.filter((notice) => /SESSION_NOT_TERMINAL/.test(notice)).length, 4);
  for (const [sessionDir, hashes] of before) {
    assert.deepEqual(fileHashes(path.join(sessionDir, 'training')), hashes);
  }
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(
      storeDir,
      '.session-store/sessions/44444444-4444-4444-8444-444444444444/training/.migration-v2.json',
    ), 'utf8')).status,
    'session-done',
  );
});

test('Q2b completeSessionStoreMigrations gates v2 session-done writes on terminal phase', async () => {
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  writeEmptyAuthority(sessionDir);
  writeLoopPhase(sessionDir, 'finalizing');
  fs.writeFileSync(
    path.join(sessionDir, 'training', '.migration-v2.json'),
    JSON.stringify({ status: 'session-done' }),
  );
  fs.writeFileSync(
    path.join(sessionDir, 'training', '.digest-map-v2.json'),
    JSON.stringify({ schemaVersion: 1, oldToNew: {}, byEvaluationId: {} }),
  );
  const before = fileHashes(path.join(sessionDir, 'training'));

  const result = await completeSessionStoreMigrations(storeDir);

  assert.equal(result.completed, 0);
  assert.equal(result.notices.some((notice) => /SESSION_NOT_TERMINAL/.test(notice)), true);
  assert.deepEqual(fileHashes(path.join(sessionDir, 'training')), before);
});

test('Q2b consumeTrainingItems persists each item outcome and continues after a failure', async () => {
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const tc = createTrainingControl({ storeDir });
  const bad = evaluation('d-1-preflop-0');
  const good = evaluation('d-2-preflop-0', { handClass: 'KQo' });
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [bad, good],
  });
  const authorityPath = path.join(sessionDir, 'training', '.training-authority.json');
  const seeded = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  seeded.items[bad.evaluationId].summary.payloadSha256 = '';
  fs.writeFileSync(authorityPath, JSON.stringify(seeded));

  const first = await tc.consumeTrainingItems(sessionDir, { storeDir });
  const afterFirst = createTrainingControl({ storeDir }).loadAuthority(sessionDir);

  assert.deepEqual(first, { profiled: 1, banked: 1, applied: 1, failed: 1 });
  assert.equal(afterFirst.items[bad.evaluationId].consumers.profiled, false);
  assert.equal(afterFirst.items[bad.evaluationId].consumers.banked, false);
  assert.equal(afterFirst.items[bad.evaluationId].consumers.lastError.code, 'PROFILE_EVENT_INVALID');
  assert.equal(Number.isNaN(Date.parse(afterFirst.items[bad.evaluationId].consumers.lastError.at)), false);
  assert.equal(afterFirst.items[good.evaluationId].consumers.profiled, true);
  assert.equal(afterFirst.items[good.evaluationId].consumers.banked, true);

  const eventsPath = path.join(storeDir, '.training', 'profile-events.jsonl');
  const eventsBeforeReload = fs.readFileSync(eventsPath);
  const second = await createTrainingControl({ storeDir })
    .consumeTrainingItems(sessionDir, { storeDir });
  assert.deepEqual(second, { profiled: 0, banked: 0, applied: 0, failed: 1 });
  assert.deepEqual(fs.readFileSync(eventsPath), eventsBeforeReload);
});

test('Q2b sweep and CLI surface item failures without halting valid items', async () => {
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const tc = createTrainingControl({ storeDir });
  const bad = evaluation('d-1-preflop-0');
  const good = evaluation('d-2-preflop-0', { handClass: 'KQo' });
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [bad, good],
  });
  writeLoopPhase(sessionDir, 'done');
  const authorityPath = path.join(sessionDir, 'training', '.training-authority.json');
  const seeded = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  seeded.items[bad.evaluationId].summary.payloadSha256 = '';
  fs.writeFileSync(authorityPath, JSON.stringify(seeded));

  const swept = await sweepStore(storeDir);
  const afterSweep = createTrainingControl({ storeDir }).loadAuthority(sessionDir);

  assert.equal(swept.failed, 1);
  assert.equal(swept.applied, 1);
  assert.equal(afterSweep.items[bad.evaluationId].consumers.profiled, false);
  assert.equal(afterSweep.items[good.evaluationId].consumers.profiled, true);
  assert.equal(afterSweep.items[good.evaluationId].consumers.banked, true);

  const cli = JSON.parse(execFileSync(process.execPath, [
    PROFILE_CLI, 'sweep', '--store-dir', storeDir,
  ], { encoding: 'utf8' }).trim());
  assert.equal(cli.ok, true);
  assert.equal(cli.failed, 1);
});

test('Q2b uninjected sweep uses defaultSolve for installed and missing adapters', async () => {
  const storeDir = tmp();
  const installedDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const missingDir = sessionDirOf(storeDir, '22222222-2222-4222-8222-222222222222');
  const token = 'q2b-default-solve-token';
  const epoch = gameEpochOf(token);
  for (const [sessionDir, decisionId, adapterId] of [
    [installedDir, 'd-1-flop-0', 'fake-solver'],
    [missingDir, 'd-2-flop-0', 'not-installed'],
  ]) {
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      sessionToken: token,
      lastHand: { handNo: Number(decisionId.split('-')[1]), decisions: [flopSnapshot(decisionId)] },
    }));
    writeLoopPhase(sessionDir, 'done');
    await createTrainingControl({ storeDir }).recordPending(sessionDir, decisionId, {
      handNo: Number(decisionId.split('-')[1]),
      reason: 'solve',
      adapterId,
      gameEpoch: epoch,
      owner: `owner-${adapterId}`,
    });
  }

  const swept = await sweepStore(storeDir);
  const installed = createTrainingControl({ storeDir }).loadAuthority(installedDir);
  const missing = createTrainingControl({ storeDir }).loadAuthority(missingDir);

  assert.equal(installed.pending['d-1-flop-0'], undefined);
  assert.equal(Object.values(installed.items).some((item) => (
    item.decisionId === 'd-1-flop-0' && item.summary.source.id === 'fake-solver'
  )), true);
  assert.equal(swept.notices.some((notice) => /SOLVE_PENDING_UNMAPPED/.test(notice)), false);
  assert.equal(swept.notices.some((notice) => /SOLVER_ADAPTER_UNKNOWN/.test(notice)), true);
  assert.equal(missing.pending['d-2-flop-0'].adapterId, 'not-installed');
  assert.equal(missing.pending['d-2-flop-0'].reason, 'SOLVER_ADAPTER_UNKNOWN');
  assert.equal(installed.ownerSessionId, missing.ownerSessionId);
});

test('Q2b retryPendingMap has no stored-authority owner bypass', () => {
  const source = fs.readFileSync(PROFILE_CLI, 'utf8');
  assert.equal(source.includes('owner: auth.ownerSessionId'), false);
});
