import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { createMiniDocument } from './helpers/mini-dom.js';
import { remoteRouteOf, startAppServer } from '../tools/app-server.js';
import { startDrill } from '../tools/drill-cli.js';
import { loadReferenceDataset } from '../tools/preflop-dataset.js';
import { createRoomManager } from '../tools/room-manager.js';
import { V3_REFERENCE_SOURCE } from '../shared/reference.js';
import { lookup } from '../training/providers/preflop-json.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { nativePreflopSnapshotV3 } from '../training/native-preflop-snapshot-v3.js';
import { toPublicSummary } from '../training/public-view.js';
import { paintQuiz, quizCandidates, quizQuestions } from '../server/public/review-quiz.js';
import { bigDecision } from '../server/public/table-controls.js';

const gameId = '00000000-0000-4000-8000-000000000041';
const epoch = 'ab'.repeat(32);
const SPOT = '6max-100bb-btn-vs-utg-open-v3';
const RFI = '6max-100bb-co-rfi-v3';

// The game's compared host decisions, as the table's training list (relay restore rules apply).
const dataset = loadReferenceDataset(V3_REFERENCE_SOURCE);
let epochs = 0;
function decision(spotKey, handClass, chosen, handNo) {
  epochs += 1;
  const gameEpoch = epochs.toString(16).padStart(2, '0').repeat(32);
  return toPublicSummary({ ...evaluatePreflopReferenceV3(nativePreflopSnapshotV3(spotKey, handClass, chosen), dataset, { gameEpoch }), payloadSha256: gameEpoch }, { handNo });
}
const TRAINING = [decision(SPOT, 'KTo', { action: 'call' }, 2), decision(RFI, '64o', { action: 'raise', sizeBb: 2.5 }, 3), decision(SPOT, 'AA', { action: 'raise', sizeBb: 8.5 }, 4)];

async function fixture(t, over = {}) {
  const root = createOwnedTempDir('quiz-route');
  const room = createRoomManager({ storeDir: root });
  room.open({ totalSeats: 3 });
  const guest = room.join({ code: room.load().joinCode, name: 'Guest', addr: '1' });
  // The route answers only for a game that is over (its committed engine state says so).
  let writes = 0;
  const writeState = (gameOver, dir = root) => {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ gameOver, sessionToken: 'b'.repeat(64), revision: writes += 1 }));
    fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({ training: TRAINING }));
  };
  writeState(over.gameOver ?? true);
  let checks = 0;
  const manager = { room, current: { gameId, sessionDir: root },
    snapshot: () => { checks += 1; return { gameId, gameEpoch: over.staleFrom && checks >= over.staleFrom ? 'cd'.repeat(32) : epoch, state: 'ended' }; } };
  const app = await startAppServer({ manager, token: 'host', storeDir: root, publicPort: 0 });
  t.after(() => app.close());
  const headers = { authorization: 'Bearer host', 'x-game-epoch': epoch, 'content-type': 'application/json', connection: 'close' };
  const post = (body, over = {}) => fetch(`${app.origin}/api/game/${gameId}/quiz`, { method: 'POST', headers: { ...headers, ...over }, body: JSON.stringify(body) });
  const ledger = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, '.training', 'grid-exposure-log.json'), 'utf8')).rows.map((row) => row.spotKey); } catch { return []; }
  };
  return { app, root, guest, headers, post, ledger, writeState, manager, resetChecks: () => { checks = 0; } };
}
const items = [{ spotKey: SPOT, handClass: 'KTo' }, { spotKey: RFI, handClass: '64o' }, { spotKey: SPOT, handClass: 'AA' }];

