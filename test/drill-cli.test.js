import {LEGACY_REFERENCE_SOURCE} from '../shared/reference.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerQuestion, nextQuestion, startDrill as startDrillCurrent } from '../tools/drill-cli.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createMistakeBank } from '../tools/training-stores.js';
import { readJsonl } from '../tools/training-store.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { loadPreflopDataset } from '../tools/preflop-dataset.js';
import { lookup } from '../training/providers/preflop-json.js';
import { nextSchedule } from '../training/spaced-repetition.js';

const startDrill = (dir, options = {}) => startDrillCurrent(dir, {source: LEGACY_REFERENCE_SOURCE, ...options});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/drill-cli.js');
const CLI_HREF = pathToFileURL(CLI).href;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_SHA256 = '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf';

function tmp() {
  return createOwnedTempDir('holdem-drill');
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).trim());
}

function sessionPath(storeDir) {
  return path.join(storeDir, '.training', 'drill-session.json');
}

function readSession(storeDir) {
  return JSON.parse(fs.readFileSync(sessionPath(storeDir), 'utf8'));
}

function writeSession(storeDir, session) {
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  fs.writeFileSync(sessionPath(storeDir), JSON.stringify(session));
}

function profileEvents(storeDir) {
  return readJsonl(path.join(storeDir, '.training', 'profile-events.jsonl'));
}

function attemptKey(sessionId, questionId, attemptNo) {
  return `drill:${sessionId}:${questionId}:${attemptNo}`;
}

function digestOf(key) {
  return createHash('sha256').update(key).digest('hex');
}

function profileEventFor(session, question, attemptNo, result) {
  const key = attemptKey(session.sessionId, question.questionId, attemptNo);
  const digest = digestOf(key);
  return {
    ...(session.schemaVersion===3?{assistance:{schemaVersion:1,hintShown:false,exposureId:null}}:{}),
    evaluationId: evaluationIdOf({
      gameEpoch: digest,
      decisionId: `d-${attemptNo + 1}-preflop-0`,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: digest,
    status: 'supported',
    street: 'preflop',
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
    grade: result.grade,
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
    recommended: result.recommended,
    chosen: { action: 'fold' },
    origin: session.mode === 'retest' ? 'retest' : 'drill',
    studyRun: { ...session.studyRun, index: attemptNo },
  };
}

function writePending(storeDir, { srsPatch = null, applied = { srs: false, bank: false, profile: false } } = {}) {
  const session = readSession(storeDir);
  const attemptNo = session.index;
  const question = session.queue[attemptNo];
  const dataset = loadPreflopDataset(path.resolve('training/data/preflop-baseline-v1.json'));
  const result = evaluateDrillAnswer(question, { action: 'fold' }, lookup(dataset, question.prompt));
  const profileEvent = profileEventFor(session, question, attemptNo, result);
  if (question.candidateMistakeId) {
    const bank = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'mistakes.json'), 'utf8'));
    const before = bank.reviewState[question.candidateMistakeId];
    const at = new Date().toISOString();
    srsPatch = { mistakeId: question.candidateMistakeId, before, patch: {
      lastReviewedAt: at, attempts: before.attempts + 1,
      ...nextSchedule({ ...before, grade: result.grade, now: Date.parse(at) }),
    } };
  }
  session.pending = {
    answer: { action: 'fold' },
    result,
    srsPatch,
    profileEvent,
    bankEvent: profileEvent,
    applied: { ...applied },
    questionId: question.questionId,
    attemptNo,
  };
  writeSession(storeDir, session);
  return session.pending;
}

