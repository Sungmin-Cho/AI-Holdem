import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerQuestion, nextQuestion, startDrill } from '../tools/drill-cli.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createMistakeBank } from '../tools/training-stores.js';
import { readJsonl } from '../tools/training-store.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/drill-cli.js');
const CLI_HREF = pathToFileURL(CLI).href;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-drill-'));
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

function profileEventFor(session, question, attemptNo, grade = 'mixed') {
  const key = attemptKey(session.sessionId, question.questionId, attemptNo);
  const digest = digestOf(key);
  return {
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
    grade,
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

function writePending(storeDir, { srsPatch = null, applied = { srs: false, profile: false } } = {}) {
  const session = readSession(storeDir);
  const attemptNo = session.index;
  const question = session.queue[attemptNo];
  session.pending = {
    answer: { action: 'fold' },
    result: {
      questionId: question.questionId,
      grade: 'mixed',
      frequency: 0.4,
      recommended: [],
      feedback: 'pending-fixture',
      providerVersion: '1.0.0',
    },
    srsPatch,
    profileEvent: profileEventFor(session, question, attemptNo),
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
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  });
  assert.equal(collected.added, true);
  const srsPatch = {
    mistakeId: collected.item.mistakeId,
    patch: {
      lastReviewedAt: '2026-09-02T00:00:00.000Z',
      attempts: 1,
      intervalDays: 1,
      ease: 2.3,
      lapses: 0,
      nextReviewAt: '2026-09-03T00:00:00.000Z',
    },
  };
  writePending(storeDir, { srsPatch });
  assert.equal(profileEvents(storeDir).length, 0);

  const afterCrash = await nextQuestion(storeDir);
  assert.equal(afterCrash.done, false);
  assert.notEqual(afterCrash.question.questionId, question.questionId);
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

test('startDrill with pending journal replays then continues under a new key', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'old-k' });
  writePending(storeDir);
  const next = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'new-k' });
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.pending ?? null, null);
  assert.equal(next.index, 0);
  assert.equal(profileEvents(storeDir).length, 1);
  assert.equal(readSession(storeDir).sessionId, next.sessionId);
});

test('startDrill replay failure throws PENDING_UNRESOLVED and keeps the session', async () => {
  const storeDir = tmp();
  const first = await startDrill(storeDir, { mode: 'free', seed: '1', idempotencyKey: 'keep-k' });
  writePending(storeDir);
  fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(
    () => startDrill(storeDir, { mode: 'free', seed: '2', idempotencyKey: 'other-k' }),
    { code: 'PENDING_UNRESOLVED' },
  );
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
