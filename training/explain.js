import { independentAssessmentEligibility } from '../shared/assistance.js';
import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import { coachingClaimAllowed, isCoverageReferenceSource, referenceQuality } from '../shared/reference.js';

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

/** Whether an explanation of this evaluation could pass validateExplanation
 * at all (its source checks). The pipeline skips the LLM call otherwise. */
export function explanationEligible(evaluation) {
  if (evaluation?.status === 'supported' && referenceQuality(evaluation.source).quality !== 'heuristic-reference') return false;
  if (isCoverageReferenceSource(evaluation?.source) && !independentAssessmentEligibility(evaluation).verified) return false;
  return true;
}

// Numbers that are part of the evaluation's own identifiers: the hand class
// ("92s", "22"), the spot key, the table size ("6max", "6인"), the spot's stack
// depth ("100BB") and position labels with digits ("UTG+1"). Only these exact
// tokens are exempt from the numeric checks; any other number is still judged.
function identitySpans(text, evaluation) {
  const tokens = new Set();
  const handClass = typeof evaluation?.handClass === 'string' ? evaluation.handClass : null;
  if (handClass && /^[2-9TJQKA]{2}[so]?$/.test(handClass)) tokens.add(handClass);
  const spotKey = typeof evaluation?.spotKey === 'string' ? evaluation.spotKey : '';
  if (/^[a-z0-9+-]{1,100}$/.test(spotKey)) tokens.add(spotKey);
  const seats = /^(\d)max-/.exec(spotKey)?.[1];
  if (seats) { tokens.add(`${seats}max`); tokens.add(`${seats}인`); }
  const stack = /^\dmax-(\d+)bb-/.exec(spotKey)?.[1];
  if (stack) { tokens.add(`${stack}BB`); tokens.add(`${stack}bb`); tokens.add(`${stack} BB`); }
  for (const label of ['UTG+1', 'UTG+2', 'UTG1', 'UTG2']) tokens.add(label);
  const spans = [];
  for (const token of tokens) {
    let at = text.indexOf(token);
    while (at >= 0) {
      const before = text[at - 1] ?? '';
      const after = text[at + token.length] ?? '';
      if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) spans.push([at, at + token.length]);
      at = text.indexOf(token, at + 1);
    }
  }
  return spans;
}
const insideSpans = (spans, start, length) => spans.some(([from, to]) => start >= from && start + length <= to);

export function validateExplanation(evaluation, explanation) {
  if (typeof explanation !== 'string' || !explanation.trim()) {
    return { ok: false, code: 'EMPTY_EXPLANATION' };
  }
  if (explanation.length > MAX_EXPLANATION) {
    return { ok: false, code: 'EXPLANATION_TOO_LONG' };
  }
  if (!coachingClaimAllowed(explanation)) {
    return { ok: false, code: 'REFERENCE_AUTHORITY_CLAIM' };
  }
  if (evaluation?.status === 'supported'
    && referenceQuality(evaluation.source).quality !== 'heuristic-reference') {
    return { ok: false, code: 'REFERENCE_SOURCE_UNVERIFIED' };
  }
  const eligibility = independentAssessmentEligibility(evaluation);
  if (isCoverageReferenceSource(evaluation?.source) && !eligibility.verified) return {ok:false,code:'REFERENCE_SOURCE_UNVERIFIED'};
  if (evaluation?.status !== 'supported' || (isCoverageReferenceSource(evaluation?.source) && !eligibility.metricEligible)) {
    if (/직접\s*비교|주력\s*선택|허용\s*선택|저빈도|off.policy|preferred|mixed/i.test(explanation)) return {ok:false,code:'REFERENCE_AUTHORITY_CLAIM'};
    const numberRe = /-?\d+(?:\.\d+)?/g;
    const handNo = evaluation?.handNo;
    const identities = identitySpans(explanation, evaluation);
    let match;
    while ((match = numberRe.exec(explanation))) {
      const token = match[0];
      if (insideSpans(identities, match.index, token.length)) continue;
      if (EV_WORDS.test(clauseAt(explanation, match.index))
        || handNo == null || token !== String(handNo)) {
        return { ok: false, code: 'NUMBER_CONTRADICTION' };
      }
    }
    return { ok: true };
  }

  const actions = [evaluation.chosen, ...(evaluation.recommended ?? [])].filter(Boolean);
  const freqByAction = new Map();
  const sizeBbs = [];
  for (const action of actions) {
    if (action.action && action.frequency != null && Number.isFinite(Number(action.frequency))) {
      freqByAction.set(action.action, Number(action.frequency));
    }
    if (action.sizeBb != null && Number.isFinite(Number(action.sizeBb))) {
      sizeBbs.push(Number(action.sizeBb));
    }
  }
  const handNo = Number(evaluation.handNo);
  const spans = aliasSpans(explanation);
  const identities = identitySpans(explanation, evaluation);
  const numberRe = /-?\d+(?:\.\d+)?/g;
  let match;
  while ((match = numberRe.exec(explanation))) {
    const token = match[0];
    if (numberCoveredByAlias(spans, match.index, token.length)) continue;
    if (insideSpans(identities, match.index, token.length)) continue;
    const num = Number(token);
    const range = clauseRangeAt(explanation, match.index);
    const clause = range.clause;
    const rest = afterToken(explanation, match.index, token);
    const isPercent = /^\s*%/.test(rest);
    const isBb = /^\s*(?:bb|BB)/.test(rest);
    const isHandNo = Number.isFinite(handNo) && !token.includes('.') && num === handNo;

    if (EV_WORDS.test(clause)) {
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
