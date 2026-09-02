const ACTION_ALIASES = Object.freeze({
  raise: ['리레이즈', '3-bet', '3벳', '레이즈', 'raise', '오픈'],
  fold: ['fold', '폴드'],
  call: ['call', '콜'],
  check: ['check', '체크'],
});

const ALIAS_ROWS = Object.freeze(
  Object.entries(ACTION_ALIASES).flatMap(([action, aliases]) => (
    aliases.map((alias) => ({ action, alias, len: alias.length }))
  )).sort((left, right) => right.len - left.len),
);

const EV_WORDS = /EV|손실|loss|이득/i;
const MAX_EXPLANATION = 600;

function clausesOf(text) {
  return text.split(/(?:(?<!\d)\.(?!\d)|[!?。\n])+/);
}

function clauseAt(text, index) {
  let start = 0;
  for (const clause of clausesOf(text)) {
    const end = start + clause.length;
    if (index >= start && index <= end) return clause;
    start = end + 1;
  }
  return text;
}

function actionIn(clause) {
  const lower = String(clause).toLowerCase();
  for (const row of ALIAS_ROWS) {
    if (lower.includes(row.alias.toLowerCase())) return row.action;
  }
  return null;
}

function afterToken(text, index, token) {
  return text.slice(index + token.length);
}

export function validateExplanation(evaluation, explanation) {
  if (typeof explanation !== 'string' || !explanation.trim()) {
    return { ok: false, code: 'EMPTY_EXPLANATION' };
  }
  if (explanation.length > MAX_EXPLANATION) {
    return { ok: false, code: 'EXPLANATION_TOO_LONG' };
  }
  if (evaluation?.status !== 'supported') {
    if (/(정답|GTO)/i.test(explanation) && !/지원되지/.test(explanation)) {
      return { ok: false, code: 'UNSUPPORTED_AS_ANSWER' };
    }
    const tokens = explanation.match(/-?\d+(?:\.\d+)?/g) ?? [];
    const handNo = evaluation?.handNo;
    for (const token of tokens) {
      if (handNo == null || token !== String(handNo)) {
        return { ok: false, code: 'NUMBER_CONTRADICTION' };
      }
    }
    return { ok: true };
  }

  const actions = [evaluation.chosen, ...(evaluation.recommended ?? [])].filter(Boolean);
  const freqByAction = new Map();
  const sizeBbs = [];
  let anyEv = false;
  for (const action of actions) {
    if (action.action && action.frequency != null && Number.isFinite(Number(action.frequency))) {
      freqByAction.set(action.action, Number(action.frequency));
    }
    if (action.sizeBb != null && Number.isFinite(Number(action.sizeBb))) {
      sizeBbs.push(Number(action.sizeBb));
    }
    if (action.evBb != null && Number.isFinite(Number(action.evBb))) anyEv = true;
  }
  const handNo = Number(evaluation.handNo);
  const numberRe = /-?\d+(?:\.\d+)?/g;
  let match;
  while ((match = numberRe.exec(explanation))) {
    const token = match[0];
    const num = Number(token);
    const clause = clauseAt(explanation, match.index);
    const rest = afterToken(explanation, match.index, token);
    const isPercent = /^\s*%/.test(rest);
    const isBb = /^\s*(?:bb|BB)/.test(rest);
    const isHandNo = Number.isFinite(handNo) && !token.includes('.') && num === handNo;

    if (!anyEv && EV_WORDS.test(clause) && !isHandNo) {
      return { ok: false, code: 'NUMBER_CONTRADICTION' };
    }

    if (isPercent) {
      const action = actionIn(clause);
      const expected = action ? freqByAction.get(action) : undefined;
      if (expected == null || Math.abs(num - expected * 100) > 0.5) {
        return { ok: false, code: 'NUMBER_CONTRADICTION' };
      }
      continue;
    }
    if (isBb) {
      if (EV_WORDS.test(clause) || !sizeBbs.some((size) => Math.abs(size - num) <= 0.05)) {
        return { ok: false, code: 'NUMBER_CONTRADICTION' };
      }
      continue;
    }
    if (isHandNo) continue;
    if (num >= 0 && num <= 1) {
      const action = actionIn(clause);
      const expected = action ? freqByAction.get(action) : undefined;
      if (expected != null && Math.abs(num - expected) <= 0.005) continue;
    }
    return { ok: false, code: 'NUMBER_CONTRADICTION' };
  }
  return { ok: true };
}
