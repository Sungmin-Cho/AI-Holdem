// End-of-game review quiz (host only): a few of this game's own preflop spots,
// asked again before the reference is shown. The questions come from the game's
// training items (which spot, which hand, what the host chose); the reference
// rows come from the app server, which records each spot as a chart view in the
// study store before it answers. Nothing is scored or saved here.

const SPOT_RE = /^[a-z0-9-]{1,100}$/;
const HAND_RE = /^[2-9TJQKA]{2}[so]?$/;
const ACTIONS = ['fold', 'call', 'raise'];
const GRADE_ORDER = { 'off-policy': 0, 'low-frequency': 1 };
export const QUIZ_LIMIT = 5;

/** Up to `limit` distinct (spot, hand) pairs: choices that differed from the
 * reference first, then low-frequency ones, then the rest, oldest hand first. */
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

// What can be chosen in a spot, from its key: an unopened pot is raise or fold,
// a push spot is all-in or fold, a shove is call or fold, the rest all three.
function choicesOf(spotKey) {
  if (/-(?:rfi|push)-v3$/.test(spotKey)) return ['fold', 'raise'];
  if (/-shove-v3$/.test(spotKey)) return ['fold', 'call'];
  return ACTIONS;
}
const labelOf = (action, spotKey) => (action === 'fold' ? '폴드' : action === 'call' ? '콜' : /-push-v3$/.test(spotKey) ? '올인' : '레이즈');
const frequency = (value) => (Number.isFinite(value) && value > 0 && value <= 1 ? value : 0);

/** Questions for the candidates the server answered (it leaves out a spot it
 * could not record), in candidate order. */
export function quizQuestions(candidates, response) {
  const served = new Map();
  for (const row of Array.isArray(response?.items) ? response.items : []) {
    if (typeof row?.spotKey !== 'string' || typeof row.handClass !== 'string' || !row.actions || typeof row.actions !== 'object') continue;
    served.set(`${row.spotKey}:${row.handClass}`, row.actions);
  }
  return (Array.isArray(candidates) ? candidates : []).filter((row) => served.has(row.key)).map((row) => {
    const actions = served.get(row.key);
    const reference = Object.fromEntries(ACTIONS.map((action) => [action, frequency(actions[action])]));
    return { key: row.key, title: row.title, handClass: row.handClass, chosen: row.chosen, reference,
      choices: choicesOf(row.spotKey).map((action) => ({ action, label: labelOf(action, row.spotKey) })),
      labels: Object.fromEntries(ACTIONS.map((action) => [action, labelOf(action, row.spotKey)])) };
  }).filter((question) => ACTIONS.some((action) => question.reference[action] > 0));
}

/** What to show once the host has answered a question. */
export function quizFeedback(question, answer) {
  const rows = ACTIONS.filter((action) => question.reference[action] > 0)
    .sort((a, b) => question.reference[b] - question.reference[a])
    .map((action) => `${question.labels[action]} ${Math.round(question.reference[action] * 100)}%`);
  const agrees = question.reference[answer] > 0;
  return {
    agrees,
    verdict: agrees ? '기준표도 하는 선택입니다.' : '기준표와 다른 선택입니다.',
    reference: `기준표 참고: ${rows.join(' · ')}`,
    played: `게임에서 내 선택: ${question.labels[question.chosen] ?? question.chosen}${question.chosen === answer ? ' (지금과 같음)' : ''}`,
  };
}

export const QUIZ_NOTE = '휴리스틱 기준표와의 비교이며 점수로 저장하지 않습니다. 문제를 열면 그 자리의 기준표를 본 것으로 학습 기록에 남습니다.';

/** Status line for a failed open, by the server's code. */
export function quizErrorText(code) {
  if (code === 'GRID_LOCKED') return '학습실에서 평가·재평가·일반화 연습이 진행 중일 때는 복습 문제를 열 수 없습니다. 실행을 마친 뒤 다시 열어 주세요.';
  if (code === 'GAME_NOT_OVER') return '게임이 끝난 뒤에 열 수 있습니다.';
  if (code === 'STUDY_BUSY') return '학습 기록이 잠시 사용 중입니다. 다시 열어 주세요.';
  return '복습 문제를 불러오지 못했습니다. 다시 열어 주세요.';
}

/**
 * Draws the quiz into `box` and returns { state }. One question at a time; the
 * answer buttons give way to the feedback and a next button. `state` survives a
 * repaint of the surrounding screen when the caller passes it back in.
 */
export function paintQuiz(box, questions, { doc = box.ownerDocument, state = { at: 0, answers: [] }, onChange = () => {} } = {}) {
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const draw = () => {
    box.replaceChildren();
    if (state.at >= questions.length) {
      const same = state.answers.filter((answer, at) => questions[at].reference[answer] > 0).length;
      box.append(make('p', 'quiz-done', `복습 ${questions.length}문제를 마쳤습니다. 기준표도 하는 선택 ${same}개.`));
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
      button.disabled = answer !== undefined;
      if (answer === choice.action) button.classList.add('is-picked');
      button.addEventListener('click', () => {
        if (state.answers[state.at] !== undefined) return;
        state.answers[state.at] = choice.action;
        onChange(state);
        draw();
      });
      row.append(button);
    }
    box.append(row);
    if (answer === undefined) return;
    const feedback = quizFeedback(question, answer);
    const result = make('div', `quiz-feedback ${feedback.agrees ? 'is-same' : 'is-different'}`);
    result.append(make('p', 'quiz-verdict', feedback.verdict), make('p', '', feedback.reference), make('p', '', feedback.played));
    const next = make('button', 'btn btn-ghost quiz-next', state.at + 1 < questions.length ? '다음 문제' : '마치기');
    next.type = 'button';
    next.addEventListener('click', () => { state.at += 1; onChange(state); draw(); });
    box.append(result, next);
  };
  draw();
  return { state };
}
