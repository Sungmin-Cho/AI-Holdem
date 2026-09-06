import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startDrill, answerQuestion, readDrillSession, nextQuestion } from '../tools/drill-cli.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const spotKey = '6max-100bb-btn-rfi-unopened';
function file(store, name) { return path.join(store, '.training', name); }
function read(store) { return JSON.parse(fs.readFileSync(file(store, 'drill-session.json'), 'utf8')); }
function write(store, session) { fs.writeFileSync(file(store, 'drill-session.json'), JSON.stringify(session)); }
function snapshot(store) {
  return fs.readdirSync(file(store, '')).sort().map((name) => [name,
    createHash('sha256').update(fs.readFileSync(file(store, name))).digest('hex'),
    fs.statSync(file(store, name)).ino, fs.statSync(file(store, name)).mtimeMs]);
}
async function fixture() {
  const store = createOwnedTempDir('drill-committed-integrity');
  const session = await startDrill(store, { spotKey, handClass: 'AA' });
  const request = { sessionId: session.sessionId, questionId: session.queue[0].questionId, attemptNo: 0, action: 'fold' };
  const applied = await answerQuestion(store, request);
  assert.equal(applied.result.grade, 'off-policy');
  assert.equal(applied.result.frequency, 0);
  return { store, request, applied };
}

test('real committed feedback and retry retain exact confirmed result without writes', async () => {
  const { store, request, applied } = await fixture();
  const before = snapshot(store);
  assert.deepEqual((await readDrillSession(store)).lastResult, applied.result);
  assert.deepEqual((await nextQuestion(store)).lastResult, applied.result);
  assert.deepEqual((await answerQuestion(store, { ...request, action: 'call' })).result, applied.result);
  assert.deepEqual(snapshot(store), before);
});

const mutations = {
  removedRunAndQueueChanged: (s) => { s.index = 0; s.answers = []; s.studyRun.id = '22222222-2222-4222-8222-222222222222'; s.queue[0].prompt.handClass = 'KK'; s.queue[0].questionId = s.queue[0].questionId.replace(':AA:', ':KK:'); },
  removedAndRunChanged: (s) => { s.index = 0; s.answers = []; s.studyRun.id = '22222222-2222-4222-8222-222222222222'; },
  removedRunAndSourceChanged: (s) => { s.index = 0; s.answers = []; s.studyRun.id = '22222222-2222-4222-8222-222222222222'; s.sourceIdentity.contentSha256 = 'a'.repeat(64); },
  removed: (s) => { s.index = 0; s.answers = []; },
  sourceIdentity: (s) => { s.sourceIdentity.contentSha256 = 'a'.repeat(64); },
  grade: (s) => { s.answers[0].grade = 'preferred'; },
  frequency: (s) => { s.answers[0].frequency = 1; },
  vector: (s) => { s.answers[0].recommended = []; },
  feedback: (s) => { s.answers[0].feedback = 'forged confirmed feedback'; },
  questionId: (s) => { s.answers[0].questionId += ':foreign'; },
  runId: (s) => { s.studyRun.id = '11111111-1111-4111-8111-111111111111'; },
  sessionId: (s) => { s.sessionId = '11111111-1111-4111-8111-111111111111'; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`post-commit ${name} corruption fails closed on all session entrypoints`, async () => {
    const { store, request } = await fixture();
    const session = read(store); mutate(session); write(store, session);
    const before = snapshot(store);
    for (const invoke of [() => readDrillSession(store), () => nextQuestion(store),
      () => startDrill(store), () => startDrill(store, { idempotencyKey: session.idempotencyKey }),
      () => answerQuestion(store, { ...request, sessionId: session.sessionId })]) {
      await assert.rejects(invoke, { code: 'PENDING_UNRESOLVED' });
      assert.deepEqual(snapshot(store), before);
    }
  });
}

