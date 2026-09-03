import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detailRefOf } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/profile-cli.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-pcli-'));
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).trim());
}

test('profile-cli apply/show/rebuild/reset/sweep', async () => {
  const storeDir = tmp();
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', '11111111-1111-4111-8111-111111111111');
  const evaluation = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-1-preflop-0',
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null }],
    chosen: { action: 'fold', frequency: 0.15, evBb: null },
  };
  const file = path.join(storeDir, 'eval.json');
  fs.writeFileSync(file, JSON.stringify(evaluation));
  const applied = run(['apply', '--store-dir', storeDir, '--evaluation-file', file]);
  assert.equal(applied.ok, true);
  assert.equal(applied.profile.overall.evaluatedDecisions, 1);
  const shown = run(['show', '--store-dir', storeDir]);
  assert.equal(shown.profile.leaks[0].recommendedDrill, 'preflop.rfi.BTN');
  const rebuilt = run(['rebuild', '--store-dir', storeDir]);
  assert.equal(JSON.stringify(rebuilt.profile.overall), JSON.stringify(shown.profile.overall));
  fs.mkdirSync(path.join(sessionDir, 'training'), { recursive: true });
  const second = {
    ...evaluation,
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-9-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-9-preflop-0',
    payloadSha256: 'ff'.repeat(32),
    grade: 'preferred',
  };
  const { createTrainingControl } = await import('../tools/training-control.js');
  await createTrainingControl({ storeDir }).acceptEvaluations(sessionDir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 9,
    evaluations: [second],
  });
  const swept = run(['sweep', '--store-dir', storeDir]);
  assert.equal(swept.applied >= 1, true);
  const reset = run(['reset', '--store-dir', storeDir]);
  assert.equal(reset.profile.overall.evaluatedDecisions, 0);
});

test('writePracticeFocus and defaultPracticeFocusFile', async () => {
  const { writePracticeFocus, defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const file = writePracticeFocus(storeDir, {
    leaks: [{ id: 'preflop.rfi.BTN', recommendedDrill: 'preflop.rfi.BTN', severity: 1, confidence: 0.5 }],
  });
  assert.equal(defaultPracticeFocusFile(storeDir), file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(json.focus, 'preflop.rfi.BTN');
});

function writeFocusFile(storeDir, value, { symlinkTo } = {}) {
  const dir = path.join(storeDir, '.training');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'practice-focus.json');
  if (symlinkTo !== undefined) {
    fs.symlinkSync(symlinkTo, file);
    return file;
  }
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  fs.writeFileSync(file, body);
  return file;
}

test('defaultPracticeFocusFile ignores a symlink practice-focus and surfaces a notice', async () => {
  const {
    defaultPracticeFocusFile,
    loadAutoPracticeFocus,
  } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const outside = path.join(storeDir, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({
    schemaVersion: 1,
    leaks: [],
    focus: 'pwned-via-symlink',
  }));
  writeFocusFile(storeDir, null, { symlinkTo: outside });
  assert.equal(defaultPracticeFocusFile(storeDir), null);
  assert.equal(typeof loadAutoPracticeFocus, 'function');
  const loaded = loadAutoPracticeFocus(storeDir);
  assert.equal(loaded.status, 'ignored');
  assert.equal(loaded.code, 'UNSAFE_PATH');
  assert.match(String(loaded.notice), /UNSAFE_PATH/);
});

test('defaultPracticeFocusFile rejects an oversized practice-focus', async () => {
  const { defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  writeFocusFile(storeDir, {
    schemaVersion: 1,
    leaks: [],
    focus: 'x'.repeat(5000),
  });
  assert.throws(() => defaultPracticeFocusFile(storeDir), { code: 'TOO_LARGE' });
});

test('defaultPracticeFocusFile rejects a practice-focus schema mismatch', async () => {
  const { defaultPracticeFocusFile } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  writeFocusFile(storeDir, { focus: 'x', extra: true });
  assert.throws(() => defaultPracticeFocusFile(storeDir), { code: 'BAD_PRACTICE_FOCUS' });
});

function sessionDirOf(storeDir, id = '11111111-1111-4111-8111-111111111111') {
  const dir = path.join(storeDir, '.session-store', 'sessions', id);
  fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
  return dir;
}

function evaluationRow(overrides = {}) {
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: overrides.decisionId ?? 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: overrides.payloadSha256 ?? 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    decisionId: overrides.decisionId ?? 'd-1-preflop-0',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null }],
    chosen: { action: 'fold', frequency: 0.15, evBb: null },
    ...overrides,
  };
}

