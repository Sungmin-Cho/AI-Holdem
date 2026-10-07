// Pot-odds practice (design D12): client-only, never journaled. A price is the
// call against the pot after the call; the answer is the required equity
// call / (pot + call). Statistics stay in this browser.
const KEY = 'holdem.pot-odds.v1';
const SIZES = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.5, 2];

export function potOddsQuestion(random = Math.random) {
  const potBb = [4, 6, 8, 10, 12, 16, 20, 30, 40][Math.floor(random() * 9)];
  const betBb = Math.max(1, Math.round(potBb * SIZES[Math.floor(random() * SIZES.length)]));
  const total = potBb + betBb; // the pot the caller faces, the bet included
  const answer = Math.round((100 * betBb) / (total + betBb));
  const distractors = new Set([answer]);
  const near = [answer - 10, answer + 10, Math.round((100 * betBb) / total), answer - 5, answer + 5, answer + 15];
  for (const value of near) if (distractors.size < 4 && value > 0 && value < 100) distractors.add(value);
  const options = [...distractors].sort((a, b) => a - b);
  return { potBb: total, callBb: betBb, answer, options };
}

export function checkPotOdds(question, choice) {
  const correct = choice === question.answer;
  return { correct, explanation: `필요 승률 = 콜 ÷ (팟 + 콜) = ${question.callBb} ÷ (${question.potBb} + ${question.callBb}) ≈ ${question.answer}%` };
}

export function readPotOddsStats(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (raw && Number.isSafeInteger(raw.answered) && Number.isSafeInteger(raw.correct) && Number.isSafeInteger(raw.streak)) return raw;
  } catch { /* fresh stats */ }
  return { answered: 0, correct: 0, streak: 0 };
}

export function recordPotOdds(storage, correct) {
  const stats = readPotOddsStats(storage);
  const next = { answered: stats.answered + 1, correct: stats.correct + (correct ? 1 : 0), streak: correct ? stats.streak + 1 : 0 };
  try { storage?.setItem(KEY, JSON.stringify(next)); } catch { /* the page still works */ }
  return next;
}

export function mountPotOddsDrill(doc, container, { storage, random = Math.random } = {}) {
  let question = potOddsQuestion(random);
  const prompt = doc.createElement('p');
  prompt.className = 'pot-odds-prompt';
  const choices = doc.createElement('div');
  choices.className = 'pot-odds-choices';
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', '필요 승률 선택');
  const result = doc.createElement('p');
  result.className = 'pot-odds-result';
  result.setAttribute('role', 'status');
  const stats = doc.createElement('p');
  stats.className = 'pot-odds-stats';
  const next = doc.createElement('button');
  next.type = 'button';
  next.className = 'ui-btn ui-btn--ghost';
  next.textContent = '다음 가격';
  const paintStats = (value) => { stats.textContent = value.answered ? `이 브라우저 기록: ${value.correct} / ${value.answered} 정답 · 연속 ${value.streak}` : '기록은 이 브라우저에만 남습니다.'; };
  const paint = () => {
    prompt.textContent = `팟 ${question.potBb}BB에 콜 ${question.callBb}BB가 필요합니다. 필요한 승률은?`;
    choices.replaceChildren(...question.options.map((value) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ui-btn ui-btn--secondary';
      button.textContent = `${value}%`;
      button.addEventListener('click', () => {
        const checked = checkPotOdds(question, value);
        result.textContent = `${checked.correct ? '정답' : '오답'} · ${checked.explanation}`;
        paintStats(recordPotOdds(storage, checked.correct));
        for (const node of choices.children) node.disabled = true;
      });
      return button;
    }));
    result.textContent = '';
  };
  next.addEventListener('click', () => { question = potOddsQuestion(random); paint(); });
  container.replaceChildren(prompt, choices, result, next, stats);
  paint();
  paintStats(readPotOddsStats(storage));
  return { get question() { return question; } };
}
