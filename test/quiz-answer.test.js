// #349: an end-of-game quiz answer on a due mistake-bank item is recorded as one spaced-repetition
// review. The answer route (POST /api/game/:id/quiz-answer) records the chart view first, grades on
// the server and moves only the bank item's review state; nothing reaches the profile or its events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { remoteRouteOf, startAppServer } from '../tools/app-server.js';
import * as drill from '../tools/drill-cli.js';
import { answerQuestion, nextQuestion, startDrill } from '../tools/drill-cli.js';
import * as generator from '../training/drill-generator.js';
import { generateQueue } from '../training/drill-generator.js';
import { createMistakeBank } from '../tools/training-stores.js';
import { createRoomManager } from '../tools/room-manager.js';
import { readStudySummary } from '../tools/study-summary.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { KNOWN_REFERENCE_SOURCES, LEGACY_REFERENCE_SOURCE, V3_REFERENCE_SOURCE } from '../shared/reference.js';
import { lookup } from '../training/providers/preflop-json.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { nativePreflopSnapshotV3 } from '../training/native-preflop-snapshot-v3.js';
import { toPublicSummary } from '../training/public-view.js';
import { evaluationIdOf } from '../training/contracts.js';
import { nextSchedule } from '../training/spaced-repetition.js';
import { makeLoop, makeSession } from './helpers/relay-proxy-fixture.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { createProfileStore } from '../tools/training-stores.js';
import { LEARNING_EFFECT_PROTOCOL_V1, PROTOCOL_SHA256, evaluateLearningEffect, sealPlan } from '../training/learning-effect.js';

const GAME = '00000000-0000-4000-8000-000000000349';
const EPOCH = 'ab'.repeat(32);
const TOKEN = 'c'.repeat(64);
const dataset = loadReferenceDataset(V3_REFERENCE_SOURCE);
const V3 = { id: dataset.data.id, version: dataset.data.version, contentSha256: dataset.contentSha256 };
const LEGACY = loadReferenceDataset(LEGACY_REFERENCE_SOURCE);
const BTN = '6max-100bb-btn-rfi-v3';
const CO = '6max-100bb-co-rfi-v3';
const HJ = '6max-100bb-hj-rfi-v3';
const DAY = 86_400_000;
const RANKS = 'AKQJT98765432';
const HANDS = [...RANKS].flatMap((high, row) => [...RANKS].map((low, col) => (row === col ? high + low : row < col ? `${high}${low}s` : `${low}${high}o`)));

// Offered prompt actions of a spot, by the drill's own question builder.
const promptOf = (spotKey) => generateQueue({ mode: 'free', source: V3, spotKey, limit: 1,
  admits: (s, h) => lookup(dataset, { spotKey: s, handClass: h }).status === 'supported' })[0].prompt.legalActions;
const classes = (legal) => [...new Set(legal.map((entry) => entry.split(':')[0]))];
function chosenFor(spotKey, action) {
  const entry = promptOf(spotKey).find((row) => row.split(':')[0] === action);
  const [, size] = entry.split(':');
  return { action, ...(size ? { sizeBb: Number(size) } : {}) };
}
function cellOf(spotKey, handClass, data = dataset) {
  const found = lookup(data, { spotKey, handClass });
  if (found.status !== 'supported') return null;
  const out = { fold: 0, call: 0, raise: 0 };
  for (const row of found.actions) out[row.action] = Math.round((out[row.action] + row.frequency) * 10000) / 10000;
  return out;
}
// A v3 game evaluation of the host choosing `action` with `handClass` at `spotKey`.
let epochs = 0;
function evaluation(spotKey, handClass, action, { handNo = 1, origin = 'game' } = {}) {
  epochs += 1;
  const gameEpoch = epochs.toString(16).padStart(2, '0').repeat(32);
  return { ...evaluatePreflopReferenceV3(nativePreflopSnapshotV3(spotKey, handClass, chosenFor(spotKey, action)), dataset, { gameEpoch }),
    payloadSha256: gameEpoch, handNo, origin };
}
const missOf = (spotKey, handClass) => classes(promptOf(spotKey)).find((action) => cellOf(spotKey, handClass)[action] === 0);
const topOf = (spotKey, handClass) => {
  const cell = cellOf(spotKey, handClass);
  return classes(promptOf(spotKey)).sort((a, b) => cell[b] - cell[a])[0];
};
// The published training summary the table shows for that decision.
const trainingRow = (row) => toPublicSummary(row, { handNo: row.handNo });

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exposureRows = (store) => {
  try { return readJson(path.join(store, '.training', 'grid-exposure-log.json')).rows; } catch { return []; }
};
const journalFile = (store) => path.join(store, '.training', 'quiz-reviews.json');
const journal = (store) => { try { return readJson(journalFile(store)); } catch { return null; } };
async function bankItems(store) { return createMistakeBank(store).list(); }
const bankBytes = (store) => { try { return fs.readFileSync(path.join(store, '.training', 'mistakes.json'), 'utf8'); } catch { return null; } };
// Everything in the study store except what the quiz is allowed to write.
function protectedFiles(store) {
  const root = path.join(store, '.training');
  const out = {};
  const allowed = new Set(['grid-exposure-log.json', 'grid-exposures.json', 'mistakes.json', 'quiz-reviews.json']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.endsWith('.lock.d')) walk(full); continue; }
      if (!allowed.has(path.relative(root, full))) out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  try { walk(root); } catch { /* no study store yet */ }
  return out;
}