test('sweep is driven by authority consumer flags and does not apply jsonl-only rows', async () => {
  const { sweepStore } = await import('../tools/profile-cli.js');
  assert.equal(typeof sweepStore, 'function');
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir);
  const { createTrainingControl } = await import('../tools/training-control.js');
  const tc = createTrainingControl({ storeDir });
  const evaluation = evaluationRow();
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  const jsonlOnly = evaluationRow({
    decisionId: 'd-9-preflop-0',
    payloadSha256: 'ff'.repeat(32),
    grade: 'preferred',
  });
  fs.appendFileSync(
    path.join(sessionDir, 'training', 'evaluations.jsonl'),
    `${JSON.stringify(jsonlOnly)}\n`,
  );
  const swept = await sweepStore(storeDir);
  assert.equal(swept.applied, 1);
  assert.equal(swept.profile.overall.evaluatedDecisions, 1);
  assert.equal(tc.loadAuthority(sessionDir).items[evaluation.evaluationId].consumers.profiled, true);
  const again = await sweepStore(storeDir);
  assert.equal(again.applied, 0);
  assert.equal(again.profile.overall.evaluatedDecisions, 1);
});

test('sweep re-consumes pending evaluate and adapterId solver entries', async () => {
  const { sweepStore } = await import('../tools/profile-cli.js');
  assert.equal(typeof sweepStore, 'function');
  const storeDir = tmp();
  const evalSession = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const solveSession = sessionDirOf(storeDir, '22222222-2222-4222-8222-222222222222');
  const { createTrainingControl } = await import('../tools/training-control.js');
  const evalEval = evaluationRow({ decisionId: 'd-1-preflop-0', payloadSha256: 'aa'.repeat(32) });
  const solveEval = evaluationRow({
    decisionId: 'd-2-flop-0',
    payloadSha256: 'bb'.repeat(32),
  });
  solveEval.evaluationId = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId: 'd-2-flop-0',
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  fs.writeFileSync(path.join(evalSession, 'training', '.training-authority.json'), JSON.stringify({
    schemaVersion: 2,
    gameEpoch: 'ab'.repeat(32),
    ownerSessionId: 'owner-1',
    items: {},
    publishQueue: {},
    pending: {
      'd-1-preflop-0': {
        handNo: 1, reason: 'EVALUATE_FAILED', attempts: 1, lastTriedAt: '2026-09-02T00:00:00.000Z',
      },
    },
    annotationQueue: {},
  }));
  fs.writeFileSync(path.join(solveSession, 'training', '.training-authority.json'), JSON.stringify({
    schemaVersion: 2,
    gameEpoch: 'ab'.repeat(32),
    ownerSessionId: 'owner-1',
    items: {},
    publishQueue: {},
    pending: {
      'd-2-flop-0': {
        handNo: 2,
        reason: 'solve',
        attempts: 1,
        lastTriedAt: '2026-09-02T00:00:00.000Z',
        adapterId: 'fake-solver',
      },
    },
    annotationQueue: {},
  }));
  const evaluateCalls = [];
  const solveCalls = [];
  const swept = await sweepStore(storeDir, {
    evaluate: (sessionDir, handNo) => {
      evaluateCalls.push({ sessionDir, handNo });
      return { ok: true, evaluations: [evalEval] };
    },
    solve: (input) => {
      solveCalls.push(input);
      return { ok: true, evaluations: [solveEval] };
    },
  });
  assert.equal(evaluateCalls.length, 1);
  assert.equal(evaluateCalls[0].handNo, 1);
  assert.equal(solveCalls.length, 1);
  assert.equal(solveCalls[0].adapterId, 'fake-solver');
  const evalAuth = createTrainingControl({ storeDir }).loadAuthority(evalSession);
  const solveAuth = createTrainingControl({ storeDir }).loadAuthority(solveSession);
  assert.equal(evalAuth.pending['d-1-preflop-0'], undefined);
  assert.equal(solveAuth.pending['d-2-flop-0'], undefined);
  assert.equal(swept.applied, 2);
});

