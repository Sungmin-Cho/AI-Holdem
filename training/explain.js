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

const CLAUSE_SEP = /(?:(?<!\d)\.(?!\d)|(?<=\d)\.(?=\s|$)|[!?。\n])+/g;

function clauseRanges(text) {
  const ranges = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_SEP)) {
    ranges.push({ clause: text.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  ranges.push({ clause: text.slice(start), start, end: text.length });
  return ranges;
}

function clauseRangeAt(text, index) {
  for (const range of clauseRanges(text)) {
    if (index >= range.start && index <= range.end) return range;
  }
  return { clause: text, start: 0, end: text.length };
}

function clauseAt(text, index) {
  return clauseRangeAt(text, index).clause;
}

function aliasSpans(text) {
  const lower = String(text).toLowerCase();
  const found = [];
  for (const row of ALIAS_ROWS) {
    const alias = row.alias.toLowerCase();
    let from = 0;
    while (from <= lower.length - alias.length) {
      const idx = lower.indexOf(alias, from);
      if (idx === -1) break;
      found.push({
        start: idx, end: idx + alias.length, action: row.action, len: alias.length,
      });
      from = idx + alias.length;
    }
  }
  found.sort((left, right) => left.start - right.start || right.len - left.len);
  const kept = [];
  for (const span of found) {
    if (kept.some((row) => span.start >= row.start && span.end <= row.end)) continue;
    kept.push(span);
  }
  return kept;
}

function numberCoveredByAlias(spans, index, tokenLen) {
  const end = index + tokenLen;
  return spans.some((span) => index >= span.start && end <= span.end);
}

function actionNearest(spans, index, tokenLen) {
  const start = index;
  const end = index + tokenLen;
  let best = null;
  let bestDist = Infinity;
  for (const span of spans) {
    const dist = end < span.start
      ? span.start - end
      : start > span.end
        ? start - span.end
        : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = span.action;
    }
  }
  return best;
}

function actionInClause(spans, index, tokenLen, range) {
  const local = spans.filter((span) => span.start >= range.start && span.end <= range.end);
  return actionNearest(local, index, tokenLen);
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
  const spans = aliasSpans(explanation);
  const numberRe = /-?\d+(?:\.\d+)?/g;
  let match;
  while ((match = numberRe.exec(explanation))) {
    const token = match[0];
    if (numberCoveredByAlias(spans, match.index, token.length)) continue;
    const num = Number(token);
    const range = clauseRangeAt(explanation, match.index);
    const clause = range.clause;
    const rest = afterToken(explanation, match.index, token);
    const isPercent = /^\s*%/.test(rest);
    const isBb = /^\s*(?:bb|BB)/.test(rest);
    const isHandNo = Number.isFinite(handNo) && !token.includes('.') && num === handNo;

    if (!anyEv && EV_WORDS.test(clause) && !isHandNo) {
      return { ok: false, code: 'NUMBER_CONTRADICTION' };
    }

    if (isPercent) {
      const action = actionInClause(spans, match.index, token.length, range);
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
      const action = actionInClause(spans, match.index, token.length, range);
      const expected = action ? freqByAction.get(action) : undefined;
      if (expected != null && Math.abs(num - expected) <= 0.005) continue;
    }
    return { ok: false, code: 'NUMBER_CONTRADICTION' };
  }
  return { ok: true };
}