async function fixture(t, { training = [], gameOver = true, state = 'ended', session = null } = {}) {
  const store = createOwnedTempDir('quiz-answer');
  const sessionDir = session?.sessionDir ?? path.join(store, 'session');
  const room = createRoomManager({ storeDir: store });
  room.open({ totalSeats: 3 });
  const guest = room.join({ code: room.load().joinCode, name: 'Guest', addr: '1' });
  const statePath = path.join(sessionDir, 'state.json');
  if (session) writeJson(statePath, { ...readJson(statePath), gameOver });
  else writeJson(statePath, { gameOver, sessionToken: TOKEN, revision: 1 });
  writeJson(path.join(sessionDir, 'ui-snapshot.json'), { training });
  const epoch = session?.gameEpoch ?? EPOCH;
  const manager = { room, current: { gameId: GAME, sessionDir, selectionVersion: 1 },
    snapshot: () => ({ gameId: GAME, gameEpoch: epoch, state }), ...(session ? { session: { loop: session.loop } } : {}) };
  const app = await startAppServer({ manager, token: 'host', storeDir: store, publicPort: 0 });
  registerOwnedServer(app.server, 'quiz-answer-app');
  t.after(() => app.close());
  const headers = { authorization: 'Bearer host', 'x-game-epoch': epoch, 'content-type': 'application/json', connection: 'close' };
  const call = async (endpoint, body, over = {}) => {
    const response = await fetch(`${app.origin}/api/game/${GAME}/${endpoint}`, { method: 'POST', headers: { ...headers, ...over }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    store, sessionDir, app, guest, headers, manager,
    open: (pairs, over) => call('quiz', { items: pairs.map(({ spotKey, handClass }) => ({ spotKey, handClass })) }, over),
    answer: (spotKey, handClass, action, over) => call('quiz-answer', { spotKey, handClass, action }, over),
    setTraining: (rows) => writeJson(path.join(sessionDir, 'ui-snapshot.json'), { training: rows }),
    setGameOver: (value) => writeJson(statePath, { ...readJson(statePath), gameOver: value }),
  };
}

// A store whose bank has one due game item for (spot, hand), and a finished game that asked it.
async function dueGame(t, spotKey = BTN, handClass = '72o', options = {}) {
  const miss = evaluation(spotKey, handClass, missOf(spotKey, handClass), { handNo: 4 });
  const f = await fixture(t, { ...options, training: [trainingRow(miss), ...(options.training ?? [])] });
  const collected = await createMistakeBank(f.store).collect(miss);
  assert.equal(collected.added, true);
  return { ...f, miss, item: collected.item };
}

test('answering a due bank item on the end screen records one review and the study room counts one fewer due', { timeout: 120_000 }, async (t) => {
  const f = await dueGame(t);
  const before = await readStudySummary(f.store);
  assert.equal(before.bank.dueCount, 1);
  const untouched = protectedFiles(f.store);
  const opened = await f.open([{ spotKey: BTN, handClass: '72o' }]);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body, { ok: true, items: [{ spotKey: BTN, handClass: '72o', choices: ['fold', 'raise'] }] },
    'the question carries its choices and no reference');
  assert.equal(exposureRows(f.store).length, 0, 'opening shows no reference and records no view');
  const answered = await f.answer(BTN, '72o', 'fold');
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.reference, cellOf(BTN, '72o'));
  assert.equal(answered.body.review.recorded, true);
  assert.equal(answered.body.review.already, false);
  const [item] = await bankItems(f.store);
  assert.equal(item.attempts, 1);
  assert.ok(item.lastReviewedAt);
  assert.ok(Date.parse(item.nextReviewAt) >= Date.parse(item.lastReviewedAt) + DAY);
  assert.equal(answered.body.review.nextReviewAt, item.nextReviewAt);
  assert.equal(answered.body.review.intervalDays, item.intervalDays);
  // The answer is the drill's own transition for this grade.
  const expected = { ...f.item.reviewState, lastReviewedAt: item.lastReviewedAt, attempts: 1,
    ...nextSchedule({ grade: 'preferred', intervalDays: 1, ease: 2.3, lapses: 0, now: Date.parse(item.lastReviewedAt), srsVersion: 2, correctStreak: 0, graduatedAt: null }) };
  assert.deepEqual(item.reviewState, expected);
  // The answer is a chart view; the profile, its events and every other study file are untouched.
  assert.deepEqual(exposureRows(f.store).map((row) => [row.spotKey, row.sourceIdentity.version]), [[BTN, '3.0.0']]);
  assert.deepEqual(protectedFiles(f.store), untouched);
  assert.deepEqual(journal(f.store).rows.map((row) => [row.gameId, row.spotKey, row.handClass, row.state]), [[GAME, BTN, '72o', 'applied']]);
  const after = await readStudySummary(f.store);
  assert.equal(after.bank.dueCount, 0, 'the study room counts one fewer due item');
});

test('the same answer sent again, or another answer to the same question, counts once', async (t) => {
  const f = await dueGame(t);
  assert.equal((await f.answer(BTN, '72o', 'fold')).body.review.recorded, true);
  const again = await f.answer(BTN, '72o', 'fold');
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.review, { ...again.body.review, recorded: true, already: true });
  const other = await f.answer(BTN, '72o', 'raise');
  assert.equal(other.body.review.already, true);
  assert.deepEqual(other.body.reference, cellOf(BTN, '72o'), 'the reference is still shown for the new answer');
  assert.equal((await bankItems(f.store))[0].attempts, 1);
  assert.equal(exposureRows(f.store).length, 3, 'every answer is a view');
});

test('nothing is written to the bank for a pair not in it, an item not due yet or a graduated item', async (t) => {
  const rows = [evaluation(CO, '72o', missOf(CO, '72o'), { handNo: 2 }), evaluation(HJ, '72o', missOf(HJ, '72o'), { handNo: 3 })];
  const f = await dueGame(t, BTN, '72o', { training: rows.map(trainingRow) });
  const bank = createMistakeBank(f.store);
  const notDue = (await bank.collect(rows[1])).item;
  await bank.updateReviewState(notDue.mistakeId, { nextReviewAt: new Date(Date.now() + 3 * DAY).toISOString() });
  const at = new Date(Date.parse(f.item.lastSeenAt) + 1000).toISOString();     // graduated after its last miss
  await bank.updateReviewState(f.item.mistakeId, { srsVersion: 2, graduatedAt: at, lastReviewedAt: at, nextReviewAt: new Date(Date.now() + 40 * DAY).toISOString() });
  const before = bankBytes(f.store);
  const missing = await f.answer(CO, '72o', 'fold');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.review, { recorded: false, reason: 'NOT_IN_BANK' });
  assert.deepEqual((await f.answer(HJ, '72o', 'fold')).body.review, { recorded: false, reason: 'NOT_DUE' });
  assert.deepEqual((await f.answer(BTN, '72o', 'fold')).body.review, { recorded: false, reason: 'NOT_DUE' }, 'a graduated item is not due');
  assert.equal(bankBytes(f.store), before);
  assert.equal(journal(f.store), null);
  assert.equal(exposureRows(f.store).length, 3, 'each answer still records its view');
});

