import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQueue } from '../training/drill-generator.js';

test('REQ-009: free practice contains ten diverse questions', () => {
  const queue = generateQueue({ mode: 'free', seed: 'slice-005-red', source: SOURCE });
  assert.strictEqual(queue.length, 10, 'free practice must contain ten supported questions');
});

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import {
  answerQuestion,
  nextQuestion,
  readDrillSession,
  readStudyHistory,
  startDrill as startDrillCurrent,
} from '../tools/drill-cli.js';
import { studyHistory, retestEligibility } from '../training/study-history.js';
import { createMistakeBank, createProfileStore } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { loadPreflopDataset } from '../tools/preflop-dataset.js';
import { lookup } from '../training/providers/preflop-json.js';
import { nextSchedule } from '../training/spaced-repetition.js';

const SOURCE = {
  id: 'local-preflop-baseline',
  version: '1.0.0',
  contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
};
// These recovery fixtures describe the prior v1 producer. V2 is covered in reference-coverage-release.
const startDrill = (dir, options = {}) => startDrillCurrent(dir, {source:SOURCE,...options});
const OTHER_SOURCE = { ...SOURCE, version: '2.0.0' };

function pair(question) {
  return `${question.prompt.spotKey}:${question.prompt.handClass}`;
}

function sessionBytes(storeDir) {
  return fs.readFileSync(path.join(storeDir, '.training', 'drill-session.json'));
}

function event(index, overrides = {}) {
  const runId = overrides.runId ?? '11111111-1111-4111-8111-111111111111';
  const spotKey = overrides.spotKey ?? '6max-100bb-btn-rfi-unopened';
  const handClass = overrides.handClass ?? (index ? 'KQs' : 'AJo');
  const eventSource = overrides.source ?? SOURCE;
  const identity = createHash('sha256').update(`${runId}:${index}`).digest('hex');
  return {
    schemaVersion: 4,
    evaluationId: `${identity}:d-${index + 1}-preflop-0:${eventSource.id}@${eventSource.version}`,
    payloadSha256: String((index % 9) + 1).repeat(64),
    skillKey: 'preflop.rfi.BTN',
    street: 'preflop',
    status: 'supported',
    grade: 'mixed',
    forced: false,
    evLossBb: null,
    providerId: eventSource.id,
    providerVersion: eventSource.version,
    origin: overrides.origin ?? 'drill',
    appliedAt: overrides.appliedAt ?? `2026-09-0${index + 1}T00:00:00.000Z`,
    mixObservation: {
      spotKey,
      handClass,
      referenceActions: [{ action: 'fold', frequency: 1 }],
      chosenAction: { action: 'fold' },
      sourceIdentity: eventSource,
    },
    ...(overrides.withoutRun ? {} : {
      studyRun: {
        id: runId,
        mode: overrides.mode ?? 'assessment',
        total: overrides.total ?? 2,
        index: overrides.studyIndex ?? index,
        startedAt: overrides.startedAt ?? '2026-09-01T00:00:00.000Z',
        ...(overrides.assessmentId ? { assessmentId: overrides.assessmentId } : {}),
      },
    }),
  };
}

async function answerAll(storeDir, started) {
  for (;;) {
    const next = await nextQuestion(storeDir);
    if (next.done) return;
    await answerQuestion(storeDir, {
      action: 'fold',
      sessionId: started.sessionId,
      questionId: next.question.questionId,
      attemptNo: next.attemptNo,
    });
  }
}

function waitChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('free queue is deterministic, pair-unique and uses more than one hand class', () => {
  const first = generateQueue({ mode: 'free', seed: 'same', source: SOURCE });
  const second = generateQueue({ mode: 'free', seed: 'same', source: SOURCE });
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map(pair)).size, 10);
  assert.ok(new Set(first.map((row) => row.prompt.handClass)).size > 1);
  assert.ok(first.every((row) => row.sourceIdentity.contentSha256 === SOURCE.contentSha256));
});

