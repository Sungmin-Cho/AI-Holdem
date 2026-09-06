export const CANONICAL_REFERENCE_SOURCE = Object.freeze({
  id: 'local-preflop-baseline',
  version: '1.0.0',
  contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
});

const HEX64_RE = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise']);
const ALLOWED_GRADES = new Set(['preferred', 'mixed', 'low-frequency']);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function referenceQuality(source) {
  if (!plainObject(source)) return { quality: 'unverified', reason: 'SOURCE_MISSING' };
  if (source.id === 'fake-solver') return { quality: 'synthetic', reason: 'SYNTHETIC_SOURCE' };
  if (source.id === CANONICAL_REFERENCE_SOURCE.id
    && source.version === CANONICAL_REFERENCE_SOURCE.version
    && source.contentSha256 === CANONICAL_REFERENCE_SOURCE.contentSha256) {
    return { quality: 'heuristic-reference', reason: null };
  }
  return { quality: 'unverified', reason: 'SOURCE_IDENTITY_UNVERIFIED' };
}

export function isAllowedGrade(grade) {
  return ALLOWED_GRADES.has(grade);
}

export function actionKey(action) {
  if (!plainObject(action) || !ACTIONS.has(action.action)) {
    throw coded('MIX_OBSERVATION_INVALID', 'action is not in the supported vocabulary');
  }
  if (action.sizeBb !== undefined
    && (typeof action.sizeBb !== 'number' || !Number.isFinite(action.sizeBb) || action.sizeBb < 0)) {
    throw coded('MIX_OBSERVATION_INVALID', 'action sizeBb is invalid');
  }
  return action.sizeBb === undefined ? action.action : `${action.action}@${action.sizeBb}`;
}

function normalizeReferenceAction(action) {
  const key = actionKey(action);
  if (typeof action.frequency !== 'number'
    || !Number.isFinite(action.frequency)
    || action.frequency < 0
    || action.frequency > 1) {
    throw coded('MIX_OBSERVATION_INVALID', 'reference frequency is invalid');
  }
  if (Object.hasOwn(action, 'evBb')
    && action.evBb !== null
    && (typeof action.evBb !== 'number' || !Number.isFinite(action.evBb))) {
    throw coded('MIX_OBSERVATION_INVALID', 'reference evBb is invalid');
  }
  return {
    action: action.action,
    ...(action.sizeBb !== undefined ? { sizeBb: action.sizeBb } : {}),
    frequency: action.frequency,
    ...(Object.hasOwn(action, 'evBb') ? { evBb: action.evBb ?? null } : {}),
    key,
  };
}

export function validateMixObservation(value) {
  if (!plainObject(value)
    || typeof value.spotKey !== 'string' || value.spotKey.length === 0
    || typeof value.handClass !== 'string' || value.handClass.length === 0
    || !Array.isArray(value.referenceActions) || value.referenceActions.length === 0
    || !plainObject(value.chosenAction)
    || !plainObject(value.sourceIdentity)) {
    throw coded('MIX_OBSERVATION_INVALID', 'mix observation is incomplete');
  }
  const actions = value.referenceActions.map(normalizeReferenceAction);
  const keys = new Set();
  let total = 0;
  for (const action of actions) {
    if (keys.has(action.key)) throw coded('MIX_OBSERVATION_INVALID', 'reference action is duplicated');
    keys.add(action.key);
    total += action.frequency;
  }
  if (Math.abs(total - 1) > 1e-9) {
    throw coded('MIX_OBSERVATION_INVALID', 'reference frequencies must sum to one');
  }
  actionKey(value.chosenAction);
  if (value.chosenAction.frequency !== undefined
    && (typeof value.chosenAction.frequency !== 'number'
      || !Number.isFinite(value.chosenAction.frequency)
      || value.chosenAction.frequency < 0
      || value.chosenAction.frequency > 1)) {
    throw coded('MIX_OBSERVATION_INVALID', 'chosen frequency is invalid');
  }
  if (Object.hasOwn(value.chosenAction, 'evBb')
    && value.chosenAction.evBb !== null
    && (typeof value.chosenAction.evBb !== 'number' || !Number.isFinite(value.chosenAction.evBb))) {
    throw coded('MIX_OBSERVATION_INVALID', 'chosen evBb is invalid');
  }
  const source = value.sourceIdentity;
  if (typeof source.id !== 'string' || source.id.length === 0
    || typeof source.version !== 'string' || source.version.length === 0
    || typeof source.contentSha256 !== 'string' || !HEX64_RE.test(source.contentSha256)) {
    throw coded('MIX_OBSERVATION_INVALID', 'source identity is invalid');
  }
  if (value.detailSha256 !== undefined
    && (typeof value.detailSha256 !== 'string' || !HEX64_RE.test(value.detailSha256))) {
    throw coded('MIX_OBSERVATION_INVALID', 'detail evidence hash is invalid');
  }
  return {
    spotKey: value.spotKey,
    handClass: value.handClass,
    referenceActions: actions
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, ...action }) => action),
    chosenAction: {
      action: value.chosenAction.action,
      ...(value.chosenAction.sizeBb !== undefined ? { sizeBb: value.chosenAction.sizeBb } : {}),
      ...(value.chosenAction.frequency !== undefined ? { frequency: value.chosenAction.frequency } : {}),
      ...(Object.hasOwn(value.chosenAction, 'evBb') ? { evBb: value.chosenAction.evBb ?? null } : {}),
    },
    sourceIdentity: {
      id: source.id,
      version: source.version,
      contentSha256: source.contentSha256,
    },
    ...(value.detailSha256 !== undefined ? { detailSha256: value.detailSha256 } : {}),
  };
}

