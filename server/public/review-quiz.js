// End-of-game review quiz (host only): a few of this game's own preflop spots,
// asked again. The questions come from the game's training items (which spot,
// which hand, what the host chose); the app server serves the ones the game asked,
// with the actions each offers and no reference. Each answer goes to the server,
// which records the spot as a chart view in the study store before it answers with
// the reference, and records one review when the pair is a due mistake-bank item.
// The reference is drawn only from that answer: a refused answer shows none.

const SPOT_RE = /^[a-z0-9-]{1,100}$/;
const HAND_RE = /^[2-9TJQKA]{2}[so]?$/;
const ACTIONS = ['fold', 'call', 'raise'];
const GRADE_ORDER = { 'off-policy': 0, 'low-frequency': 1 };
export const QUIZ_LIMIT = 5;

/** Up to `limit` distinct (spot, hand) pairs: choices that differed from the
 * reference first, then low-frequency ones, then the rest, oldest hand first.
 * The app server applies the same function to the same training list to know
 * which questions the game asked. */
export function quizCandidates(items, { limit = QUIZ_LIMIT, titleOf = () => '' } = {}) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.status !== 'supported' || item.forced === true) continue;
    if (item.street !== undefined && item.street !== 'preflop') continue;
    if (typeof item.spotKey !== 'string' || !SPOT_RE.test(item.spotKey)) continue;
    if (typeof item.handClass !== 'string' || !HAND_RE.test(item.handClass)) continue;
    if (!ACTIONS.includes(item.chosen?.action)) continue;
    const key = `${item.spotKey}:${item.handClass}`;
    rows.push({ key, spotKey: item.spotKey, handClass: item.handClass, chosen: item.chosen.action,
      handNo: Number.isSafeInteger(item.handNo) ? item.handNo : 0, order: GRADE_ORDER[item.grade] ?? 2, title: String(titleOf(item) ?? '') });
  }
  rows.sort((a, b) => a.order - b.order || a.handNo - b.handNo || a.key.localeCompare(b.key));
  // One question per (spot, hand): the occurrence that ranks first is the one kept.
  const seen = new Set();
  const distinct = rows.filter((row) => !seen.has(row.key) && seen.add(row.key));
  return distinct.slice(0, Math.max(0, limit)).map(({ order, ...row }) => row);
}

/** The request body for the app server: the pairs and nothing else. */
export function quizRequest(candidates) {
  return { items: candidates.map((row) => ({ spotKey: row.spotKey, handClass: row.handClass })) };
}

const labelOf = (action, spotKey) => (action === 'fold' ? '폴드' : action === 'call' ? '콜' : /-push-v3$/.test(spotKey) ? '올인' : '레이즈');
const frequency = (value) => (Number.isFinite(value) && value > 0 && value <= 1 ? value : 0);
const validChoices = (choices) => Array.isArray(choices) && choices.length > 0 && choices.length <= ACTIONS.length
  && choices.every((action) => ACTIONS.includes(action)) && new Set(choices).size === choices.length;

/** Questions for the candidates the server served (it leaves out a pair the game
 * did not ask or that has no chart cell), in candidate order, with the actions the
 * server says the question offers. */
export function quizQuestions(candidates, response) {
  const served = new Map();
  for (const row of Array.isArray(response?.items) ? response.items : []) {
    if (typeof row?.spotKey !== 'string' || typeof row.handClass !== 'string' || !validChoices(row.choices)) continue;
    served.set(`${row.spotKey}:${row.handClass}`, row.choices);
  }
  return (Array.isArray(candidates) ? candidates : []).filter((row) => served.has(row.key)).map((row) => ({
    key: row.key, spotKey: row.spotKey, title: row.title, handClass: row.handClass, chosen: row.chosen,
    choices: served.get(row.key).map((action) => ({ action, label: labelOf(action, row.spotKey) })),
    labels: Object.fromEntries(ACTIONS.map((action) => [action, labelOf(action, row.spotKey)])),
  }));
}