function storeBytes(storeDir) {
  return Object.fromEntries(['drill-session.json', 'profile.json', 'profile-events.jsonl', 'mistakes.json'].map((name) => {
    const file = path.join(storeDir, '.training', name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
  }));
}

function capturedPending(storeDir, answer = { action: 'fold' }) {
  const session = JSON.parse(sessionBytes(storeDir));
  const question = session.queue[session.index];
  const dataset = loadPreflopDataset(path.resolve('training/data/preflop-baseline-v1.json'));
  const strategy = lookup(dataset, question.prompt);
  const result = evaluateDrillAnswer(question, answer, strategy);
  const digest = createHash('sha256').update(`drill:${session.sessionId}:${question.questionId}:${session.index}`).digest('hex');
  const profileEvent = {
    evaluationId: evaluationIdOf({ gameEpoch: digest, decisionId: `d-${session.index + 1}-preflop-0`, providerId: SOURCE.id, providerVersion: SOURCE.version }),
    payloadSha256: digest, status: 'supported', street: 'preflop',
    spotKey: question.prompt.spotKey, handClass: question.prompt.handClass,
    grade: result.grade, forced: false, evLossBb: null, source: SOURCE,
    recommended: result.recommended, chosen: answer, origin: session.mode === 'retest' ? 'retest' : 'drill',
    studyRun: { ...session.studyRun, index: session.index },
  };
  session.pending = {
    answer, result, srsPatch: null, profileEvent, bankEvent: JSON.parse(JSON.stringify(profileEvent)),
    applied: { srs: false, bank: false, profile: false }, questionId: question.questionId, attemptNo: session.index,
  };
  return session;
}

function writeDrillSession(storeDir, session) {
  fs.writeFileSync(path.join(storeDir, '.training', 'drill-session.json'), JSON.stringify(session));
}

async function pendingFixture(options = {}) {
  const storeDir = createOwnedTempDir('s5-pending-graph');
  await startDrill(storeDir, { mode: 'assessment', idempotencyKey: 'pending', ...options });
  return { storeDir, session: capturedPending(storeDir) };
}

test('S5 invalid answers reject before creating pending or changing any consumer bytes', async (t) => {
  for (const answer of [{ action: 'invalid-action' }, { action: 'all-in' }, { action: 'raise' }, { action: 'raise', sizeBb: -1 }, { action: 'fold', sizeBb: 2.5 }, { action: 'raise', sizeBb: Infinity }, { action: 'raise', sizeBb: '2.5' }]) {
    await t.test(JSON.stringify(answer), async () => {
      const storeDir = createOwnedTempDir('s5-invalid-answer');
      const session = await startDrill(storeDir, { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
      const before = storeBytes(storeDir);
      await assert.rejects(() => answerQuestion(storeDir, { ...answer, sessionId: session.sessionId, questionId: session.queue[0].questionId, attemptNo: 0 }));
      assert.deepEqual(storeBytes(storeDir), before);
    });
  }
});

test('S5 pending binds the complete session, question, result and practice consumer graph', async (t) => {
  const corruptions = [
    ['game origin', (s) => { s.pending.profileEvent.origin = 'game'; s.pending.bankEvent.origin = 'game'; }],
    ['foreign run', (s) => { for (const key of ['profileEvent', 'bankEvent']) s.pending[key].studyRun.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['foreign one-question completion', (s) => { for (const key of ['profileEvent', 'bankEvent']) s.pending[key].studyRun.total = 1; }],
    ['wrong question', (s) => { s.pending.questionId = s.queue[1].questionId; }],
    ['wrong attempt', (s) => { s.pending.attemptNo = 1; }],
    ['wrong result', (s) => { s.pending.result.grade = 'invented'; }],
    ['wrong answer', (s) => { s.pending.answer.action = 'invalid-action'; }],
    ['wrong digest', (s) => { for (const key of ['profileEvent', 'bankEvent']) s.pending[key].payloadSha256 = 'ab'.repeat(32); }],
    ['wrong bank event', (s) => { s.pending.bankEvent.handClass = '72o'; }],
    ['missing bank event', (s) => { delete s.pending.bankEvent; }],
    ['missing profile proof', (s) => { s.pending.applied.profile = true; }],
    ['missing bank proof', (s) => { s.pending.applied.bank = true; }],
    ['invalid consumer flag', (s) => { s.pending.applied.profile = 'false'; }],
    ['foreign SRS target', (s) => { s.pending.srsPatch = { mistakeId: 'other', patch: { attempts: 1 } }; }],
  ];
  for (const [name, corrupt] of corruptions) await t.test(name, async () => {
    const { storeDir, session } = await pendingFixture(name === 'missing bank proof'
      ? { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' } : {});
    corrupt(session); writeDrillSession(storeDir, session);
    const before = storeBytes(storeDir);
    await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
    assert.deepEqual(storeBytes(storeDir), before);
  });
});

test('S5 corrupt committed profile evidence is detected before pending can mutate bank or SRS', async () => {
  const { storeDir, session } = await pendingFixture();
  writeDrillSession(storeDir, session);
  fs.writeFileSync(path.join(storeDir, '.training', 'profile-events.jsonl'), `${JSON.stringify({ ...event(0), schemaVersion: 99 })}\n`);
  const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir));
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 a profile applied flag needs committed chronology as well as matching identity', async () => {
  const { storeDir, session } = await pendingFixture({ mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
  const profile = createProfileStore(storeDir);
  await profile.apply(session.pending.profileEvent);
  const row = JSON.parse(fs.readFileSync(profile.eventsPath, 'utf8').trim());
  delete row.appliedAt;
  fs.writeFileSync(profile.eventsPath, `${JSON.stringify(row)}\n`);
  session.pending.applied.profile = true;
  writeDrillSession(storeDir, session);
  const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 bank completion proof cannot contradict the primary captured evaluation', async () => {
  const { storeDir, session } = await pendingFixture({ mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
  const bank = createMistakeBank(storeDir);
  await bank.collect(session.pending.bankEvent);
  const raw = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
  raw.items[0].evaluation.chosen = { action: 'call' };
  fs.writeFileSync(bank.file, JSON.stringify(raw));
  session.pending.applied.bank = true;
  writeDrillSession(storeDir, session); const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(storeBytes(storeDir), before);
});

async function srsPendingFixture() {
  const { storeDir, session } = await pendingFixture({ mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
  const game = { ...session.pending.profileEvent, evaluationId: evaluationIdOf({ gameEpoch: 'ab'.repeat(32), decisionId: 'd-9-preflop-0', providerId: SOURCE.id, providerVersion: SOURCE.version }), payloadSha256: 'cd'.repeat(32), origin: 'game' };
  delete game.studyRun;
  const bank = createMistakeBank(storeDir);
  const collected = await bank.collect(game);
  await startDrill(storeDir, { mode: 'mistake-review', idempotencyKey: 'srs' });
  const captured = capturedPending(storeDir);
  const at = new Date().toISOString();
  const before = collected.item.reviewState;
  captured.pending.srsPatch = { mistakeId: collected.item.mistakeId, before, patch: {
    lastReviewedAt: at, attempts: before.attempts + 1,
    ...nextSchedule({ ...before, grade: captured.pending.result.grade, now: Date.parse(at) }),
  } };
  return { storeDir, session: captured, bank };
}

test('S5 an SRS target dated before its run cannot be committed', async () => {
  const { storeDir, session } = await srsPendingFixture();
  const patch = session.pending.srsPatch;
  patch.patch = { lastReviewedAt: '2020-01-01T00:00:00.000Z', attempts: patch.before.attempts + 1,
    ...nextSchedule({ ...patch.before, grade: session.pending.result.grade, now: Date.parse('2020-01-01T00:00:00.000Z') }) };
  writeDrillSession(storeDir, session); const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 an overflowing SRS target rejects before changing pending or either consumer', async () => {
  const { storeDir, bank, session } = await srsPendingFixture();
  await bank.updateReviewState(session.pending.srsPatch.mistakeId, { attempts: Number.MAX_SAFE_INTEGER });
  const current = JSON.parse(sessionBytes(storeDir));
  const before = storeBytes(storeDir);
  await assert.rejects(() => answerQuestion(storeDir, {
    action: 'fold', sessionId: current.sessionId, questionId: current.queue[0].questionId, attemptNo: 0,
  }));
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 SRS replay recognizes its already-applied absolute target and refuses a conflicting schedule', async (t) => {
  for (const conflict of [false, true]) await t.test(String(conflict), async () => {
    const { storeDir, session, bank } = await srsPendingFixture();
    const captured = session.pending.srsPatch;
    await bank.updateReviewState(captured.mistakeId, conflict ? { attempts: 7 } : captured.patch);
    writeDrillSession(storeDir, session); const before = storeBytes(storeDir);
    if (conflict) {
      await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
      assert.deepEqual(storeBytes(storeDir), before);
    } else {
      await nextQuestion(storeDir); await nextQuestion(storeDir);
      const item = (await bank.list()).find((row) => row.mistakeId === captured.mistakeId);
      assert.equal(item.attempts, 1);
      assert.deepEqual(item.reviewState, { ...captured.before, ...captured.patch });
    }
  });
});

test('S5 rejected start leaves recoverable pending and all consumer files untouched', async (t) => {
  for (const options of [{ mode: 'bad' }, { mode: 'free', spotKey: 'bad-spot' }, { mode: 'free', source: OTHER_SOURCE }, { mode: 'retest', assessmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]) {
    await t.test(JSON.stringify(options), async () => {
      const { storeDir, session } = await pendingFixture();
      writeDrillSession(storeDir, session); const before = storeBytes(storeDir);
      await assert.rejects(() => startDrill(storeDir, { ...options, idempotencyKey: 'invalid' }));
      assert.deepEqual(storeBytes(storeDir), before);
      await nextQuestion(storeDir);
      assert.equal(JSON.parse(sessionBytes(storeDir)).index, 1);
    });
  }
});

test('S5 pure history rejects malformed envelopes and conflicting repeated learning identities', async (t) => {
  for (const mutate of [
    (row) => { row.schemaVersion = 99; }, (row) => { row.evaluationId = 'bad-id'; },
    (row) => { row.payloadSha256 = 'bad-hash'; }, (row) => { row.providerId = 'different'; },
    (row) => { row.appliedAt = 'invalid'; },
  ]) await t.test(String(mutate), () => {
    const row = event(0); mutate(row);
    assert.throws(() => studyHistory([row, event(1)]));
  });
  const row = event(0); const conflict = JSON.parse(JSON.stringify(row)); conflict.studyRun.total = 1;
  assert.throws(() => studyHistory([row, conflict, event(1)]));
});

test('S5 identical repeated events are idempotent while unverified and game runs cannot score', () => {
  assert.equal(studyHistory([event(0), event(0), event(1)]).assessments[0].complete, true);
  const unverified = studyHistory([event(0, { source: OTHER_SOURCE }), event(1, { source: OTHER_SOURCE })]);
  assert.equal(unverified.assessments[0].complete, false);
  assert.equal(unverified.assessments[0].result.allowedActionRate, null);
  const game = studyHistory([event(0, { origin: 'game' }), event(1, { origin: 'game' })]);
  assert.equal(game.assessments.length, 0);
  assert.equal(game.seenPairs.length, 2);
});

test('S5 legacy event schemas cannot certify prospective assessment completion', () => {
  const legacy = [event(0), event(1)].map((row) => ({ ...row, schemaVersion: 3 }));
  const run = studyHistory(legacy).assessments[0];
  assert.equal(run.complete, false);
  assert.equal(run.result.allowedActionRate, null);
  assert.throws(() => studyHistory([event(0), { ...event(0), schemaVersion: 3 }, event(1)]));
});

test('S5 history never completes an early retest before the baseline or latest qualifying retest boundary', () => {
  const assessmentId = event(0).studyRun.id;
  const rows = [event(0), event(1)];
  for (const [id, startedAt] of [
    ['22222222-2222-4222-8222-222222222222', '2026-09-02T01:00:00.000Z'],
    ['33333333-3333-4333-8333-333333333333', '2026-09-04T00:00:00.000Z'],
    ['44444444-4444-4444-8444-444444444444', '2026-09-04T01:00:00.000Z'],
  ]) for (const index of [0, 1]) rows.push(event(index, { runId: id, mode: 'retest', assessmentId, startedAt, appliedAt: startedAt }));
  const history = studyHistory(rows);
  assert.deepEqual(history.retests.map((r) => r.complete), [false, true, false]);
  assert.equal(history.assessments[0].latestCompletedRetest.id, '33333333-3333-4333-8333-333333333333');
});

test('S5 explicit missing assessment never selects a different completed assessment', async () => {
  const storeDir = createOwnedTempDir('s5-explicit-assessment');
  await startDrill(storeDir, { mode: 'free' });
  fs.writeFileSync(path.join(storeDir, '.training', 'profile-events.jsonl'), `${[event(0), event(1)].map(JSON.stringify).join('\n')}\n`);
  const before = storeBytes(storeDir);
  await assert.rejects(() => startDrill(storeDir, { mode: 'retest', assessmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), { code: 'INCOMPLETE_ASSESSMENT' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 history reads only newline-committed profile events without modifying their tail', async () => {
  const storeDir = createOwnedTempDir('s5-history-commit');
  const file = path.join(storeDir, '.training', 'profile-events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(event(0))}\n${JSON.stringify(event(1))}`;
  fs.writeFileSync(file, bytes);
  const history = await readStudyHistory(storeDir);
  assert.equal(history.assessments[0].complete, false);
  assert.equal(history.assessments[0].questions.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('explicit supported selections are honored and unsupported selections fail closed', () => {
  const selected = generateQueue({
    mode: 'free', seed: 'selected', source: SOURCE,
    spotKey: '6max-100bb-co-rfi-unopened', handClass: 'KQs',
  });
  assert.equal(selected.length, 1);
  assert.equal(pair(selected[0]), '6max-100bb-co-rfi-unopened:KQs');
  assert.throws(() => generateQueue({ mode: 'bogus', source: SOURCE }), { code: 'INVALID_DRILL_MODE' });
  assert.throws(() => generateQueue({ mode: 'free', source: SOURCE, handClass: 'ZZ' }), { code: 'UNSUPPORTED_HAND' });
  assert.throws(() => generateQueue({ mode: 'free', source: SOURCE, spotKey: 'heads-up' }), { code: 'UNSUPPORTED_SPOT' });
});

test('leak practice contains ten diverse questions for an actual leak target', () => {
  const queue = generateQueue({
    mode: 'leak', seed: 'leak', source: SOURCE,
    profile: { game: { leaks: [{ id: 'preflop.rfi.BTN', recommendedDrill: 'preflop.rfi.BTN' }] } },
  });
  assert.equal(queue.length, 10);
  assert.equal(new Set(queue.map(pair)).size, 10);
  assert.ok(new Set(queue.map((row) => row.prompt.handClass)).size > 1);
});

test('daily queue is honestly empty when nothing is due', () => {
  const queue = generateQueue({
    mode: 'daily', source: SOURCE, now: '2026-09-06T00:00:00.000Z',
    mistakes: [{
      mistakeId: 'future', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo',
      spotSignature: '6max-100bb-btn-rfi-unopened:AJo', sourceIdentity: SOURCE,
      nextReviewAt: '2026-09-07T00:00:00.000Z',
    }],
  });
  assert.deepEqual(queue, []);
});

test('daily and mistake review retain the actual candidate and exact source identity', () => {
  const item = {
    mistakeId: 'candidate-1', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo',
    spotSignature: '6max-100bb-btn-rfi-unopened:AJo', sourceIdentity: SOURCE,
    skillKey: 'preflop.rfi.BTN', nextReviewAt: '2026-09-01T00:00:00.000Z',
  };
  for (const mode of ['daily', 'mistake-review']) {
    const [question] = generateQueue({ mode, source: SOURCE, mistakes: [item], now: '2026-09-06T00:00:00.000Z' });
    assert.equal(question.candidateMistakeId, item.mistakeId);
    assert.deepEqual(question.sourceIdentity, SOURCE);
  }
});

test('assessment reports the actual scarce unseen pool without fabricating questions', () => {
  const ranks = 'AKQJT98765432'.split('');
  const hands = [
    ...ranks.map((rank) => `${rank}${rank}`),
    ...ranks.flatMap((high, index) => ranks.slice(index + 1)
      .flatMap((low) => [`${high}${low}s`, `${high}${low}o`])),
  ];
  const spots = [
    '6max-100bb-utg-rfi-unopened', '6max-100bb-hj-rfi-unopened',
    '6max-100bb-co-rfi-unopened', '6max-100bb-btn-rfi-unopened',
    '6max-100bb-sb-rfi-unopened', '6max-100bb-bb-vs-single-raise',
    '6max-100bb-sb-vs-single-raise', '6max-100bb-btn-vs-single-raise',
  ];
  const all = spots.flatMap((spotKey) => hands.map((handClass) => ({ spotKey, handClass })));
  const history = {
    seenPairs: all.slice(0, -3).map((question) => ({
      sourceIdentity: SOURCE,
      spotKey: question.spotKey,
      handClass: question.handClass,
    })),
  };
  const scarce = generateQueue({ mode: 'assessment', source: SOURCE, seed: 'all', history });
  assert.equal(scarce.length, 3);
  assert.equal(new Set(scarce.map(pair)).size, 3);
});

test('study history tracks seen pairs and keeps unknown legacy exposure explicit', () => {
  const tracked = event(0, { withoutRun: true });
  const legacy = { ...event(1, { withoutRun: true }), mixObservation: undefined };
  const history = studyHistory([tracked, legacy]);
  assert.deepEqual(history.seenPairs, [{ sourceIdentity: SOURCE, spotKey: tracked.mixObservation.spotKey, handClass: 'AJo' }]);
  assert.equal(history.unknownPreTrackingExposure, true);
});

test('complete assessment requires each original unique index exactly once', () => {
  const complete = studyHistory([event(0), event(1)]);
  assert.equal(complete.assessments[0].complete, true);
  assert.equal(complete.assessments[0].questions.length, 2);
  const missing = studyHistory([event(0)]);
  assert.equal(missing.assessments[0].complete, false);
  const duplicate = studyHistory([event(0), { ...event(0), evaluationId: event(1).evaluationId, payloadSha256: '3'.repeat(64) }]);
  assert.equal(duplicate.assessments[0].complete, false);
  assert.equal(duplicate.assessments[0].reason, 'INCONSISTENT_RUN');
});

test('inconsistent source and question pairs never make a run complete', () => {
  const changed = event(1, { source: OTHER_SOURCE });
  const history = studyHistory([event(0), changed]);
  assert.equal(history.assessments[0].complete, false);
  assert.equal(history.assessments[0].reason, 'INCONSISTENT_RUN');
});

test('retest eligibility waits 24 server hours after the latest completed run', () => {
  const assessment = studyHistory([event(0), event(1)]).assessments[0];
  assert.deepEqual(retestEligibility(assessment, '2026-09-02T23:59:59.999Z'), {
    eligible: false,
    nextAvailableAt: '2026-09-03T00:00:00.000Z',
  });
  assert.deepEqual(retestEligibility(assessment, '2026-09-03T00:00:00.000Z'), {
    eligible: true,
    nextAvailableAt: '2026-09-03T00:00:00.000Z',
  });
});

test('latest completed retest resets the next 24-hour boundary', () => {
  const assessmentId = '11111111-1111-4111-8111-111111111111';
  const retestId = '22222222-2222-4222-8222-222222222222';
  const history = studyHistory([
    event(0), event(1),
    event(0, {
      runId: retestId, mode: 'retest', assessmentId,
      startedAt: '2026-09-04T00:00:00.000Z', appliedAt: '2026-09-04T00:00:00.000Z',
    }),
    event(1, {
      runId: retestId, mode: 'retest', assessmentId,
      startedAt: '2026-09-04T00:00:00.000Z', appliedAt: '2026-09-04T01:00:00.000Z',
    }),
  ]);
  const assessment = history.assessments[0];
  assert.equal(assessment.latestCompletedRetest.id, retestId);
  assert.deepEqual(retestEligibility(assessment, '2026-09-05T00:59:59.999Z'), {
    eligible: false,
    nextAvailableAt: '2026-09-05T01:00:00.000Z',
  });
});

test('a retest with a changed question set never counts as completed', () => {
  const assessmentId = '11111111-1111-4111-8111-111111111111';
  const retestId = '44444444-4444-4444-8444-444444444444';
  const history = studyHistory([
    event(0), event(1),
    event(0, {
      runId: retestId, mode: 'retest', assessmentId,
      startedAt: '2026-09-04T00:00:00.000Z', appliedAt: '2026-09-04T00:00:00.000Z',
      handClass: 'AQs',
    }),
    event(1, {
      runId: retestId, mode: 'retest', assessmentId,
      startedAt: '2026-09-04T00:00:00.000Z', appliedAt: '2026-09-04T01:00:00.000Z',
    }),
  ]);
  assert.equal(history.retests[0].complete, false);
  assert.equal(history.retests[0].reason, 'INCONSISTENT_RUN');
  assert.equal(history.assessments[0].latestCompletedRetest, null);
});

test('invalid mode and unsupported selection cannot replace the current session', async () => {
  const storeDir = createOwnedTempDir('drill-invalid');
  await startDrill(storeDir, { mode: 'free', seed: 'before', idempotencyKey: 'before' });
  const before = sessionBytes(storeDir);
  await assert.rejects(() => startDrill(storeDir, { mode: 'bad', idempotencyKey: 'bad' }), { code: 'INVALID_DRILL_MODE' });
  assert.deepEqual(sessionBytes(storeDir), before);
  await assert.rejects(() => startDrill(storeDir, {
    mode: 'free', spotKey: 'not-a-spot', idempotencyKey: 'bad-spot',
  }), { code: 'UNSUPPORTED_SPOT' });
  assert.deepEqual(sessionBytes(storeDir), before);
});

test('an uncommitted torn history tail supplies no evidence and remains byte-preserved', async () => {
  const storeDir = createOwnedTempDir('drill-truncated-history');
  await startDrill(storeDir, { mode: 'free', seed: 'current', idempotencyKey: 'current' });
  const before = sessionBytes(storeDir);
  fs.writeFileSync(path.join(storeDir, '.training', 'profile-events.jsonl'), '{"studyRun":');
  assert.deepEqual((await readStudyHistory(storeDir)).assessments, []);
  assert.equal(fs.readFileSync(path.join(storeDir, '.training', 'profile-events.jsonl'), 'utf8'), '{"studyRun":');
  assert.deepEqual(sessionBytes(storeDir), before);
});

test('next and session readers resume count, index, mode and last confirmed feedback', async () => {
  const storeDir = createOwnedTempDir('drill-resume');
  const started = await startDrill(storeDir, { mode: 'free', seed: 'resume', idempotencyKey: 'resume' });
  const first = await nextQuestion(storeDir);
  const answer = await answerQuestion(storeDir, {
    action: 'fold', sessionId: started.sessionId,
    questionId: first.question.questionId, attemptNo: first.attemptNo,
  });
  const resumed = await nextQuestion(storeDir);
  const dto = await readDrillSession(storeDir);
  for (const value of [resumed, dto]) {
    assert.equal(value.count, 10);
    assert.equal(value.index, 1);
    assert.equal(value.mode, 'free');
    assert.equal(value.lastFeedback, answer.result.feedback);
  }
  assert.equal(dto.seed, undefined);
  assert.equal(dto.pending, undefined);
});

test('assessment selects unseen pairs and completed history survives session replacement', async () => {
  const storeDir = createOwnedTempDir('drill-assessment');
  const free = await startDrill(storeDir, { mode: 'free', seed: 'seen', idempotencyKey: 'seen' });
  const seen = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold', sessionId: free.sessionId,
    questionId: seen.question.questionId, attemptNo: seen.attemptNo,
  });
  const assessed = await startDrill(storeDir, { mode: 'assessment', seed: 'assess', idempotencyKey: 'assess' });
  assert.equal(assessed.queue.some((question) => pair(question) === pair(seen.question)), false);
  await answerAll(storeDir, assessed);
  await startDrill(storeDir, { mode: 'free', seed: 'replace', idempotencyKey: 'replace' });
  const history = await readStudyHistory(storeDir);
  assert.equal(history.assessments.some((run) => run.id === assessed.studyRun.id && run.complete), true);
});

test('early retest returns a server boundary and leaves the current session unchanged', async () => {
  const storeDir = createOwnedTempDir('drill-early-retest');
  const assessment = await startDrill(storeDir, { mode: 'assessment', seed: 'assessment', idempotencyKey: 'assessment' });
  await answerAll(storeDir, assessment);
  const replacement = await startDrill(storeDir, { mode: 'free', seed: 'current', idempotencyKey: 'current' });
  const before = sessionBytes(storeDir);
  const history = await readStudyHistory(storeDir);
  const baseline = history.assessments.find((run) => run.id === assessment.studyRun.id);
  await assert.rejects(
    () => startDrill(storeDir, {
      mode: 'retest', assessmentId: baseline.id, idempotencyKey: 'early',
    }),
    (error) => error.code === 'RETEST_NOT_DUE' && typeof error.nextAvailableAt === 'string',
  );
  assert.equal((await readDrillSession(storeDir)).sessionId, replacement.sessionId);
  assert.deepEqual(sessionBytes(storeDir), before);
});

test('changed assessment source fails before replacing the current session', async () => {
  const storeDir = createOwnedTempDir('drill-source-change');
  const current = await startDrill(storeDir, { mode: 'free', seed: 'current', idempotencyKey: 'current' });
  const before = sessionBytes(storeDir);
  const changedEvents = [event(0, { source: OTHER_SOURCE }), event(1, { source: OTHER_SOURCE })];
  fs.writeFileSync(
    path.join(storeDir, '.training', 'profile-events.jsonl'),
    `${changedEvents.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  await assert.rejects(() => startDrill(storeDir, {
    mode: 'retest', assessmentId: changedEvents[0].studyRun.id, idempotencyKey: 'changed',
  }), { code: 'SOURCE_CHANGED' });
  assert.equal((await readDrillSession(storeDir)).sessionId, current.sessionId);
  assert.deepEqual(sessionBytes(storeDir), before);
});

test('a stored question with changed source bytes cannot be graded or journaled', async () => {
  const storeDir = createOwnedTempDir('drill-question-source');
  const started = await startDrill(storeDir, { mode: 'free', seed: 'source', idempotencyKey: 'source' });
  const next = await nextQuestion(storeDir);
  const session = JSON.parse(sessionBytes(storeDir));
  session.queue[0].sourceIdentity.contentSha256 = 'a'.repeat(64);
  fs.writeFileSync(path.join(storeDir, '.training', 'drill-session.json'), JSON.stringify(session));
  await assert.rejects(() => answerQuestion(storeDir, {
    action: 'fold', sessionId: started.sessionId,
    questionId: next.question.questionId, attemptNo: next.attemptNo,
  }), { code: 'SOURCE_CHANGED' });
  assert.equal(JSON.parse(sessionBytes(storeDir)).index, 0);
  assert.deepEqual(await readStudyHistory(storeDir), {
    schemaVersion: 1,
    unknownPreTrackingExposure: false,
    seenPairs: [],
    assessments: [],
    retests: [],
    goal: {
      origin: 'default', sourceIdentity: null,
      spotKey: '6max-100bb-btn-rfi-v2', handClass: 'AJo',
      reason: 'default-supported-spot',
    },
  });
});

test('due retest starts with the exact assessment source and question set', async () => {
  const storeDir = createOwnedTempDir('drill-due-retest');
  const questions = [
    { spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo' },
    { spotKey: '6max-100bb-bb-vs-single-raise', handClass: 'KQs' },
  ];
  const assessmentId = '33333333-3333-4333-8333-333333333333';
  const assessmentEvents = questions.map((question, index) => event(index, {
    runId: assessmentId,
    spotKey: question.spotKey,
    handClass: question.handClass,
    appliedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
  }));
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.training', 'profile-events.jsonl'),
    `${assessmentEvents.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  const retest = await startDrill(storeDir, {
    mode: 'retest', assessmentId, idempotencyKey: 'due-retest',
  });
  assert.equal(retest.mode, 'retest');
  assert.equal(retest.studyRun.assessmentId, assessmentId);
  assert.deepEqual(retest.queue.map((question) => ({
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
  })), questions);
  assert.ok(retest.queue.every((question) => question.sourceIdentity.contentSha256 === SOURCE.contentSha256));
});

test('double submit journals profile and practice bank consumers exactly once', async () => {
  const storeDir = createOwnedTempDir('drill-double');
  const started = await startDrill(storeDir, {
    mode: 'free', seed: 'off-policy', spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA', idempotencyKey: 'double',
  });
  const next = await nextQuestion(storeDir);
  const request = {
    action: 'fold', sessionId: started.sessionId,
    questionId: next.question.questionId, attemptNo: next.attemptNo,
  };
  const first = await answerQuestion(storeDir, request);
  const second = await answerQuestion(storeDir, request);
  assert.deepEqual(second, first);
  assert.equal((await createMistakeBank(storeDir).listEvidence({ origin: 'practice' })).length, 1);
  assert.equal((await readStudyHistory(storeDir)).seenPairs.length, 1);
});

test('fresh-process pending replay applies bank once and clears all consumer flags', async () => {
  const storeDir = createOwnedTempDir('drill-process-replay');
  const started = await startDrill(storeDir, {
    mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA',
    idempotencyKey: 'pending-process',
  });
  const next = await nextQuestion(storeDir);
  const session = capturedPending(storeDir);
  fs.writeFileSync(path.join(storeDir, '.training', 'drill-session.json'), JSON.stringify(session));
  const cliHref = pathToFileURL(path.resolve('tools/drill-cli.js')).href;
  const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', `
    import { nextQuestion } from ${JSON.stringify(cliHref)};
    const storeDir = process.argv[1];
    await nextQuestion(storeDir);
    process.stdout.write('ok');
  `, storeDir], { stdio: ['ignore', 'pipe', 'pipe'] }), 'drill pending replay child');
  const result = await waitChild(child);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok');
  assert.equal((await createMistakeBank(storeDir).listEvidence({ origin: 'practice' })).length, 1);
  assert.equal(JSON.parse(sessionBytes(storeDir)).pending, null);
  assert.equal((await readStudyHistory(storeDir)).seenPairs.length, 1);
});

test('practice changes no game projection or game evidence bytes', async () => {
  const storeDir = createOwnedTempDir('drill-game-invariant');
  const bank = createMistakeBank(storeDir);
  const gameEvaluation = {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32), decisionId: 'd-1-preflop-0',
      providerId: SOURCE.id, providerVersion: SOURCE.version,
    }),
    payloadSha256: 'cd'.repeat(32), status: 'supported', street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo', grade: 'off-policy',
    forced: false, evLossBb: null, source: SOURCE, origin: 'game',
  };
  await bank.collect(gameEvaluation);
  const profile = createProfileStore(storeDir);
  const gameBefore = (await profile.show()).game;
  const evidenceBefore = await bank.listEvidence({ origin: 'game' });
  const started = await startDrill(storeDir, { mode: 'free', seed: 'practice', idempotencyKey: 'practice' });
  const next = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold', sessionId: started.sessionId,
    questionId: next.question.questionId, attemptNo: next.attemptNo,
  });
  assert.deepEqual((await profile.show()).game, gameBefore);
  assert.deepEqual(await bank.listEvidence({ origin: 'game' }), evidenceBefore);
});

// Captured from the actual 7dcef397 CLI and generator, stopped before profile apply.
const BASE7_LEGACY_SESSION = {
  "schemaVersion": 1,
  "sessionId": "5c80a37f-5fb4-4e0f-a85f-79f80daa1406",
  "idempotencyKey": "legacy-capture",
  "mode": "free",
  "seed": "0",
  "index": 0,
  "queue": [
    {
      "questionId": "drill:1.0.0:6max-100bb-utg-rfi-unopened:AJo:1",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "UTG",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-utg-rfi-unopened",
        "actionHistory": [],
        "legalActions": [
          "fold",
          "raise:2.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    },
    {
      "questionId": "drill:1.0.0:6max-100bb-hj-rfi-unopened:AJo:2",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "HJ",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-hj-rfi-unopened",
        "actionHistory": [],
        "legalActions": [
          "fold",
          "raise:2.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    },
    {
      "questionId": "drill:1.0.0:6max-100bb-bb-vs-single-raise:AJo:3",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "BB",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-bb-vs-single-raise",
        "actionHistory": [
          "raise"
        ],
        "legalActions": [
          "fold",
          "call",
          "raise:8.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    },
    {
      "questionId": "drill:1.0.0:6max-100bb-btn-rfi-unopened:AJo:4",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "BTN",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-btn-rfi-unopened",
        "actionHistory": [],
        "legalActions": [
          "fold",
          "raise:2.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    },
    {
      "questionId": "drill:1.0.0:6max-100bb-co-rfi-unopened:AJo:5",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "CO",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-co-rfi-unopened",
        "actionHistory": [],
        "legalActions": [
          "fold",
          "raise:2.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    },
    {
      "questionId": "drill:1.0.0:6max-100bb-sb-rfi-unopened:AJo:6",
      "mode": "free",
      "skillKey": "preflop.free",
      "prompt": {
        "position": "SB",
        "handClass": "AJo",
        "stackBb": 100,
        "spotKey": "6max-100bb-sb-rfi-unopened",
        "actionHistory": [],
        "legalActions": [
          "fold",
          "raise:2.5"
        ]
      },
      "answerPolicy": {
        "providerId": "local-preflop-baseline",
        "providerVersion": "1.0.0"
      }
    }
  ],
  "answers": [],
  "pending": {
    "answer": {
      "action": "fold"
    },
    "result": {
      "questionId": "drill:1.0.0:6max-100bb-utg-rfi-unopened:AJo:1",
      "status": "reference-adherence",
      "grade": "preferred",
      "frequency": 0.8,
      "recommended": [
        {
          "action": "fold",
          "frequency": 0.8,
          "evBb": null
        },
        {
          "action": "raise",
          "sizeBb": 2.5,
          "frequency": 0.2,
          "evBb": null
        }
      ],
      "feedback": "기준표 빈도에 포함된 허용 선택입니다. 한 번의 액션은 분포 일치도를 뜻하지 않습니다.",
      "providerVersion": "1.0.0"
    },
    "srsPatch": null,
    "profileEvent": {
      "evaluationId": "d3a369404582081012fdee567f651f5c4042fcace7668e59eb402ef9ca941cc5:d-1-preflop-0:local-preflop-baseline@1.0.0",
      "payloadSha256": "d3a369404582081012fdee567f651f5c4042fcace7668e59eb402ef9ca941cc5",
      "status": "supported",
      "street": "preflop",
      "spotKey": "6max-100bb-utg-rfi-unopened",
      "handClass": "AJo",
      "grade": "preferred",
      "forced": false,
      "evLossBb": null,
      "source": {
        "id": "local-preflop-baseline",
        "version": "1.0.0"
      },
      "origin": "drill"
    },
    "applied": {
      "srs": true,
      "profile": false
    },
    "questionId": "drill:1.0.0:6max-100bb-utg-rfi-unopened:AJo:1",
    "attemptNo": 0
  },
  "notices": []
};

test('S5 prior-producer legacy pending replays without inventing source, study or bank evidence', async () => {
  const storeDir = createOwnedTempDir('s5-real-legacy');
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  const legacy = structuredClone(BASE7_LEGACY_SESSION);
  writeDrillSession(storeDir, legacy);
  const next = await nextQuestion(storeDir);
  assert.equal(next.index, 1);
  const store = createProfileStore(storeDir);
  const rows = await store.readEventSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evaluationId, legacy.pending.profileEvent.evaluationId);
  assert.equal(rows[0].payloadSha256, legacy.pending.profileEvent.payloadSha256);
  assert.equal(rows[0].mixObservation, undefined);
  assert.equal(rows[0].studyRun, undefined);
  assert.equal(fs.existsSync(path.join(storeDir, '.training', 'mistakes.json')), false);
  const history = await readStudyHistory(storeDir);
  assert.equal(history.assessments.length, 0);
  assert.equal(history.unknownPreTrackingExposure, true);
  const before = storeBytes(storeDir);
  await assert.rejects(() => answerQuestion(storeDir, {
    action: 'fold', sessionId: legacy.sessionId,
    questionId: legacy.queue[1].questionId, attemptNo: 1,
  }), { code: 'SOURCE_UNVERIFIED' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('S5 a legacy schema label cannot bypass the actual prior-producer pending contract', async () => {
  const { storeDir, session } = await pendingFixture({ mode: 'free' });
  session.schemaVersion = 1;
  delete session.sourceIdentity;
  delete session.studyRun;
  writeDrillSession(storeDir, session);
  const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('pending replay rejects a rederived answer that the current question never offered', async (t) => {
  for (const answer of [{ action: 'check' }, { action: 'call' }, { action: 'raise', sizeBb: 8.5 }, { action: 'raise', sizeBb: 2.5001 }]) await t.test(JSON.stringify(answer), async () => {
    const { storeDir } = await pendingFixture({ mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
    const forged = capturedPending(storeDir, answer);
    writeDrillSession(storeDir, forged);
    const before = storeBytes(storeDir);
    await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
    assert.deepEqual(storeBytes(storeDir), before);
  });
});

test('history cannot complete or score future starts or answers at the supplied authoritative cutoff', async (t) => {
  const now = '2026-09-06T00:00:00.000Z';
  for (const kind of ['future-start', 'future-answer']) await t.test(kind, () => {
    const rows = [0, 1].map((index) => event(index, {
      startedAt: kind === 'future-start' ? '2099-01-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
      appliedAt: `2099-01-0${index + 1}T00:00:00.000Z`,
    }));
    const before = JSON.stringify(rows);
    const history = studyHistory(rows, now);
    const assessment = history.assessments[0];
    assert.equal(assessment.complete, false);
    assert.equal(assessment.completedAt, null);
    assert.equal(assessment.result.allowed, null);
    assert.equal(assessment.result.allowedActionRate, null);
    assert.equal(history.seenPairs.length, 0);
    assert.equal(retestEligibility(assessment, now).eligible, false);
    assert.equal(JSON.stringify(rows), before);
  });
});

test('history and retest boundaries use one deterministic clock for valid completed evidence', () => {
  const rows = [event(0, { appliedAt: '2026-09-06T01:00:00.000Z' }), event(1, { appliedAt: '2026-09-06T02:00:00.000Z' })];
  assert.equal(studyHistory(rows, '2026-09-06T01:30:00.000Z').assessments[0].complete, false);
  const complete = studyHistory(rows, '2026-09-06T02:00:00.000Z').assessments[0];
  assert.equal(complete.complete, true);
  assert.equal(complete.result.allowedActionRate, 1);
  assert.equal(retestEligibility(complete, '2026-09-07T01:59:59.999Z').eligible, false);
  assert.equal(retestEligibility(complete, '2026-09-07T02:00:00.000Z').eligible, true);
  assert.equal(retestEligibility({ ...complete, startedAt: '2099-01-01T00:00:00.000Z' }, '2026-09-07T02:00:00.000Z').eligible, false);
});

test('future retests cannot replace the latest qualifying completed retest', () => {
  const rows = [event(0), event(1)];
  const baselineId = rows[0].studyRun.id;
  for (const [id, at] of [
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-04T00:00:00.000Z'],
    ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2099-01-01T00:00:00.000Z'],
  ]) for (const index of [0, 1]) rows.push(event(index, { runId: id, mode: 'retest', assessmentId: baselineId, startedAt: at, appliedAt: at }));
  const history = studyHistory(rows, '2026-09-06T00:00:00.000Z');
  assert.deepEqual(history.retests.map((run) => run.complete), [true, false]);
  assert.equal(history.assessments[0].latestCompletedRetest.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(retestEligibility(history.assessments[0], '2026-09-06T00:00:00.000Z').eligible, true);
});

test('store history and retest start cannot trust a client clock to promote future records', async () => {
  const storeDir = createOwnedTempDir('s5-future-history');
  await startDrill(storeDir, { mode: 'free' });
  const rows = [0, 1].map((index) => event(index, { startedAt: '2099-01-01T00:00:00.000Z', appliedAt: `2099-01-0${index + 1}T00:00:00.000Z` }));
  const eventsPath = path.join(storeDir, '.training', 'profile-events.jsonl');
  fs.writeFileSync(eventsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const before = storeBytes(storeDir);
  const history = await readStudyHistory(storeDir, '2100-01-01T00:00:00.000Z');
  assert.equal(history.assessments[0].complete, false);
  assert.equal(history.assessments[0].result.allowedActionRate, null);
  await assert.rejects(() => startDrill(storeDir, { mode: 'retest', assessmentId: rows[0].studyRun.id,
    now: '2100-01-01T00:00:00.000Z', idempotencyKey: 'cannot-choose-time' }), { code: 'INCOMPLETE_ASSESSMENT' });
  assert.deepEqual(storeBytes(storeDir), before);
});

test('a pending profile flag cannot use a future appliedAt as completed consumer evidence', async () => {
  const { storeDir, session } = await pendingFixture({ mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
  const store = createProfileStore(storeDir);
  await store.apply(session.pending.profileEvent);
  const row = JSON.parse(fs.readFileSync(store.eventsPath, 'utf8').trim());
  row.appliedAt = '2099-01-01T00:00:00.000Z';
  fs.writeFileSync(store.eventsPath, `${JSON.stringify(row)}\n`);
  session.pending.applied.profile = true;
  writeDrillSession(storeDir, session);
  const before = storeBytes(storeDir);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(storeBytes(storeDir), before);
});