function runModule(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('drill-cli start/next/answer/summary/due', () => {
  const storeDir = tmp();
  const started = run(['start', '--store-dir', storeDir, '--mode', 'free', '--seed', '1']);
  assert.equal(started.ok, true);
  assert.ok(started.count >= 1);
  const nxt = run(['next', '--store-dir', storeDir]);
  assert.equal(nxt.done, false);
  const answered = run(['answer', '--store-dir', storeDir, '--action', 'fold']);
  assert.equal(answered.ok, true);
  assert.equal(typeof answered.result.grade, 'string');
  const summary = run(['summary', '--store-dir', storeDir]);
  assert.equal(summary.answers.length, 1);
  const due = run(['due', '--store-dir', storeDir]);
  assert.equal(Array.isArray(due.due), true);
});

test('answerQuestion throws NO_SESSION without process.exit', async () => {
  const storeDir = tmp();
  const script = `
    import { answerQuestion } from ${JSON.stringify(CLI_HREF)};
    try {
      await answerQuestion(${JSON.stringify(storeDir)}, { action: 'fold' });
      process.stdout.write(JSON.stringify({ thrown: false }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ thrown: true, code: error.code }) + '\\n');
    }
  `;
  const { status, stdout } = await runModule(script);
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(status, 0);
  assert.equal(parsed.thrown, true);
  assert.equal(parsed.code, 'NO_SESSION');
});

test('crash after pending is replayed by nextQuestion and profile applies once', async () => {
  const storeDir = tmp();
  const started = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'crash-k' });
  assert.match(started.sessionId, UUID_RE);
  const nxt = await nextQuestion(storeDir);
  const question = nxt.question;
  const collected = await createMistakeBank(storeDir).collect({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-9-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
  });
  assert.equal(collected.added, true);
  await startDrill(storeDir, { mode: 'mistake-review', idempotencyKey: 'review-candidate' });
  writePending(storeDir);
  assert.equal(profileEvents(storeDir).length, 0);

  const afterCrash = await nextQuestion(storeDir);
  assert.equal(afterCrash.done, true);
  assert.equal(afterCrash.index, 1);
  assert.equal(profileEvents(storeDir).length, 1);
  const items = await createMistakeBank(storeDir).list();
  assert.equal(items[0].attempts, 1);

  await nextQuestion(storeDir);
  assert.equal(profileEvents(storeDir).length, 1);
  assert.equal((await createMistakeBank(storeDir).list())[0].attempts, 1);
});

test('duplicate answerQuestion returns the stored result and applies profile once', async () => {
  const storeDir = tmp();
  const started = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'dup-k' });
  const nxt = await nextQuestion(storeDir);
  const req = {
    action: 'fold',
    sessionId: started.sessionId,
    questionId: nxt.question.questionId,
    attemptNo: nxt.attemptNo,
  };
  const first = await answerQuestion(storeDir, req);
  const second = await answerQuestion(storeDir, req);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(profileEvents(storeDir).length, 1);
});

test('drill profile events are tagged origin drill and stay in their provider segment', async () => {
  const storeDir = tmp();
  const started = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'origin-k' });
  const nxt = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold',
    sessionId: started.sessionId,
    questionId: nxt.question.questionId,
    attemptNo: nxt.attemptNo,
  });
  const events = profileEvents(storeDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, 'drill');
  const { createProfileStore } = await import('../tools/training-stores.js');
  const profile = await createProfileStore(storeDir).show();
  assert.equal(profile.activeSegmentId, `${events[0].providerId}@${events[0].providerVersion}`);
});

test('retrying an earlier answer after a later one returns the original next', async () => {
  const storeDir = tmp();
  const started = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'replay-next-k' });
  const firstNext = await nextQuestion(storeDir);
  const firstReq = {
    action: 'fold',
    sessionId: started.sessionId,
    questionId: firstNext.question.questionId,
    attemptNo: firstNext.attemptNo,
  };
  const first = await answerQuestion(storeDir, firstReq);
  const secondNext = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold',
    sessionId: started.sessionId,
    questionId: secondNext.question.questionId,
    attemptNo: secondNext.attemptNo,
  });
  const replay = await answerQuestion(storeDir, firstReq);
  assert.deepEqual(replay, first);
  assert.equal(replay.next?.questionId, first.next?.questionId);
  assert.notEqual(replay.next?.questionId, readSession(storeDir).queue[readSession(storeDir).index]?.questionId);
});

