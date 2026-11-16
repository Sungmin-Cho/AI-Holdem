import test from 'node:test';
import assert from 'node:assert/strict';
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
  const many = Array.from({ length: 9 }, (_, at) => item({ handNo: at + 1, handClass: `A${'23456789T'[at]}o` }));
  assert.equal(quizCandidates(many).length, QUIZ_LIMIT);
  assert.deepEqual(quizCandidates('x'), []);
  assert.deepEqual(quizRequest(rows.slice(0, 2)), { items: [
    { spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo' }, { spotKey: '6max-100bb-co-rfi-v3', handClass: '64o' }] });
});

test('questions exist only for what the server answered, with the choices of the spot', () => {
  const candidates = quizCandidates([
    item(),
    item({ handNo: 4, spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', chosen: { action: 'raise' } }),
    item({ handNo: 5, spotKey: '6max-10bb-btn-push-v3', handClass: 'K7s', chosen: { action: 'raise' } }),
    item({ handNo: 6, spotKey: '2max-10bb-bb-vs-sb-shove-v3', handClass: 'Q9o', chosen: { action: 'fold' } }),
    item({ handNo: 8, handClass: 'T9s' }),
  ]);
  const questions = quizQuestions(candidates, { ok: true, items: [
    { spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', actions: { fold: 1, call: 0, raise: 0 } },
    { spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', actions: { fold: 0.85, call: 0, raise: 0.15 } },
    { spotKey: '6max-10bb-btn-push-v3', handClass: 'K7s', actions: { fold: 0, call: 0, raise: 1 } },
    { spotKey: '2max-10bb-bb-vs-sb-shove-v3', handClass: 'Q9o', actions: { fold: 0.4, call: 0.6, raise: 'x' } },
    { spotKey: 'somewhere-else-v3', handClass: 'AA', actions: { fold: 1 } },
    { spotKey: 7 },
  ] });
  assert.deepEqual(questions.map((question) => question.handClass), ['KTo', '64o', 'K7s', 'Q9o'], 'T9s was not served');
  assert.deepEqual(questions[0].choices.map((choice) => choice.label), ['폴드', '콜', '레이즈']);
  assert.deepEqual(questions[1].choices.map((choice) => choice.label), ['폴드', '레이즈']);
  assert.deepEqual(questions[2].choices.map((choice) => choice.label), ['폴드', '올인']);
  assert.deepEqual(questions[3].choices.map((choice) => choice.label), ['폴드', '콜']);
  assert.deepEqual(questions[3].reference, { fold: 0.4, call: 0.6, raise: 0 });
  assert.deepEqual(quizQuestions(candidates, null), []);
  assert.deepEqual(quizQuestions(candidates, { items: [{ spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', actions: {} }] }), [], 'no reference row, no question');
});

test('feedback states the reference, what was played and whether they meet', () => {
  const [question] = quizQuestions(quizCandidates([item({ spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', chosen: { action: 'raise' } })]),
    { items: [{ spotKey: '6max-100bb-co-rfi-v3', handClass: '64o', actions: { fold: 0.85, call: 0, raise: 0.15 } }] });
  assert.deepEqual(quizFeedback(question, 'fold'), { agrees: true, verdict: '기준표도 하는 선택입니다.',
    reference: '기준표 참고: 폴드 85% · 레이즈 15%', played: '게임에서 내 선택: 레이즈' });
  assert.deepEqual(quizFeedback(question, 'raise'), { agrees: true, verdict: '기준표도 하는 선택입니다.',
    reference: '기준표 참고: 폴드 85% · 레이즈 15%', played: '게임에서 내 선택: 레이즈 (지금과 같음)' });
  const [other] = quizQuestions(quizCandidates([item()]), { items: [{ spotKey: '6max-100bb-btn-vs-utg-open-v3', handClass: 'KTo', actions: { fold: 1, call: 0, raise: 0 } }] });
  const feedback = quizFeedback(other, 'call');
  assert.equal(feedback.agrees, false);
  assert.equal(feedback.verdict, '기준표와 다른 선택입니다.');
  for (const line of [QUIZ_NOTE, ...Object.values(feedback).filter((value) => typeof value === 'string'),
    quizErrorText('GRID_LOCKED'), quizErrorText('STUDY_BUSY'), quizErrorText('x')]) assert.equal(coachingClaimAllowed(line), true, line);
});