test('the quiz route is the host\'s, bound to the current game and epoch, and strict about its body', async (t) => {
  const f = await fixture(t);
  const url = `${f.app.origin}/api/game/${gameId}/quiz`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { headers: f.headers })).status, 405);
  assert.equal((await f.post({ items }, { 'x-game-epoch': 'old' })).status, 409);
  for (const body of [{}, { items: [] }, { items: 'x' }, { items, extra: 1 }, { items: [{ spotKey: SPOT }] },
    { items: [{ spotKey: '../x', handClass: 'AA' }] }, { items: [{ spotKey: SPOT, handClass: 'AKx' }] },
    { items: [{ spotKey: SPOT, handClass: 'AA', more: 1 }] }, { items: Array(6).fill(items[0]) }]) {
    assert.equal((await f.post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(f.ledger(), [], 'nothing was recorded by a refused request');
  // No participant route, and not reachable by the remote host.
  const guestHeaders = { authorization: `Bearer ${f.guest.participantToken}`, 'x-game-epoch': epoch, 'content-type': 'application/json' };
  assert.notEqual((await fetch(`${f.app.publicOrigin}/api/p/game/${gameId}/quiz`, { method: 'POST', headers: guestHeaders, body: JSON.stringify({ items }) })).status, 200);
  assert.notEqual((await fetch(`${f.app.publicOrigin}/api/game/${gameId}/quiz`, { method: 'POST', headers: f.headers, body: JSON.stringify({ items }) })).status, 200);
  assert.equal(remoteRouteOf(`/api/game/${gameId}/quiz`), 'not-found');
});

test('opening serves the game\'s own asked pairs with their choices, and neither a reference nor a chart view', async (t) => {
  const f = await fixture(t);
  const response = await f.post({ items: [...items, { spotKey: 'no-such-spot-v3', handClass: 'AA' }, { spotKey: RFI, handClass: 'AA' }] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, items: [
    { spotKey: SPOT, handClass: 'KTo', choices: ['fold', 'call', 'raise'] },
    { spotKey: RFI, handClass: '64o', choices: ['fold', 'raise'] },
    { spotKey: SPOT, handClass: 'AA', choices: ['fold', 'call', 'raise'] },
  ] }, 'pairs the game did not ask are left out');
  for (const item of items) assert.equal(lookup(dataset, item).status, 'supported');
  assert.deepEqual(f.ledger(), [], 'the reference is shown only by an answer, which records the view then');
});

test('a game still being played gets no answers, and a game replaced mid-request gets none either', async (t) => {
  const playing = await fixture(t, { gameOver: false });
  const refused = await playing.post({ items });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { code: 'GAME_NOT_OVER' });
  assert.deepEqual(playing.ledger(), []);
  playing.writeState(true);
  assert.equal((await playing.post({ items })).status, 200, 'once the game is over the same request is answered');
  // The epoch changes while the body is read (second identity check): nothing is recorded.
  const replacedEarly = await fixture(t, { staleFrom: 2 });
  replacedEarly.resetChecks();
  const early = await replacedEarly.post({ items });
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), { code: 'STALE_GAME' });
  assert.deepEqual(replacedEarly.ledger(), []);
  // ... or after the questions were prepared (third check): nothing is sent, and opening writes nothing.
  const replacedLate = await fixture(t, { staleFrom: 3 });
  replacedLate.resetChecks();
  const late = await replacedLate.post({ items });
  assert.equal(late.status, 409);
  assert.deepEqual(await late.json(), { code: 'STALE_GAME' });
  assert.deepEqual(replacedLate.ledger(), []);
});

test('the committed state the route reads is the current session\'s, also after the session changed', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ items })).status, 200, 'the first game is over');
  // The app moves on to another session directory whose game is still being played.
  const next = createOwnedTempDir('quiz-route-next');
  f.writeState(false, next);
  f.manager.current = { gameId, sessionDir: next };
  const refused = await f.post({ items });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { code: 'GAME_NOT_OVER' }, 'the cached state of the old session is not reused');
  f.writeState(true, next);
  assert.equal((await f.post({ items })).status, 200);
  // A session without a readable state file gets no answers.
  f.manager.current = { gameId, sessionDir: createOwnedTempDir('quiz-route-empty') };
  assert.equal((await f.post({ items })).status, 409);
});

test('while an assessment is open no question is served and nothing is recorded', async (t) => {
  const f = await fixture(t);
  await startDrill(f.root, { mode: 'assessment', idempotencyKey: 'quiz-lock' });
  const response = await f.post({ items });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: 'GRID_LOCKED' });
  assert.deepEqual(f.ledger(), []);
});