test('omitted sessionId on a legacy session without UUID is STALE_QUESTION', async () => {
  const storeDir = tmp();
  await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'legacy-k' });
  const live = readSession(storeDir);
  const question = live.queue[0];
  delete live.sessionId;
  writeSession(storeDir, live);
  await assert.rejects(
    () => answerQuestion(storeDir, {
      action: 'fold',
      questionId: question.questionId,
      attemptNo: 0,
    }),
    { code: 'STALE_QUESTION' },
  );
  assert.equal(profileEvents(storeDir).length, 0);
});

test('questionId mismatch and attemptNo mismatch are independently STALE_QUESTION', async () => {
  const storeDir = tmp();
  const started = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'mismatch-k' });
  const nxt = await nextQuestion(storeDir);
  await assert.rejects(
    () => answerQuestion(storeDir, {
      action: 'fold',
      sessionId: started.sessionId,
      questionId: 'not-this-question',
      attemptNo: nxt.attemptNo,
    }),
    { code: 'STALE_QUESTION' },
  );
  await assert.rejects(
    () => answerQuestion(storeDir, {
      action: 'fold',
      sessionId: started.sessionId,
      questionId: nxt.question.questionId,
      attemptNo: nxt.attemptNo + 3,
    }),
    { code: 'STALE_QUESTION' },
  );
  assert.equal(profileEvents(storeDir).length, 0);
  assert.equal(readSession(storeDir).index, 0);
});

test('two sessions with the same seed use distinct attempt keys', async () => {
  const storeDir = tmp();
  const firstStart = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'seed-a' });
  const firstNext = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold',
    sessionId: firstStart.sessionId,
    questionId: firstNext.question.questionId,
    attemptNo: firstNext.attemptNo,
  });
  const firstId = profileEvents(storeDir)[0].evaluationId;

  const secondStart = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'seed-b' });
  assert.notEqual(secondStart.sessionId, firstStart.sessionId);
  const secondNext = await nextQuestion(storeDir);
  assert.equal(secondNext.question.questionId, firstNext.question.questionId);
  await answerQuestion(storeDir, {
    action: 'fold',
    sessionId: secondStart.sessionId,
    questionId: secondNext.question.questionId,
    attemptNo: secondNext.attemptNo,
  });
  const ids = profileEvents(storeDir).map((event) => event.evaluationId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.notEqual(ids[1], firstId);
  const keyA = attemptKey(firstStart.sessionId, firstNext.question.questionId, firstNext.attemptNo);
  const keyB = attemptKey(secondStart.sessionId, secondNext.question.questionId, secondNext.attemptNo);
  assert.notEqual(keyA, keyB);
  assert.equal(ids[0].startsWith(digestOf(keyA)), true);
  assert.equal(ids[1].startsWith(digestOf(keyB)), true);
});

test('startDrill with the same idempotencyKey returns the existing session', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'same-k' });
  assert.match(first.sessionId, UUID_RE);
  const nxt = await nextQuestion(storeDir);
  await answerQuestion(storeDir, {
    action: 'fold',
    sessionId: first.sessionId,
    questionId: nxt.question.questionId,
    attemptNo: nxt.attemptNo,
  });
  const again = await startDrill(storeDir, { mode: 'free', seed: '9', idempotencyKey: 'same-k' });
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.index, 1);
  assert.equal(again.seed, '1');
});

test('startDrill requires pending resume before continuing under a new key', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'old-k' });
  writePending(storeDir);
  const before = fs.readFileSync(sessionPath(storeDir));
  await assert.rejects(() => startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'new-k' }), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(fs.readFileSync(sessionPath(storeDir)), before);
  await nextQuestion(storeDir);
  const next = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'new-k' });
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.pending ?? null, null);
  assert.equal(next.index, 0);
  assert.equal(profileEvents(storeDir).length, 1);
  assert.equal(readSession(storeDir).sessionId, next.sessionId);
});