test('a graduated item missed again after its last review is due and is recorded', async (t) => {
  const miss = evaluation(BTN, '72o', missOf(BTN, '72o'), { handNo: 4 });
  const f = await fixture(t, { training: [trainingRow(miss)] });
  const clock = (offset) => () => new Date(Date.now() + offset).toISOString();
  const { item } = await createMistakeBank(f.store, { now: clock(-5 * DAY) }).collect(miss);
  const at = new Date(Date.now() - 4 * DAY).toISOString();
  await createMistakeBank(f.store).updateReviewState(item.mistakeId, { srsVersion: 2, graduatedAt: at, lastReviewedAt: at, intervalDays: 30,
    correctStreak: 4, nextReviewAt: new Date(Date.now() + 26 * DAY).toISOString() });
  assert.equal((await readStudySummary(f.store)).bank.dueCount, 0, 'graduated');
  await createMistakeBank(f.store, { now: clock(-2 * DAY) }).collect(evaluation(BTN, '72o', missOf(BTN, '72o')));   // the same miss again
  assert.equal((await readStudySummary(f.store)).bank.dueCount, 1, 'due again although its scheduled time is weeks away');
  const answered = await f.answer(BTN, '72o', 'fold');
  assert.equal(answered.body.review.recorded, true);
  assert.equal((await readStudySummary(f.store)).bank.dueCount, 0);
});

test('with a game and a practice item for the same pair only the first due item in bank order is reviewed, once', async (t) => {
  const f = await dueGame(t);
  const practice = (await createMistakeBank(f.store).collect(evaluation(BTN, '72o', missOf(BTN, '72o'), { origin: 'practice' }))).item;
  assert.notEqual(practice.mistakeId, f.item.mistakeId);
  const listed = await bankItems(f.store);
  assert.deepEqual(listed.map((row) => row.mistakeId), [f.item.mistakeId, practice.mistakeId]);
  assert.equal((await f.answer(BTN, '72o', 'fold')).body.review.recorded, true);
  assert.equal((await f.answer(BTN, '72o', 'fold')).body.review.already, true);
  const [game, other] = await bankItems(f.store);
  assert.equal(game.attempts, 1);
  assert.deepEqual(other.reviewState, practice.reviewState, 'the second item is not touched by a resend');
  assert.equal(journal(f.store).rows[0].mistakeId, f.item.mistakeId);
});

test('a pair the game did not ask is refused, by the answer route and by the open route', async (t) => {
  // Six compared decisions: the quiz asks five of them (off-policy first, then by hand number).
  const rows = ['72o', '82o', '32o', '42o', '52o', '62o'].map((hand, at) => evaluation(BTN, hand, missOf(BTN, hand), { handNo: at + 1 }));
  const f = await fixture(t, { training: rows.map(trainingRow) });
  const opened = await f.open([{ spotKey: BTN, handClass: '72o' }, { spotKey: BTN, handClass: '62o' }, { spotKey: CO, handClass: 'AA' }]);
  assert.deepEqual(opened.body.items.map((row) => row.handClass), ['72o'], 'the sixth decision and a foreign pair are not served');
  const before = exposureRows(f.store).length;
  for (const [spotKey, handClass] of [[BTN, '62o'], [CO, 'AA']]) {
    const refused = await f.answer(spotKey, handClass, 'fold');
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { code: 'QUIZ_NOT_ISSUED' });
  }
  assert.equal(exposureRows(f.store).length, before);
});

test('rows the relay restore drops (duplicate identity, changed hand under an old digest) are not questions', async (t) => {
  const kept = evaluation(BTN, '72o', missOf(BTN, '72o'), { handNo: 1 });
  const twice = evaluation(CO, '72o', missOf(CO, '72o'), { handNo: 2 });
  const forged = { ...trainingRow(evaluation(HJ, '72o', missOf(HJ, '72o'), { handNo: 3 })), handClass: '82o' };
  const f = await fixture(t, { training: [trainingRow(kept), trainingRow(twice), { ...trainingRow(twice), handNo: 9 }, forged] });
  const opened = await f.open([{ spotKey: BTN, handClass: '72o' }, { spotKey: CO, handClass: '72o' }, { spotKey: HJ, handClass: '82o' }]);
  assert.deepEqual(opened.body.items.map((row) => `${row.spotKey}:${row.handClass}`), [`${BTN}:72o`]);
  assert.deepEqual((await f.answer(CO, '72o', 'fold')).body, { code: 'QUIZ_NOT_ISSUED' });
  assert.deepEqual((await f.answer(HJ, '82o', 'fold')).body, { code: 'QUIZ_NOT_ISSUED' });
  // No cache: the next request reads the committed state again.
  f.setTraining([trainingRow(kept), trainingRow(twice)]);
  assert.deepEqual((await f.open([{ spotKey: CO, handClass: '72o' }])).body.items.map((row) => row.handClass), ['72o']);
});

test('an action the question does not offer is refused before anything is written', async (t) => {
  const f = await dueGame(t);
  const before = bankBytes(f.store);
  for (const body of [{ spotKey: BTN, handClass: '72o', action: 'call' }, { spotKey: BTN, handClass: '72o', action: 'check' },
    { spotKey: BTN, handClass: '72o' }, { spotKey: BTN, handClass: '72o', action: 'fold', extra: 1 }]) {
    const response = await fetch(`${f.app.origin}/api/game/${GAME}/quiz-answer`, { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { code: 'BAD_COMMAND' });
  }
  assert.equal(exposureRows(f.store).length, 0);
  assert.equal(bankBytes(f.store), before);
});

test('every grade moves the schedule exactly as the drill would', async () => {
  // BB against a button open: AA is raised 95% and called 5%, A9s called 45%; neither is folded (the miss).
  const VS = '6max-100bb-bb-vs-btn-open-v3';
  assert.deepEqual([cellOf(VS, 'AA'), cellOf(VS, 'A9s').fold], [{ fold: 0, call: 0.05, raise: 0.95 }, 0]);
  for (const [grade, spotKey, handClass, action] of [['preferred', VS, 'AA', 'raise'], ['mixed', VS, 'A9s', 'call'],
    ['low-frequency', VS, 'AA', 'call'], ['off-policy', BTN, '72o', 'raise']]) {
    const store = createOwnedTempDir('quiz-grade');
    const { item } = await createMistakeBank(store).collect(evaluation(spotKey, handClass, missOf(spotKey, handClass)));
    const out = await drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey, handClass, action });
    assert.equal(out?.review?.recorded, true, grade);
    const [after] = await bankItems(store);
    const at = after.lastReviewedAt;
    const r = item.reviewState;
    assert.deepEqual(after.reviewState, { ...r, lastReviewedAt: at, attempts: r.attempts + 1,
      ...nextSchedule({ grade, intervalDays: r.intervalDays, ease: r.ease, lapses: r.lapses, now: Date.parse(at), srsVersion: 2,
        correctStreak: r.correctStreak, graduatedAt: r.graduatedAt ?? null }) }, grade);
    assert.equal(journal(store).rows[0].grade, grade);
  }
});