/** The reference rows of a server answer, or null when it carries none. */
function referenceOf(value) {
  if (!value || typeof value !== 'object') return null;
  const reference = Object.fromEntries(ACTIONS.map((action) => [action, frequency(value[action])]));
  return ACTIONS.some((action) => reference[action] > 0) ? reference : null;
}

/** What to show once the server has answered: its reference against the answer. */
export function quizFeedback(question, answer, reference) {
  const rows = ACTIONS.filter((action) => reference[action] > 0)
    .sort((a, b) => reference[b] - reference[a])
    .map((action) => `${question.labels[action]} ${Math.round(reference[action] * 100)}%`);
  const agrees = reference[answer] > 0;
  return {
    agrees,
    verdict: agrees ? '기준표도 하는 선택입니다.' : '기준표와 다른 선택입니다.',
    reference: `기준표 참고: ${rows.join(' · ')}`,
    played: `게임에서 내 선택: ${question.labels[question.chosen] ?? question.chosen}${question.chosen === answer ? ' (지금과 같음)' : ''}`,
  };
}

/** The line under an answer about the mistake bank; empty for a pair outside it. */
export function quizRecordText(review) {
  if (!review || typeof review !== 'object') return '';
  if (review.recorded === true) {
    if (review.already === true) return '이 게임에서 이미 오답 은행 복습으로 기록한 자리입니다.';
    if (review.graduated === true) return '오답 은행 복습으로 기록했습니다 · 이 항목은 복습 목록에서 졸업했습니다';
    return Number.isSafeInteger(review.intervalDays) && review.intervalDays > 0
      ? `오답 은행 복습으로 기록했습니다 · 다음 복습 ${review.intervalDays}일 뒤` : '오답 은행 복습으로 기록했습니다';
  }
  if (review.reason === 'NOT_DUE') return '오답 은행 항목이지만 아직 복습 시각이 아니어서 일정은 그대로입니다.';
  if (review.reason === 'SOURCE_NOT_TRACKED') return '이전 기준표 버전의 자리라 복습 일정에는 반영하지 않습니다.';
  if (review.reason === 'REVIEW_UNCONFIRMED') return '복습 기록을 확인하지 못했습니다.';
  if (review.reason === 'REVIEW_LOG_INVALID') return '복습 기록 파일을 확인할 수 없어 복습 일정에 반영하지 않았습니다.';
  return '';
}

export const QUIZ_NOTE = '휴리스틱 기준표와의 비교이며 점수로 저장하지 않습니다. 답하면 그 자리의 기준표를 본 것으로 학습 기록에 남고, 복습 시각이 된 오답 은행 항목이면 복습 일정이 움직입니다.';

/** Status line for a failed open, by the server's code. */
export function quizErrorText(code) {
  if (code === 'GRID_LOCKED') return '학습실에서 평가·재평가·일반화 연습이 진행 중일 때는 복습 문제를 열 수 없습니다. 실행을 마친 뒤 다시 열어 주세요.';
  if (code === 'GAME_NOT_OVER') return '게임이 끝난 뒤에 열 수 있습니다.';
  if (code === 'STUDY_BUSY') return '학습 기록이 잠시 사용 중입니다. 다시 열어 주세요.';
  return '복습 문제를 불러오지 못했습니다. 다시 열어 주세요.';
}

const REOPEN_CODES = new Set(['QUIZ_NOT_ISSUED', 'STALE_GAME', 'GAME_NOT_OVER', 'RELAY_UNAVAILABLE']);
/** A refused answer that only reopening the quiz can fix (the asked set or the game changed). */
export function quizNeedsReopen(code) {
  return REOPEN_CODES.has(code);
}

/** The notice for a refused answer, by the server's code. No reference is shown with it. */
export function quizAnswerErrorText(code) {
  if (code === 'GRID_LOCKED') return '학습실에서 평가·재평가·일반화 연습이 진행 중이라 지금은 답을 확인할 수 없습니다. 실행을 마친 뒤 다시 답해 주세요.';
  if (code === 'STUDY_BUSY') return '학습 기록이 잠시 사용 중입니다. 다시 답해 주세요.';
  if (quizNeedsReopen(code)) return '이 문제는 지금 확인할 수 없습니다. 복습 문제를 다시 열어 주세요.';
  return '답을 확인하지 못했습니다. 다시 답해 주세요.';
}

