import test from 'node:test';
import assert from 'node:assert/strict';
import * as quiz from '../server/public/review-quiz.js';
import { QUIZ_LIMIT, QUIZ_NOTE, quizCandidates, quizErrorText, quizFeedback, quizQuestions, quizRequest } from '../server/public/review-quiz.js';
import { coachingClaimAllowed } from '../shared/reference.js';

const item = (over = {}) => ({ evaluationId: 'e', handNo: 3, status: 'supported', street: 'preflop', forced: false,
  spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', chosen: { action: 'call' }, grade: 'off-policy', ...over });

test('candidates are the game\'s own compared preflop spots, the ones that differed first', () => {
  const rows = quizCandidates([
    item({ handNo: 9, handClass: 'AA', grade: 'preferred', chosen: { action: 'raise' } }),
    item({ handNo: 7, handClass: '64o', grade: 'low-frequency', spotKey: '6max-100bb-co-rfi-v3', chosen: { action: 'raise' } }),
    item({ handNo: 5 }),
    item({ handNo: 2, handClass: 'QJs', grade: null, chosen: { action: 'fold' } }),
    item({ handNo: 6 }),                                  // the same spot and hand again
    item({ handNo: 1, status: 'unsupported' }),
    item({ handNo: 1, forced: true }),
    item({ handNo: 1, street: 'flop' }),
    item({ handNo: 1, spotKey: '../etc' }),
    item({ handNo: 1, handClass: 'AKx' }),
    item({ handNo: 1, chosen: { action: 'check' } }),
    null,
  ], { titleOf: (row) => `핸드 ${row.handNo}` });
  assert.deepEqual(rows.map((row) => [row.handNo, row.handClass, row.chosen]),
    [[5, 'KTo', 'call'], [7, '64o', 'raise'], [2, 'QJs', 'fold'], [9, 'AA', 'raise']]);
  assert.equal(rows[0].title, '핸드 5');
  assert.equal(rows[0].key, '6max-100bb-btn-vs-utg-open-v3:KTo');
  assert.equal(Object.hasOwn(rows[0], 'order'), false);
  // The same spot and hand played well first and badly later: the later one is the question.
  const repeated = quizCandidates([
    item({ handNo: 1, grade: 'preferred', chosen: { action: 'fold' } }),
    item({ handNo: 8, grade: 'off-policy', chosen: { action: 'call' } }),
  ]);
  assert.deepEqual(repeated.map((row) => [row.handNo, row.chosen]), [[8, 'call']]);
  const many = Array.from({ length: 9 }, (_, at) => item({ handNo: at + 1, handClass: `A${'23456789T'[at]}o` }));
  assert.equal(quizCandidates(many).length, QUIZ_LIMIT);
  assert.deepEqual(quizCandidates('x'), []);
  assert.deepEqual(quizRequest(rows.slice(0, 2)), { items: [
    { spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo' }, { spotKey: '6max-100bb-co-rfi-v3', handClass: '64o' }] });
});

test('questions exist only for what the server served, with the choices it sent and no reference', () => {
  const candidates = quizCandidates([
    item(),
    item({ handNo: 4, spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', chosen: { action: 'raise' } }),
    item({ handNo: 5, spotKey: '6max-10bb-btn-push-v3', handClass: 'K7s', chosen: { action: 'raise' } }),
    item({ handNo: 6, spotKey: '2max-10bb-bb-vs-sb-shove-v3', handClass: 'Q9o', chosen: { action: 'fold' } }),
    item({ handNo: 7, spotKey: '6max-100bb-co-rfi-unopened', handClass: 'AJo', chosen: { action: 'raise' } }),
    item({ handNo: 8, handClass: 'T9s' }),
  ], { limit: 6 });
  assert.equal(candidates.length, 6);
  assert.ok(candidates.some((row) => row.handClass === 'T9s'), 'T9s is a candidate the server does not serve');
  const questions = quizQuestions(candidates, { ok: true, items: [
    { spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', choices: ['fold', 'call', 'raise'] },
    { spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', choices: ['fold', 'raise'] },
    { spotKey: '6max-10bb-btn-push-v3', handClass: 'K7s', choices: ['fold', 'raise'] },
    { spotKey: '2max-10bb-bb-vs-sb-shove-v3', handClass: 'Q9o', choices: ['fold', 'call'] },
    { spotKey: '6max-100bb-co-rfi-unopened', handClass: 'AJo', choices: ['fold', 'raise'] },
    { spotKey: 'somewhere-else-v3', handClass: 'AA', choices: ['fold'] },
    { spotKey: 7 },
  ] });
  assert.deepEqual(questions.map((question) => question.handClass), ['KTo', '64o', 'K7s', 'Q9o', 'AJo'], 'T9s was not served');
  assert.deepEqual(questions[0].choices.map((choice) => choice.label), ['폴드', '콜', '레이즈']);
  assert.deepEqual(questions[1].choices.map((choice) => choice.label), ['폴드', '레이즈']);
  assert.deepEqual(questions[2].choices.map((choice) => choice.label), ['폴드', '올인']);
  assert.deepEqual(questions[3].choices.map((choice) => choice.label), ['폴드', '콜']);
  assert.deepEqual(questions[4].choices.map((choice) => choice.label), ['폴드', '레이즈'], 'a v1 open offers no call');
  assert.equal(questions[0].spotKey, '6max-100bb-btn-vs-utg-open-v3');
  assert.equal(Object.hasOwn(questions[0], 'reference'), false, 'the reference arrives only with an answer');
  assert.deepEqual(quizQuestions(candidates, null), []);
  for (const choices of [undefined, [], ['fold', 'check'], ['fold', 'fold'], 'fold']) {
    assert.deepEqual(quizQuestions(candidates, { items: [{ spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', choices }] }), [], JSON.stringify(choices));
  }
});

test('feedback states the server\'s reference, what was played and whether they meet', () => {
  const [question] = quizQuestions(quizCandidates([item({ spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', chosen: { action: 'raise' } })]),
    { items: [{ spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', choices: ['fold', 'raise'] }] });
  const reference = { fold: 0.85, call: 0, raise: 0.15 };
  assert.deepEqual(quizFeedback(question, 'fold', reference), { agrees: true, verdict: '기준표도 하는 선택입니다.',
    reference: '기준표 참고: 폴드 85% · 레이즈 15%', played: '게임에서 내 선택: 레이즈' });
  assert.deepEqual(quizFeedback(question, 'raise', reference), { agrees: true, verdict: '기준표도 하는 선택입니다.',
    reference: '기준표 참고: 폴드 85% · 레이즈 15%', played: '게임에서 내 선택: 레이즈 (지금과 같음)' });
  const [other] = quizQuestions(quizCandidates([item()]), { items: [{ spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', choices: ['fold', 'call', 'raise'] }] });
  const feedback = quizFeedback(other, 'call', { fold: 1, call: 0, raise: 0 });
  assert.equal(feedback.agrees, false);
  assert.equal(feedback.verdict, '기준표와 다른 선택입니다.');
  const lines = [QUIZ_NOTE, ...Object.values(feedback).filter((value) => typeof value === 'string'),
    quizErrorText('GRID_LOCKED'), quizErrorText('STUDY_BUSY'), quizErrorText('x')];
  for (const code of ['GRID_LOCKED', 'STUDY_BUSY', 'QUIZ_NOT_ISSUED', 'STALE_GAME', 'GAME_NOT_OVER', 'RELAY_UNAVAILABLE', 'BAD_COMMAND', undefined]) {
    lines.push(quiz.quizAnswerErrorText?.(code));
  }
  for (const review of [{ recorded: true, already: false, intervalDays: 3 }, { recorded: true, already: false, intervalDays: 21, graduated: true },
    { recorded: true, already: true, intervalDays: 3 }, { recorded: false, reason: 'NOT_DUE' }, { recorded: false, reason: 'SOURCE_NOT_TRACKED' },
    { recorded: false, reason: 'REVIEW_UNCONFIRMED' }, { recorded: false, reason: 'REVIEW_LOG_INVALID' }]) {
    lines.push(quiz.quizRecordText?.(review));
  }
  for (const line of lines) {
    assert.equal(typeof line, 'string');
    assert.equal(coachingClaimAllowed(line), true, line);
  }
});

test('the record line says what moved, and nothing for a pair outside the bank', () => {
  assert.equal(quiz.quizRecordText?.({ recorded: true, already: false, intervalDays: 3, graduated: false }), '오답 은행 복습으로 기록했습니다 · 다음 복습 3일 뒤');
  assert.equal(quiz.quizRecordText?.({ recorded: true, already: false, intervalDays: 21, graduated: true }), '오답 은행 복습으로 기록했습니다 · 이 항목은 복습 목록에서 졸업했습니다');
  assert.equal(quiz.quizRecordText?.({ recorded: true, already: true, intervalDays: 3 }), '이 게임에서 이미 오답 은행 복습으로 기록한 자리입니다.');
  assert.equal(quiz.quizRecordText?.({ recorded: false, reason: 'NOT_IN_BANK' }), '');
  assert.equal(quiz.quizRecordText?.(null), '');
  assert.match(QUIZ_NOTE, /점수로 저장하지 않습니다/);
  assert.match(QUIZ_NOTE, /답하면 그 자리의 기준표를 본 것으로 학습 기록에 남고/);
  assert.match(QUIZ_NOTE, /복습 시각이 된 오답 은행 항목이면 복습 일정이 움직입니다/);
  assert.equal(quiz.quizNeedsReopen?.('QUIZ_NOT_ISSUED'), true);
  assert.equal(quiz.quizNeedsReopen?.('GRID_LOCKED'), false);
});