test('while an assessment is open, also one started after the quiz was opened, nothing is recorded and no reference is sent', async (t) => {
  const f = await dueGame(t);
  assert.equal((await f.open([{ spotKey: BTN, handClass: '72o' }])).status, 200);
  await startDrill(f.store, { mode: 'assessment', source: V3, seed: 'quiz-lock' });
  const before = bankBytes(f.store);
  const answered = await f.answer(BTN, '72o', 'fold');
  assert.equal(answered.status, 409);
  assert.deepEqual(answered.body, { code: 'GRID_LOCKED' }, 'no reference rides on a refusal');
  assert.deepEqual((await f.open([{ spotKey: BTN, handClass: '72o' }])).body, { code: 'GRID_LOCKED' });
  assert.equal(exposureRows(f.store).length, 0);
  assert.equal(bankBytes(f.store), before);
  assert.equal(journal(f.store), null);
});

test('a drill session whose state cannot be proven refuses the quiz without writing', async (t) => {
  const f = await dueGame(t);
  const sessionPath = path.join(f.store, '.training', 'drill-session.json');
  for (const [session, code] of [
    [{ mode: 'assessment', queue: [{}], answers: [] }, 'GRID_LOCKED'],          // no index: its end is not proven
    [{ mode: 'assessment', queue: [], index: 0, answers: [], pending: { attemptNo: 0 } }, 'GRID_LOCKED'],
    [{ mode: 'nightly', queue: [], index: 0 }, 'STUDY_BUSY'],
    [{ mode: 'free', queue: 'x', index: 0 }, 'STUDY_BUSY'],
    [[1, 2], 'STUDY_BUSY'],
  ]) {
    writeJson(sessionPath, session);
    assert.deepEqual((await f.answer(BTN, '72o', 'fold')).body, { code }, JSON.stringify(session));
    assert.deepEqual((await f.open([{ spotKey: BTN, handClass: '72o' }])).body, { code }, JSON.stringify(session));
  }
  fs.writeFileSync(sessionPath, '{not json');
  assert.deepEqual((await f.answer(BTN, '72o', 'fold')).body, { code: 'STUDY_BUSY' });
  assert.equal(exposureRows(f.store).length, 0);
  assert.equal(journal(f.store), null);
});

test('an unresolved drill answer refuses the quiz, and the drill recovers it afterwards', { skip: process.getuid?.() === 0 ? 'root ignores file modes' : false, timeout: 120_000 }, async (t) => {
  const f = await dueGame(t);
  const events = path.join(f.store, '.training', 'profile-events.jsonl');
  fs.writeFileSync(events, '');
  const daily = await startDrill(f.store, { mode: 'daily', source: V3, seed: 'pending' });
  assert.equal(daily.queue[0].candidateMistakeId, f.item.mistakeId);
  // The profile consumer fails after the answer was captured: the drill session keeps its pending answer.
  fs.chmodSync(events, 0o444);
  const question = daily.queue[0];
  const [action, size] = question.prompt.legalActions[0].split(':');
  await assert.rejects(answerQuestion(f.store, { sessionId: daily.sessionId, questionId: question.questionId, attemptNo: 0,
    action, ...(size ? { sizeBb: Number(size) } : {}) }), { code: 'PENDING_UNRESOLVED' });
  fs.chmodSync(events, 0o644);
  assert.ok(readJson(path.join(f.store, '.training', 'drill-session.json')).pending);
  const before = bankBytes(f.store);
  assert.deepEqual((await f.answer(BTN, '72o', 'fold')).body, { code: 'STUDY_BUSY' });
  assert.equal(bankBytes(f.store), before);
  assert.equal(exposureRows(f.store).length, 0);
  const resumed = await nextQuestion(f.store);
  assert.equal(resumed.done, true);
  assert.equal((await bankItems(f.store))[0].attempts, 1, 'the drill applied its own captured review');
});

test('an answer from an older reference version records the view but not a review', async (t) => {
  const spotKey = '6max-100bb-co-rfi-unopened';
  const evaluationId = evaluationIdOf({ gameEpoch: 'de'.repeat(32), decisionId: 'd-3-preflop-0', providerId: LEGACY.data.id, providerVersion: LEGACY.data.version });
  const row = toPublicSummary({ evaluationId, decisionId: 'd-3-preflop-0', status: 'supported', street: 'preflop', spotKey, handClass: '72o',
    chosen: { action: 'raise', sizeBb: 2.5 }, recommended: [{ action: 'fold', frequency: 1 }], grade: 'off-policy', forced: false,
    evLossBb: null, source: { id: LEGACY.data.id, version: LEGACY.data.version } }, { handNo: 3 });
  const f = await fixture(t, { training: [row] });
  const opened = await f.open([{ spotKey, handClass: '72o' }]);
  assert.deepEqual(opened.body.items, [{ spotKey, handClass: '72o', choices: ['fold', 'raise'] }]);
  const answered = await f.answer(spotKey, '72o', 'fold');
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.reference, cellOf(spotKey, '72o', LEGACY));
  assert.deepEqual(answered.body.review, { recorded: false, reason: 'SOURCE_NOT_TRACKED' });
  assert.deepEqual(exposureRows(f.store).map((row) => row.sourceIdentity.version), ['1.0.0']);
  assert.equal(journal(f.store), null);
});

test('a projected short-stack push spot outside the practice list is still a question with its own choices', async (t) => {
  const spotKey = '9max-10bb-utg-push-v3';
  assert.throws(() => promptOf(spotKey), { code: 'UNSUPPORTED_SPOT' }, 'the drill does not practise this spot');
  const cell = cellOf(spotKey, '72o');
  const miss = cell.raise === 0 ? 'raise' : 'fold';
  const raw = { ...evaluatePreflopReferenceV3(nativePreflopSnapshotV3(spotKey, '72o', miss === 'raise' ? { action: 'raise', sizeBb: 10 } : { action: 'fold' }),
    dataset, { gameEpoch: 'ef'.repeat(32) }), payloadSha256: 'ef'.repeat(32), handNo: 5 };
  assert.equal(raw.status, 'supported');
  const f = await fixture(t, { training: [trainingRow(raw), trainingRow(evaluation(BTN, '72o', missOf(BTN, '72o'), { handNo: 6 }))] });
  const opened = await f.open([{ spotKey, handClass: '72o' }, { spotKey: BTN, handClass: '72o' }]);
  assert.deepEqual(opened.body.items.map((row) => [row.handClass, row.choices]), [['72o', ['fold', 'raise']], ['72o', ['fold', 'raise']]]);
  const answered = await f.answer(spotKey, '72o', 'fold');
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.reference, cell);
  assert.deepEqual(answered.body.review, { recorded: false, reason: 'NOT_IN_BANK' });
  assert.deepEqual((await f.answer(spotKey, '72o', 'call')).body, { code: 'BAD_COMMAND' });
});