const REASONS = Object.freeze({
  LEARNING_AUTHORITY_UNAVAILABLE: '봉인된 출처 상세를 확인할 수 없어 기준표 비교를 제공하지 않습니다.',
  SOURCE_MISSING: '출처 정보가 없어 기준표 비교를 제공할 수 없습니다.',
  SOURCE_IDENTITY_UNVERIFIED: '출처 식별값이 확인되지 않아 기준표 비교에서 제외했습니다.',
  SYNTHETIC_SOURCE: '테스트용 합성 출처는 학습 집계에서 제외됩니다.',
  UNSUPPORTED_SPOT: '현재 기준표에서 지원되지 않는 상황입니다.',
  NOT_LEARNABLE: '현재 정량 학습 범위 밖의 상황입니다.',
});

export function formatReferenceReason(code, reason) {
  if (REASONS[code]) return REASONS[code];
  if (typeof reason === 'string' && reason.trim()) return `기준표 비교 불가: ${reason.trim()}`;
  return '기준표 비교를 제공할 수 없습니다.';
}

export function referenceClaimAllowed(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  const normalized = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  const authority = new RegExp([
    // Match the complete attribution noun phrase before checking its predicate.
    // This keeps "GTO-based strategy is not verified" bound to its own negation,
    // while conjunctions/other predicates cannot become part of that phrase.
    String.raw`(?:verified\s+|검증된\s*)?GTO(?:[\s_-]*(?:based|기반(?:의)?|최적(?:의)?|optimal(?:ity)?|optimum|정답|전략|해법|정책|플레이|분석|결과|answer|strategy|solution|policy|play|move|analysis|result|correct(?:ness)?)){0,4}`,
    String.raw`solver[\s_-]*(?:verified|certified|proven)`,
    String.raw`(?:verified\s+)?(?:optimal(?:ity)?|optimum)(?:\s+(?:play|choice|move|result|strategy|answer))?`,
    String.raw`(?:검증된\s*)?최적(?:의)?(?:\s*(?:플레이|선택|행동|전략|결과|답))?`,
    String.raw`확정(?:된)?\s*누수|정답|포커\s*실수`,
    String.raw`기대(?:값|수익)|expected\s+value|\bEV\b(?:\s*(?:손실|loss))?`,
  ].join('|'), 'gi');
  const claims = [...normalized.matchAll(authority)];
  return claims.every((claim, index) => {
    const prior = normalized.slice(0, claim.index);
    const before = prior.slice(Math.max(prior.lastIndexOf('.'), prior.lastIndexOf('!'), prior.lastIndexOf('?'), prior.lastIndexOf('\n')) + 1);
    const tail = normalized.slice(claim.index + claim[0].length, claims[index + 1]?.index);
    // Negation must describe this claim directly, never a different proposition later
    // in a compound sentence ("optimal and not a bad choice" is still an optimum claim).
    const after = tail.split(/[.!?\n]/, 1)[0];
    if (/(?:\bEV\b|기대(?:값|수익)|expected\s+value)/i.test(claim[0]) && /[+−-]?\d+(?:\.\d+)?/.test(before + after)) return false;
    if (/(?:not\s+(?:(?:a|an|the)\s+)?|no\s+|unverified\s+|검증되지\s*않은\s*)$/i.test(before)) return true;
    const negative = /^(?:\s*(?:결과|기준|수치|answer|result))?\s*(?:(?:이라고|이라는|라고|으로|[이가은는을를의])\s*)?(?:아닙니다|아니다|아님|아니며|근거(?:가|는)?\s*없(?:습니다|다|음)|없(?:습니다|다|음)|아닌\s*(?:참고|기준)|검증한\s*것이\s*아닙니다|검증하지\s*않(?:습니다|음)|(?:으로\s*)?볼\s*수\s*없(?:습니다|다|음)|(?:으로\s*)?단정할\s*수\s*없(?:습니다|다|음)|확정할\s*수\s*없(?:습니다|다|음)|(?:수치를?\s*)?(?:제공하지|제공되지|계산하지|산출하지|추정하지)\s*않(?:았습니다|습니다|음)|(?:계산|산출)할\s*수\s*없(?:습니다|다|음)|(?:is\s+not|isn't|is\s+unavailable)\b|not\s+verified\b|unverified\b)/i;
    if (!negative.test(after)) return false;
    return !/(?:아니(?:라는|라고|란)|아닌\s*것|not\s+unverified)/i.test(after);
  });
}