test('the quiz is drawn one question at a time, shows a reference only from the server\'s answer and keeps its place across a repaint', async () => {
  const doc = createMiniDocument();
  const box = doc.createElement('div');
  const candidates = quizCandidates([
    { status: 'supported', handNo: 2, spotKey: SPOT, handClass: 'KTo', chosen: { action: 'call' }, grade: 'off-policy' },
    { status: 'supported', handNo: 5, spotKey: RFI, handClass: '64o', chosen: { action: 'fold' }, grade: 'preferred' },
  ], { titleOf: (item) => `핸드 ${item.handNo}` });
  const questions = quizQuestions(candidates, { items: [
    { spotKey: SPOT, handClass: 'KTo', choices: ['fold', 'call', 'raise'] },
    { spotKey: RFI, handClass: '64o', choices: ['fold', 'raise'] }] });
  const sent = [];
  let settle;
  const submit = (question, action) => { sent.push([question.spotKey, question.handClass, action]); return new Promise((resolve) => { settle = resolve; }); };
  const refused = [];
  const { state } = paintQuiz(box, questions, { doc, submit, onRefused: (code) => refused.push(code) });
  const buttons = () => [...box.querySelectorAll('button.quiz-choice')];
  assert.deepEqual(buttons().map((button) => button.textContent), ['폴드', '콜', '레이즈']);
  assert.equal(box.querySelector('.quiz-feedback'), null, 'no reference before an answer');
  // A refusal (an assessment opened meanwhile): no reference, no stored answer, the question can be answered again.
  buttons()[1].click();
  assert.ok(buttons().every((button) => button.disabled), 'locked while the answer is sent');
  buttons()[2].click();
  assert.equal(sent.length, 1, 'one answer in flight at a time');
  // The table repaints its quiz into the same element while the answer is in flight (app.js paintFinalQuiz).
  paintQuiz(box, questions, { doc, state, submit, onRefused: (code) => refused.push(code) });
  assert.ok(buttons().every((button) => button.disabled), 'a repaint keeps it locked');
  buttons()[0].click();
  assert.equal(sent.length, 1, 'still one answer in flight after the repaint');
  settle({ ok: false, code: 'GRID_LOCKED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(box.querySelector('.quiz-feedback'), null);
  assert.doesNotMatch(box.textContent, /기준표 참고|기준표도 하는|기준표와 다른/);
  assert.match(box.querySelector('.quiz-notice').textContent, /평가·재평가·일반화 연습이 진행 중/);
  assert.deepEqual(refused, ['GRID_LOCKED']);
  assert.equal(state.answers[0], undefined);
  assert.ok(buttons().every((button) => !button.disabled));
  // The server's answer: the reference and the record line it sent.
  buttons()[1].click();
  settle({ ok: true, body: { ok: true, reference: { fold: 1, call: 0, raise: 0 }, review: { recorded: true, already: false, intervalDays: 3, nextReviewAt: '2026-11-19T00:00:00.000Z', graduated: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(box.querySelector('.quiz-feedback').textContent, /기준표와 다른 선택입니다\.기준표 참고: 폴드 100%게임에서 내 선택: 콜 \(지금과 같음\)/);
  assert.match(box.querySelector('.quiz-record').textContent, /오답 은행 복습으로 기록했습니다 · 다음 복습 3일 뒤/);
  assert.ok(buttons().every((button) => button.disabled), 'one answer per question');
  // The surrounding screen repaints: the same state draws the same place.
  const again = doc.createElement('div');
  paintQuiz(again, questions, { doc, state, submit });
  assert.match(again.textContent, /1 \/ 2/);
  assert.ok(again.querySelector('.quiz-feedback'));
  again.querySelector('button.quiz-next').click();
  assert.match(again.textContent, /2 \/ 2/);
  assert.deepEqual([...again.querySelectorAll('button.quiz-choice')].map((button) => button.textContent), ['폴드', '레이즈']);
  again.querySelectorAll('button.quiz-choice')[0].click();
  settle({ ok: true, body: { ok: true, reference: { fold: 0.85, call: 0, raise: 0.15 }, review: { recorded: false, reason: 'NOT_IN_BANK' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(again.querySelector('.quiz-record'), null, 'a pair outside the bank gets no record line');
  again.querySelector('button.quiz-next').click();
  assert.match(again.textContent, /복습 2문제를 마쳤습니다\. 기준표도 하는 선택 1개\. 오답 은행 복습 1개를 기록했습니다\./);
  assert.deepEqual(state.answers, ['call', 'fold']);
  assert.equal(state.at, 2);
});

test('a big decision is a large call or pot after the flop, or a large call before it', () => {
  const view = (board) => ({ blinds: [50, 100], board });
  assert.equal(bigDecision(view(['As', 'Kd', '2c']), { callAmount: 500, potTotal: 600 }), true);
  assert.equal(bigDecision(view(['As', 'Kd', '2c']), { callAmount: 0, potTotal: 1000 }), true);
  assert.equal(bigDecision(view(['As', 'Kd', '2c']), { callAmount: 400, potTotal: 900 }), false);
  assert.equal(bigDecision(view([]), { callAmount: 1000, potTotal: 1150 }), true);
  assert.equal(bigDecision(view([]), { callAmount: 250, potTotal: 5000 }), false);
  assert.equal(bigDecision(view([]), null), false);
  assert.equal(bigDecision({ board: [] }, { callAmount: 9999 }), false);
});

test('the table has the quiz section, the review link and the memo nudge wired for the host only', () => {
  const html = fs.readFileSync(new URL('../server/public/index.html', import.meta.url), 'utf8');
  for (const id of ['final-quiz', 'final-quiz-status', 'final-quiz-start', 'final-quiz-body', 'final-study-review']) {
    assert.equal(html.split(`id="${id}"`).length, 2, id);
  }
  assert.match(html, /<section id="final-quiz"[^>]* hidden>/);
  const script = fs.readFileSync(new URL('../server/public/app.js', import.meta.url), 'utf8');
  assert.match(script, /const allowed=!hidden&&Boolean\(appGameId\)&&!remoteHostTable&&!terminalRecord;/);
  assert.match(script, /paintFinalQuiz\(participantMode\|\|spectator\);/);
  // Answers go to the server; a refusal that only reopening can fix sends the quiz back to its open button.
  assert.match(script, /submit:submitQuizAnswer,onRefused:quizRefused/);
  assert.match(script, /appFetch\('quiz-answer',/);
  assert.match(script, /if\(!quizNeedsReopen\(code\)\|\|quiz\.phase!=='open'\)return;\n  Object\.assign\(quiz,\{phase:'error',error:quizAnswerErrorText\(code\),questions:\[\],state:null\}\);\n  paintFinalQuiz\(false\);/);
  assert.match(script, /studyLink\(authenticatedStudyUrl,\{mode:'daily'\}\)/);
  assert.match(script, /toggle\.classList\.toggle\('is-nudge', big\);/);
});