test('the quiz answer route is the host\'s only: not before the game is over, not remote, not for participants', async (t) => {
  const f = await dueGame(t, BTN, '72o', { gameOver: false });
  const refused = await f.answer(BTN, '72o', 'fold');
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { code: 'GAME_NOT_OVER' });
  assert.equal(exposureRows(f.store).length, 0);
  f.setGameOver(true);
  const url = `${f.app.origin}/api/game/${GAME}/quiz-answer`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { headers: f.headers })).status, 405);
  assert.equal((await f.answer(BTN, '72o', 'fold', { 'x-game-epoch': 'old' })).status, 409);
  assert.equal(remoteRouteOf(`/api/game/${GAME}/quiz-answer`), 'not-found');
  const guestHeaders = { authorization: `Bearer ${f.guest.participantToken}`, 'x-game-epoch': EPOCH, 'content-type': 'application/json' };
  const body = JSON.stringify({ spotKey: BTN, handClass: '72o', action: 'fold' });
  assert.notEqual((await fetch(`${f.app.publicOrigin}/api/p/game/${GAME}/quiz-answer`, { method: 'POST', headers: guestHeaders, body })).status, 200);
  assert.notEqual((await fetch(`${f.app.publicOrigin}/api/game/${GAME}/quiz-answer`, { method: 'POST', headers: f.headers, body })).status, 200);
  assert.equal(exposureRows(f.store).length, 0);
  assert.equal((await f.answer(BTN, '72o', 'fold')).body.review.recorded, true, 'the host\'s own request is answered');
});

test('each write boundary that fails is finished by the next answer, never counted twice', async (t) => {
  const store = createOwnedTempDir('quiz-faults');
  const bank = createMistakeBank(store);
    for (const hand of ['72o', '82o', '32o', '42o']) await bank.collect(evaluation(BTN, hand, missOf(BTN, hand)));
  const answer = (handClass, faults) => drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey: BTN, handClass, action: 'fold', ...(faults ? { faults } : {}) });
  // The pending row is not written: nothing changes in the bank.
  const lost = await answer('72o', { failAt: 'journal-pending' });
  assert.deepEqual(lost?.review, { recorded: false, reason: 'REVIEW_UNCONFIRMED' });
  assert.equal((await bankItems(store))[0].attempts, 0);
  assert.equal(journal(store), null);
  // The bank write fails: the pending row stays and the next answer applies it.
  const bankFailed = await answer('82o', { failAt: 'bank' });
  assert.deepEqual(bankFailed?.review, { recorded: false, reason: 'REVIEW_UNCONFIRMED' });
  assert.equal(journal(store).rows[0].state, 'pending');
  assert.equal((await bankItems(store))[1].attempts, 0);
  // The applied mark fails after the bank write: the next answer only marks it.
  const markFailed = await answer('32o', { failAt: 'journal-applied' });
  assert.deepEqual(markFailed?.review, { recorded: false, reason: 'REVIEW_UNCONFIRMED' });
  // Every answer first finishes what an earlier one left: the bank write of 82o is applied now.
  assert.deepEqual((await bankItems(store)).map((row) => row.attempts), [0, 1, 1, 0]);
  assert.deepEqual(journal(store).rows.map((row) => [row.handClass, row.state]), [['82o', 'applied'], ['32o', 'pending']]);
  assert.equal((await answer('42o'))?.review?.recorded, true);
  assert.deepEqual(journal(store).rows.map((row) => [row.handClass, row.state]), [['82o', 'applied'], ['32o', 'applied'], ['42o', 'applied']]);
  assert.deepEqual((await bankItems(store)).map((row) => row.attempts), [0, 1, 1, 1]);
  assert.equal((await answer('32o'))?.review?.already, true);
  // The recent-view file cannot be written after the ledger row: no reference, no review.
  fs.rmSync(path.join(store, '.training', 'grid-exposures.json'));
  fs.mkdirSync(path.join(store, '.training', 'grid-exposures.json'));
  await assert.rejects(answer('72o'));
  assert.equal((await bankItems(store))[0].attempts, 0);
});

test('a review the drill made meanwhile ends a pending quiz row unconfirmed without a second write', { timeout: 120_000 }, async (t) => {
  const store = createOwnedTempDir('quiz-interleave');
  const { item } = await createMistakeBank(store).collect(evaluation(BTN, '72o', missOf(BTN, '72o')));
  const left = await drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey: BTN, handClass: '72o', action: 'fold', faults: { failAt: 'bank' } });
  assert.equal(left?.review?.reason, 'REVIEW_UNCONFIRMED');
  // The drill reviews the same item normally (mistake-review serves every item).
  const run = await startDrill(store, { mode: 'mistake-review', source: V3, seed: 'interleave' });
  assert.equal(run.queue[0].candidateMistakeId, item.mistakeId);
  const [action, size] = run.queue[0].prompt.legalActions[0].split(':');
  await answerQuestion(store, { sessionId: run.sessionId, questionId: run.queue[0].questionId, attemptNo: 0, action, ...(size ? { sizeBb: Number(size) } : {}) });
  const drilled = (await bankItems(store))[0].reviewState;
  assert.equal(drilled.attempts, 1);
  const next = await drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey: BTN, handClass: '72o', action: 'fold' });
  assert.equal(next?.review?.reason, 'REVIEW_UNCONFIRMED');
  assert.equal(journal(store).rows[0].state, 'unconfirmed');
  assert.deepEqual((await bankItems(store))[0].reviewState, drilled, 'the quiz did not write over the drill');
});