for (const name of ['missing', 'chosen', 'grade', 'noncanonical', 'ambiguous', 'source', 'time']) {
  test(`post-commit ${name} event corruption is unavailable evidence with zero writes`, async () => {
    const { store, request } = await fixture();
    const eventsFile = file(store, 'profile-events.jsonl');
    const event = JSON.parse(fs.readFileSync(eventsFile, 'utf8').trim());
    let events = [event];
    if (name === 'missing') events = [];
    if (name === 'chosen') event.mixObservation.chosenAction = { action: 'raise', sizeBb: 2.5 };
    if (name === 'grade') event.grade = 'preferred';
    if (name === 'noncanonical') event.evaluationId = `invalid:${event.evaluationId}`;
    if (name === 'source') event.mixObservation.sourceIdentity.contentSha256 = 'a'.repeat(64);
    if (name === 'time') event.appliedAt = '2999-01-01T00:00:00.000Z';
    if (name === 'ambiguous') {
      const other = structuredClone(event);
      other.evaluationId = other.evaluationId.replace(/^./, other.evaluationId[0] === 'a' ? 'b' : 'a');
      events.push(other);
    }
    fs.writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    const before = snapshot(store);
    for (const invoke of [() => readDrillSession(store), () => nextQuestion(store), () => startDrill(store),
      () => answerQuestion(store, request)]) {
      await assert.rejects(invoke, { code: 'PENDING_UNRESOLVED' });
      assert.deepEqual(snapshot(store), before);
    }
  });
}

test('corrupt prior feedback blocks an otherwise valid pending recovery before any consumer write', async () => {
  const store = createOwnedTempDir('drill-committed-pending');
  await startDrill(store, { seed: 'pending-integrity' });
  let session = read(store);
  for (let index = 0; index < 2; index += 1) {
    await answerQuestion(store, { sessionId: session.sessionId,
      questionId: session.queue[index].questionId, attemptNo: index, action: 'fold' });
  }
  session = read(store);
  const event = fs.readFileSync(file(store, 'profile-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[1];
  const result = session.answers.pop();
  session.index = 1;
  const profileEvent = {
    evaluationId: event.evaluationId, payloadSha256: event.payloadSha256,
    status: 'supported', street: 'preflop', spotKey: session.queue[1].prompt.spotKey,
    handClass: session.queue[1].prompt.handClass, grade: result.grade, forced: false, evLossBb: null,
    source: session.sourceIdentity, recommended: result.recommended, chosen: { action: 'fold' },
    origin: 'drill', studyRun: { ...session.studyRun, index: 1 },
  };
  session.pending = { answer: { action: 'fold' }, result, profileEvent, bankEvent: profileEvent,
    srsPatch: null, applied: { profile: true, bank: true, srs: true },
    questionId: session.queue[1].questionId, attemptNo: 1 };
  write(store, session);
  // Establish this captured journal can recover with the genuine prior result.
  assert.deepEqual((await nextQuestion(store)).lastResult, result);
  session.answers[0].feedback = 'forged earlier feedback';
  write(store, session);
  const before = snapshot(store);
  for (const invoke of [() => nextQuestion(store), () => readDrillSession(store), () => startDrill(store),
    () => answerQuestion(store, { sessionId: session.sessionId,
      questionId: session.pending.questionId, attemptNo: 1, action: 'fold' })]) {
    await assert.rejects(invoke, { code: 'PENDING_UNRESOLVED' });
    assert.deepEqual(snapshot(store), before);
  }
});

test('drill producer rejects the 8.45 tolerance boundary and commits only offered 8.5', async () => {
  const store = createOwnedTempDir('drill-committed-size');
  const session = await startDrill(store, { spotKey: '6max-100bb-bb-vs-single-raise', handClass: 'AA' });
  const request = { sessionId: session.sessionId, questionId: session.queue[0].questionId, attemptNo: 0, action: 'raise' };
  const before = snapshot(store);
  await assert.rejects(() => answerQuestion(store, { ...request, sizeBb: 8.45 }), { code: 'INVALID_DRILL_ANSWER' });
  assert.deepEqual(snapshot(store), before);
  const accepted = await answerQuestion(store, { ...request, sizeBb: 8.5 });
  assert.deepEqual((await readDrillSession(store)).lastResult, accepted.result);
});

 test('new distinct session remains allowed after a legitimate committed run', async () => {
  const { store, request } = await fixture();
  const fresh = await startDrill(store, { spotKey, handClass: 'AA' });
  assert.notEqual(fresh.sessionId, request.sessionId);
  const current = await readDrillSession(store);
  assert.equal(current.index, 0);
  assert.equal(current.lastResult, null);
  await answerQuestion(store, { sessionId: fresh.sessionId, questionId: fresh.queue[0].questionId, attemptNo: 0, action: 'fold' });
  assert.equal((await readDrillSession(store)).index, 1);
});