test('sweep does not abort the store on one malformed or unsupported archived authority', async () => {
  const { sweepStore } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const malformed = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const unsupported = sessionDirOf(storeDir, '22222222-2222-4222-8222-222222222222');
  const healthy = sessionDirOf(storeDir, '33333333-3333-4333-8333-333333333333');
  fs.writeFileSync(path.join(malformed, 'training', '.training-authority.json'), '{not-json');
  fs.writeFileSync(path.join(unsupported, 'training', '.training-authority.json'), JSON.stringify({
    schemaVersion: 99,
    gameEpoch: 'ab'.repeat(32),
    ownerSessionId: 'owner-1',
    items: {},
    publishQueue: {},
    pending: {},
    annotationQueue: {},
  }));
  const { createTrainingControl } = await import('../tools/training-control.js');
  const evaluation = evaluationRow();
  await createTrainingControl({ storeDir }).acceptEvaluations(healthy, {
    gameEpoch: 'ab'.repeat(32),
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation],
  });
  const swept = await sweepStore(storeDir);
  assert.equal((swept.notices ?? []).length >= 2, true);
  assert.equal(swept.applied, 1);
  assert.equal(swept.profile.overall.evaluatedDecisions, 1);
  const { createProfileStore } = await import('../tools/training-stores.js');
  assert.equal((await createProfileStore(storeDir).show()).overall.evaluatedDecisions, 1);
});

function writeV1ArchivedSession(sessionDir, evaluation) {
  const training = path.join(sessionDir, 'training');
  fs.mkdirSync(path.join(training, 'details'), { recursive: true });
  const detailRef = detailRefOf(evaluation.evaluationId);
  const summary = {
    ...evaluation,
    handNo: 1,
    explanation: 'BTN unopened에서 AJo는 폴드가 아니다.',
    detailRef,
    detailSha256: 'cc'.repeat(32),
  };
  fs.writeFileSync(path.join(training, 'details', `${detailRef}.json`), JSON.stringify(evaluation));
  fs.writeFileSync(path.join(training, 'evaluations.jsonl'), `${JSON.stringify(summary)}\n`);
  fs.writeFileSync(path.join(training, '.training-authority.json'), JSON.stringify({
    schemaVersion: 1,
    gameEpoch: 'ab'.repeat(32),
    ownerSessionId: 'owner-1',
    items: {
      [evaluation.evaluationId]: {
        status: 'evaluated',
        handNo: 1,
        decisionId: evaluation.decisionId,
        evaluationId: evaluation.evaluationId,
        payloadSha256: evaluation.payloadSha256,
        detailRef,
        detailSha256: 'cc'.repeat(32),
      },
    },
    publishQueue: {
      [evaluation.evaluationId]: {
        evaluationId: evaluation.evaluationId,
        handNo: 1,
        payloadSha256: evaluation.payloadSha256,
      },
    },
  }));
}

test('authority v1 session without a complete marker is still swept', async () => {
  const { sweepStore } = await import('../tools/profile-cli.js');
  const storeDir = tmp();
  const sessionDir = sessionDirOf(storeDir, '11111111-1111-4111-8111-111111111111');
  const evaluation = evaluationRow();
  writeV1ArchivedSession(sessionDir, evaluation);
  assert.equal(fs.existsSync(path.join(sessionDir, 'training', '.migration-v2.json')), false);
  const swept = await sweepStore(storeDir);
  assert.equal(swept.applied, 1);
  assert.equal(swept.skipped, undefined);
  assert.equal(swept.profile.overall.evaluatedDecisions, 1);
  const { createTrainingControl } = await import('../tools/training-control.js');
  const auth = createTrainingControl({ storeDir }).loadAuthority(sessionDir);
  assert.equal(auth.items[evaluation.evaluationId].consumers.profiled, true);
  const markerPath = path.join(sessionDir, 'training', '.migration-v2.json');
  assert.equal(fs.existsSync(markerPath), true);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.notEqual(marker.status, 'in-progress');
});