test('an inconsistent review log stops recording and is left as it is; a clock moved back does not', async (t) => {
  const store = createOwnedTempDir('quiz-journal');
  const bank = createMistakeBank(store);
  const { item } = await bank.collect(evaluation(BTN, '72o', missOf(BTN, '72o')));
  await bank.collect(evaluation(BTN, '82o', missOf(BTN, '82o')));
  const answer = (handClass, extra = {}) => drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey: BTN, handClass, action: 'fold', ...extra });
  assert.equal((await answer('72o'))?.review?.recorded, true);
  const good = fs.readFileSync(journalFile(store), 'utf8');
  const row = JSON.parse(good).rows[0];
  for (const [label, rows] of [
    ['duplicate key', [row, row]],
    ['changed transition', [{ ...row, patch: { ...row.patch, intervalDays: 99 } }]],
    ['foreign item', [{ ...row, state: 'pending', mistakeId: (await bankItems(store))[1].mistakeId }]],
    ['unknown state', [{ ...row, state: 'done' }]],
  ]) {
    const text = JSON.stringify({ schemaVersion: 1, rows });
    fs.writeFileSync(journalFile(store), text);
    const out = await answer('82o');
    assert.deepEqual(out?.review, { recorded: false, reason: 'REVIEW_LOG_INVALID' }, label);
    assert.ok(out?.reference, `${label}: the reference is still shown`);
    assert.equal(fs.readFileSync(journalFile(store), 'utf8'), text, `${label}: the log is left as it is`);
    assert.equal((await bankItems(store))[1].attempts, 0, label);
  }
  fs.writeFileSync(journalFile(store), '{broken');
  assert.equal((await answer('82o'))?.review?.reason, 'REVIEW_LOG_INVALID');
  // A row written "in the future" (the clock was later moved back) is a valid row; its key still counts.
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const patch = { lastReviewedAt: future, attempts: 1, ...nextSchedule({ grade: row.grade, intervalDays: 1, ease: 2.3, lapses: 0, now: Date.parse(future), srsVersion: 2, correctStreak: 0, graduatedAt: null }) };
  fs.writeFileSync(journalFile(store), JSON.stringify({ schemaVersion: 1, rows: [{ ...row, at: future, before: item.reviewState, patch }] }));
  assert.equal((await answer('72o'))?.review?.already, true);
  assert.equal((await answer('82o'))?.review?.recorded, true);
});

test('the review log keeps at most 500 rows by insertion order and never drops the current game or a pending row', async (t) => {
  const store = createOwnedTempDir('quiz-trim');
  const bank = createMistakeBank(store);
  const { item } = await bank.collect(evaluation(BTN, '72o', missOf(BTN, '72o')));
  await bank.collect(evaluation(BTN, '82o', missOf(BTN, '82o')));
  // 500 applied rows of other games, written with a clock that ran ahead.
  const future = new Date(Date.now() + 10 * DAY).toISOString();
  const patch = { lastReviewedAt: future, attempts: 1, ...nextSchedule({ grade: 'preferred', intervalDays: 1, ease: 2.3, lapses: 0, now: Date.parse(future), srsVersion: 2, correctStreak: 0, graduatedAt: null }) };
  const others = Array.from({ length: 500 }, (_, at) => ({ gameId: `00000000-0000-4000-9000-${String(at).padStart(12, '0')}`, spotKey: BTN, handClass: '72o',
    action: 'fold', grade: 'preferred', at: future, mistakeId: item.mistakeId, before: item.reviewState, patch, state: 'applied' }));
  fs.writeFileSync(journalFile(store), JSON.stringify({ schemaVersion: 1, rows: others }));
  const answer = (handClass) => drill.answerQuizQuestion?.(store, { gameId: GAME, spotKey: BTN, handClass, action: 'fold' });
  assert.deepEqual([(await answer('72o'))?.review?.recorded, (await answer('82o'))?.review?.already], [true, false]);
  const rows = journal(store).rows;
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.slice(-2).map((row) => [row.gameId, row.handClass]), [[GAME, '72o'], [GAME, '82o']]);
  assert.equal(rows[0].gameId, others[2].gameId, 'the two oldest rows of other games went first');
  // The first answer's item comes due again; the same game still counts it once.
  await bank.updateReviewState(item.mistakeId, { nextReviewAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await answer('72o'))?.review?.already, true);
  // Rows of the current game alone fill the limit: the answer is not recorded and nothing is written.
  const gradeOf = (cell) => { const max = Math.max(...Object.values(cell)); const f = cell.fold;
    return f === 0 ? 'off-policy' : f === max || f >= 0.5 ? 'preferred' : f >= 0.1 ? 'mixed' : 'low-frequency'; };
  const own = [];
  for (const spotKey of [BTN, CO, HJ, '6max-100bb-utg-rfi-v3']) {
    for (const handClass of HANDS) {
      if (own.length === 500 || (spotKey === BTN && ['72o', '82o', '92o'].includes(handClass))) continue;
      const cell = cellOf(spotKey, handClass);
      if (!cell) continue;
      const grade = gradeOf(cell);
      const before = { lastReviewedAt: null, nextReviewAt: future, intervalDays: 1, ease: 2.3, attempts: 0, correctStreak: 0, lapses: 0 };
      own.push({ gameId: GAME, spotKey, handClass, action: 'fold', grade, at: future, mistakeId: item.mistakeId, before, state: 'applied',
        patch: { lastReviewedAt: future, attempts: 1, ...nextSchedule({ grade, intervalDays: 1, ease: 2.3, lapses: 0, now: Date.parse(future), srsVersion: 2, correctStreak: 0, graduatedAt: null }) } });
    }
  }
  assert.equal(own.length, 500);
  const full = JSON.stringify({ schemaVersion: 1, rows: own });
  fs.writeFileSync(journalFile(store), full);
  await bank.collect(evaluation(BTN, '92o', missOf(BTN, '92o')));
  const before = bankBytes(store);
  const refused = await answer('92o');
  assert.deepEqual(refused?.review, { recorded: false, reason: 'REVIEW_UNCONFIRMED' });
  assert.equal(fs.readFileSync(journalFile(store), 'utf8'), full);
  assert.equal(bankBytes(store), before);
});

test('the action rule shared with the drill: every prompt the drill builds has the same actions as legalActionsFor', () => {
  assert.equal(typeof generator.legalActionsFor, 'function');
  let compared = 0;
  for (const source of KNOWN_REFERENCE_SOURCES) {
    const data = loadReferenceDataset(source);
    const identity = { id: data.data.id, version: data.data.version, contentSha256: data.contentSha256 };
    for (const spotKey of Object.keys(data.data.spots)) {
      let prompt;
      try {
        prompt = generateQueue({ mode: 'free', source: identity, spotKey, limit: 1,
          admits: data.data.schemaVersion === 3 ? (s, h) => lookup(data, { spotKey: s, handClass: h }).status === 'supported' : undefined })[0]?.prompt;
      } catch (error) { if (error.code === 'UNSUPPORTED_SPOT') continue; throw error; }
      if (!prompt) continue;
      assert.deepEqual(generator.legalActionsFor(spotKey), prompt.legalActions, spotKey);
      compared += 1;
    }
  }
  assert.ok(compared > 1000, `compared ${compared}`);
  assert.deepEqual(generator.legalActionsFor('9max-10bb-utg-push-v3'), ['fold', 'raise:10']);
  assert.deepEqual(generator.legalActionsFor('9max-10bb-bb-vs-utg-shove-v3'), ['fold', 'call']);
  assert.equal(generator.legalActionsFor('not-a-spot'), null);
});