/**
 * Draws the quiz into `box` and returns { state }. One question at a time; an
 * answer is sent with `submit(question, action)`, which resolves to
 * { ok: true, body } (the server's answer) or { ok: false, code }. The buttons stay
 * locked while it is in flight; a refusal stores nothing, shows a notice and no
 * reference, and calls `onRefused(code)`. `state` survives a repaint of the
 * surrounding screen when the caller passes it back in.
 */
export function paintQuiz(box, questions, { doc = box.ownerDocument, state = { at: 0, answers: [] }, onChange = () => {}, submit, onRefused = () => {} } = {}) {
  state.answers ??= [];
  state.results ??= [];
  state.notice ??= '';
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const agreed = (at) => Boolean(state.results[at]?.reference && state.results[at].reference[state.answers[at]] > 0);
  const send = (at, action) => {
    if (state.sending || state.answers[at] !== undefined || typeof submit !== 'function') return;
    state.sending = true;
    state.notice = '';
    onChange(state);
    draw();
    let refused = null;
    let sent;
    try { sent = Promise.resolve(submit(questions[at], action)); } catch (error) { sent = Promise.reject(error); }
    sent.then((outcome) => {
      const reference = outcome?.ok === true ? referenceOf(outcome.body?.reference) : null;
      if (reference) {
        state.answers[at] = action;
        state.results[at] = { reference, review: outcome.body.review ?? null };
      } else refused = outcome?.ok === false ? outcome.code : null;
    }, () => { refused = null; }).then(() => {
      if (state.answers[at] === undefined) state.notice = quizAnswerErrorText(refused);
      state.sending = false;
      onChange(state);
      draw();
      if (state.answers[at] === undefined) onRefused(refused);
    });
  };
  const draw = () => {
    box.replaceChildren();
    if (state.at >= questions.length) {
      const same = questions.filter((question, at) => agreed(at)).length;
      const recorded = state.results.filter((result) => result?.review?.recorded === true && result.review.already !== true).length;
      box.append(make('p', 'quiz-done', `복습 ${questions.length}문제를 마쳤습니다. 기준표도 하는 선택 ${same}개.${recorded ? ` 오답 은행 복습 ${recorded}개를 기록했습니다.` : ''}`));
      return;
    }
    const question = questions[state.at];
    const answer = state.answers[state.at];
    box.append(make('p', 'quiz-progress', `${state.at + 1} / ${questions.length}`), make('p', 'quiz-title', question.title || question.handClass),
      make('p', 'quiz-prompt', `${question.handClass}로 여기서 무엇을 하시겠습니까?`));
    const row = make('div', 'quiz-choices');
    for (const choice of question.choices) {
      const button = make('button', 'btn btn-ghost quiz-choice', choice.label);
      button.type = 'button';
      button.disabled = answer !== undefined || state.sending === true;
      if (answer === choice.action) button.classList.add('is-picked');
      const at = state.at;
      button.addEventListener('click', () => send(at, choice.action));
      row.append(button);
    }
    box.append(row);
    if (answer === undefined) {
      if (state.notice) box.append(make('p', 'quiz-notice', state.notice));
      return;
    }
    const result = state.results[state.at];
    const feedback = quizFeedback(question, answer, result.reference);
    const shown = make('div', `quiz-feedback ${feedback.agrees ? 'is-same' : 'is-different'}`);
    shown.append(make('p', 'quiz-verdict', feedback.verdict), make('p', '', feedback.reference), make('p', '', feedback.played));
    box.append(shown);
    const line = quizRecordText(result.review);
    if (line) box.append(make('p', 'quiz-record', line));
    const next = make('button', 'btn btn-ghost quiz-next', state.at + 1 < questions.length ? '다음 문제' : '마치기');
    next.type = 'button';
    next.addEventListener('click', () => { state.at += 1; state.notice = ''; onChange(state); draw(); });
    box.append(next);
  };
  draw();
  return { state };
}