test('startDrill preserves unresolved pending for an explicit retry', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'keep-k' });
  writePending(storeDir);
  fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(
    () => startDrill(storeDir, { mode: 'free', seed: '2', idempotencyKey: 'other-k' }),
    { code: 'PENDING_UNRESOLVED' },
  );
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  const session = readSession(storeDir);
  assert.equal(session.sessionId, first.sessionId);
  assert.ok(session.pending);
  assert.equal(session.pending.applied.profile, false);
});

test('malformed pending journal is PENDING_UNRESOLVED and is not cleared', async () => {
  const storeDir = tmp();
  await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'bad-pending-k' });
  const session = readSession(storeDir);
  session.pending = { attemptNo: 0 };
  writeSession(storeDir, session);
  await assert.rejects(() => nextQuestion(storeDir), { code: 'PENDING_UNRESOLVED' });
  assert.deepEqual(readSession(storeDir).pending, { attemptNo: 0 });
  assert.equal(profileEvents(storeDir).length, 0);
});

test('answer from a previous sessionId throws STALE_QUESTION', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'stale-a' });
  const nxt = await nextQuestion(storeDir);
  await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'stale-b' });
  await assert.rejects(
    () => answerQuestion(storeDir, {
      action: 'fold',
      sessionId: first.sessionId,
      questionId: nxt.question.questionId,
      attemptNo: nxt.attemptNo ?? 0,
    }),
    { code: 'STALE_QUESTION' },
  );
  assert.equal(profileEvents(storeDir).length, 0);
});

test('CLI rejects actions and exact sizes absent from the current question without any writes', async (t) => {
  for (const answer of [{ action: 'check' }, { action: 'call' }, { action: 'raise', sizeBb: 8.5 }, { action: 'raise', sizeBb: 2.5001 }]) {
    await t.test(JSON.stringify(answer), async () => {
      const storeDir = tmp();
      const session = await startDrill(storeDir, { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
      assert.deepEqual(session.queue[0].prompt.legalActions, ['fold', 'raise:2.5']);
      const snapshot = () => Object.fromEntries(['drill-session.json', 'profile.json', 'profile-events.jsonl', 'mistakes.json'].map((name) => {
        const file = path.join(storeDir, '.training', name);
        return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
      }));
      const before = snapshot();
      const result = spawnSync(process.execPath, [CLI, 'answer', '--store-dir', storeDir, '--action', answer.action,
        ...(answer.sizeBb !== undefined ? ['--size-bb', String(answer.sizeBb)] : []),
        '--session-id', session.sessionId, '--question-id', session.queue[0].questionId, '--attempt-no', '0'], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).code, 'INVALID_DRILL_ANSWER');
      assert.deepEqual(snapshot(), before);
    });
  }
});

test('an offered off-policy raise and an offered defense call remain valid answers', async () => {
  const storeDir = tmp();
  const open = await startDrill(storeDir, { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: '72o' });
  const raised = await answerQuestion(storeDir, { action: 'raise', sizeBb: 2.5,
    sessionId: open.sessionId, questionId: open.queue[0].questionId, attemptNo: 0 });
  assert.equal(raised.result.grade, 'off-policy');
  const defense = await startDrill(storeDir, { mode: 'free', spotKey: '6max-100bb-bb-vs-single-raise', handClass: 'KQs' });
  assert.deepEqual(defense.queue[0].prompt.legalActions, ['fold', 'call', 'raise:8.5']);
  const called = await answerQuestion(storeDir, { action: 'call', sessionId: defense.sessionId,
    questionId: defense.queue[0].questionId, attemptNo: 0 });
  assert.equal(called.ok, true);
});