test('the due rule of the study room is one function', () => {
  assert.equal(typeof generator.dueForReview, 'function');
  const now = '2026-11-16T00:00:00.000Z';
  assert.equal(generator.dueForReview({ nextReviewAt: '2026-11-15T23:59:59.000Z' }, now), true);
  assert.equal(generator.dueForReview({ nextReviewAt: '2026-11-16T00:00:01.000Z' }, now), false);
  assert.equal(generator.dueForReview({ nextReviewAt: '2026-11-01T00:00:00.000Z', graduatedAt: '2026-10-01T00:00:00.000Z', lastReviewedAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z' }, now), false);
  assert.equal(generator.dueForReview({ nextReviewAt: '2026-12-01T00:00:00.000Z', graduatedAt: '2026-10-01T00:00:00.000Z', lastReviewedAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-02T00:00:00.000Z' }, now), true);
});

// ── live relay ────────────────────────────────────────────────────────────────
// A relay whose host snapshot is `snapshot`; `hold` delays the end of the body until released.
async function snapshotRelay(snapshot, { hold = false, bytes = null } = {}) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const seen = { requests: [], closed: 0 };
  const server = http.createServer(async (req, res) => {
    seen.requests.push({ path: new URL(req.url, 'http://relay.invalid').pathname, seat: req.headers['x-seat'] });
    res.on('close', () => { if (!res.writableEnded) seen.closed += 1; });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (bytes) {
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let sent = 0; sent < bytes && !res.destroyed; sent += chunk.length) {
        if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      res.end();
      return;
    }
    const text = JSON.stringify(snapshot);
    res.write(text.slice(0, 10));
    if (hold) await released;
    res.end(text.slice(10));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerOwnedServer(server, 'quiz-relay');
  return { port: server.address().port, seen, release, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

async function relayGame(t, { relayTraining, diskTraining, hold = false, bytes = null }) {
  const relay = await snapshotRelay({ ok: true, training: relayTraining }, { hold, bytes });
  t.after(() => relay.close());
  const root = createOwnedTempDir('quiz-relay');
  const session = makeSession(root, relay.port, { sessionToken: TOKEN });
  const loop = makeLoop(session);
  const f = await fixture(t, { training: diskTraining, session: { sessionDir: session.sessionDir, gameEpoch: session.gameEpoch, loop } });
  return { ...f, relay, loop, session };
}

test('with a live relay the questions are the relay\'s host snapshot, not the file on disk', async (t) => {
  const onRelay = evaluation(BTN, '72o', missOf(BTN, '72o'), { handNo: 1 });
  const onDisk = evaluation(CO, '72o', missOf(CO, '72o'), { handNo: 2 });
  const f = await relayGame(t, { relayTraining: [trainingRow(onRelay)], diskTraining: [trainingRow(onDisk)] });
  const opened = await f.open([{ spotKey: BTN, handClass: '72o' }, { spotKey: CO, handClass: '72o' }]);
  assert.deepEqual(opened.body.items.map((row) => row.spotKey), [BTN]);
  assert.deepEqual(f.relay.seen.requests.map((row) => [row.path, row.seat]), [['/api/snapshot', 'user']]);
  assert.equal((await f.answer(CO, '72o', 'fold')).body.code, 'QUIZ_NOT_ISSUED');
  assert.equal((await f.answer(BTN, '72o', 'fold')).status, 200);
  // A relay the capability no longer proves is not read at all.
  f.loop.state.binding = null;
  const denied = await f.answer(BTN, '72o', 'fold');
  assert.equal(denied.status, 503);
  assert.deepEqual(denied.body, { code: 'RELAY_UNAVAILABLE' });
});

test('a relay binding lost while its snapshot is read, or an oversized snapshot, issues nothing and writes nothing', { timeout: 60_000 }, async (t) => {
  const row = evaluation(BTN, '72o', missOf(BTN, '72o'), { handNo: 1 });
  const held = await relayGame(t, { relayTraining: [trainingRow(row)], diskTraining: [], hold: true });
  await createMistakeBank(held.store).collect(row);
  const pending = held.answer(BTN, '72o', 'fold');
  for (let at = 0; at < 200 && !held.relay.seen.requests.length; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  held.loop.state.stopping = true;                          // the relay is being stopped mid-read
  held.relay.release();
  const out = await pending;
  assert.equal(out.status, 503);
  assert.deepEqual(out.body, { code: 'RELAY_UNAVAILABLE' });
  assert.equal(exposureRows(held.store).length, 0);
  assert.equal(journal(held.store), null);
  assert.equal((await bankItems(held.store))[0].attempts, 0);
  // The session object itself is replaced mid-read (same game and epoch).
  const swapped = await relayGame(t, { relayTraining: [trainingRow(row)], diskTraining: [], hold: true });
  const swap = swapped.answer(BTN, '72o', 'fold');
  for (let at = 0; at < 200 && !swapped.relay.seen.requests.length; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  swapped.manager.session = { loop: swapped.loop };
  swapped.relay.release();
  assert.deepEqual((await swap).body, { code: 'RELAY_UNAVAILABLE' });
  assert.equal(exposureRows(swapped.store).length, 0);
  // The requester goes away mid-read: the upstream read is abandoned and nothing is written.
  const gone = await relayGame(t, { relayTraining: [trainingRow(row)], diskTraining: [], hold: true });
  const controller = new AbortController();
  const abandoned = fetch(`${gone.app.origin}/api/game/${GAME}/quiz-answer`, { method: 'POST', headers: gone.headers, signal: controller.signal,
    body: JSON.stringify({ spotKey: BTN, handClass: '72o', action: 'fold' }) }).catch(() => null);
  for (let at = 0; at < 200 && !gone.relay.seen.requests.length; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await abandoned;
  for (let at = 0; at < 200 && !gone.relay.seen.closed; at += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gone.relay.seen.closed, 1, 'the relay request was abandoned before its end');
  gone.relay.release();
  assert.equal(exposureRows(gone.store).length, 0);
  // A snapshot over 64 MiB is refused.
  const big = await relayGame(t, { relayTraining: [], diskTraining: [], bytes: 65 * 1024 * 1024 });
  assert.deepEqual((await big.answer(BTN, '72o', 'fold')).body, { code: 'RELAY_UNAVAILABLE' });
});

// ── the sealed evaluator sees the answer-time view ───────────────────────────
// A small copy of the learning-effect pipeline scenario (test/learning-effect-pipeline.test.js):
// real v3 assessment answers re-dated into a sealed schedule. The quiz answer's own exposure row,
// re-dated into the same schedule, is what the evaluator reads as a chart view.
async function assessmentRuns(store, count) {
  const runs = [];
  for (let at = 0; at < count; at += 1) {
    const started = await startDrill(store, { mode: 'assessment', source: V3, seed: `quiz-effect-${at}` });
    for (;;) {
      const next = await nextQuestion(store);
      if (next.done || !next.question) break;
      const cell = cellOf(next.question.prompt.spotKey, next.question.prompt.handClass);
      const legal = next.question.prompt.legalActions;
      const pick = legal.map((entry) => entry.split(':')).sort((a, b) => cell[b[0]] - cell[a[0]])[at % 2 ? legal.length - 1 : 0];
      await answerQuestion(store, { sessionId: started.sessionId, questionId: next.question.questionId, attemptNo: next.index,
        action: pick[0], ...(pick[1] ? { sizeBb: Number(pick[1]) } : {}) });
    }
  }
  const byRun = new Map();
  for (const event of await createProfileStore(store).readEventSnapshot()) {
    if (!byRun.has(event.studyRun.id)) byRun.set(event.studyRun.id, []);
    byRun.get(event.studyRun.id).push(event);
  }
  return [...byRun.values()].map((run) => run.sort((a, b) => a.studyRun.index - b.studyRun.index));
}

test('the answer-time view is a chart exposure for the sealed evaluator: M2 sees it between, M1 sees it before', { timeout: 300_000 }, async () => {
  const C = Date.parse('2026-10-01T00:00:00.000Z');
  const H = 3_600_000;
  const at = (ms) => new Date(C + ms).toISOString();
  const pool = await assessmentRuns(createOwnedTempDir('quiz-effect-pool'), 4);
  assert.equal(pool.length, 4);
  const relabel = (event, { runId, mode, total, index, startedAt, assessmentId = null, appliedAt }) => {
    const id = randomBytes(32).toString('hex');
    const [, decision, provider] = event.evaluationId.split(':');
    return { ...structuredClone(event), evaluationId: `${id}:${decision}:${provider}`, payloadSha256: id, appliedAt,
      studyRun: { id: runId, mode, total, index, startedAt, ...(assessmentId ? { assessmentId } : {}) } };
  };
  const place = (events, { mode = 'assessment', startMs, assessmentId = null }) => {
    const runId = randomUUID();
    const startedAt = at(startMs);
    return { runId, events: events.map((event, index) => relabel(event, { runId, mode, total: events.length, index, startedAt, assessmentId,
      appliedAt: at(startMs + (index + 1) * 60_000) })),
    row: { type: 'start', startId: randomUUID(), runId, mode, total: events.length, startedAt, sourceIdentity: V3, ...(assessmentId ? { assessmentId } : {}) } };
  };
  const ledger = (kind, rows, coverageFrom) => ({ status: 'ok', ledger: { schemaVersion: 1, kind, createdAt: coverageFrom, coverageFrom, rows,
    dropped: 0, droppedThrough: null, resets: [] } });
  const baseline = [place(pool[0], { startMs: H }), place(pool[1], { startMs: 2 * H })];
  const post = [place(pool[2], { startMs: 8 * DAY }), place(pool[3], { startMs: 8 * DAY + H })];
  const retests = baseline.map((run, i) => place(pool[i], { mode: 'retest', startMs: 9 * DAY + i * H, assessmentId: run.runId }));
  const runs = [...baseline, ...post, ...retests];
  const sealed = sealPlan({ baselineRuns: 2 }, at(0));
  const enrollment = { id: randomUUID(), protocolId: LEARNING_EFFECT_PROTOCOL_V1.id, protocolSha256: PROTOCOL_SHA256, source: V3, consentedAt: at(0),
    plan: sealed.plan, planSha256: sealed.planSha256, postOpensAt: sealed.postOpensAt, postClosesAt: sealed.postClosesAt, withdrawnAt: null };
  const chartOf = (spotKey) => dataset.data.spots[spotKey] ?? null;
  const evaluate = (exposureRows) => evaluateLearningEffect({ events: runs.flatMap((run) => run.events), enrollment, now: at(15 * DAY), chartOf,
    runLog: ledger('run', runs.map((run) => run.row), at(0)), exposureLog: ledger('exposure', exposureRows, at(-7 * DAY)) });

  // A real quiz answer on the chart of a baseline item; its ledger row is re-dated between the baseline answer and its retest.
  const quizView = async (spotKey, handClass) => {
    const store = createOwnedTempDir('quiz-effect-view');
    const action = classes(generator.legalActionsFor(spotKey)).find((entry) => cellOf(spotKey, handClass)[entry] >= 0);
    const out = await drill.answerQuizQuestion(store, { gameId: GAME, spotKey, handClass, action });
    assert.equal(out.ok, true);
    const [row] = exposureRows(store);
    assert.deepEqual([row.spotKey, row.sourceIdentity], [spotKey, V3]);
    return row;
  };
  const item = baseline[0].events[0].mixObservation;
  const clean = evaluate([]);
  assert.equal(clean.m2.excluded.REHEARSED ?? 0, 0);
  const between = evaluate([{ ...(await quizView(item.spotKey, item.handClass)), at: at(5 * DAY) }]);
  assert.ok(between.m2.excluded.REHEARSED >= 1, 'the quiz answer between the baseline answer and the retest is a rehearsal');
  // Before a post item, on a spot key that shares its chart: that item is no longer clean.
  const target = post[0].events.map((event) => event.mixObservation).find((observation) => Object.keys(dataset.data.spots)
    .some((other) => other !== observation.spotKey && chartOf(other) === chartOf(observation.spotKey) && cellOf(other, observation.handClass)));
  assert.ok(target, 'a post item whose chart another spot key shares');
  const partner = Object.keys(dataset.data.spots).find((other) => other !== target.spotKey && chartOf(other) === chartOf(target.spotKey)
    && cellOf(other, target.handClass));
  const before = evaluate([{ ...(await quizView(partner, target.handClass)), at: at(3 * DAY) }]);
  assert.ok(before.items.post.excluded.KNOWN_EXPOSURE_CHART > (clean.items.post.excluded.KNOWN_EXPOSURE_CHART ?? 0));
});

