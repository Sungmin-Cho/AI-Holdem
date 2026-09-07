import { referenceQuality } from '../../shared/reference.js';

export const STUDY_MODES = Object.freeze({ free: '자유 연습', leak: '연습 후보', daily: '오늘 복습', 'mistake-review': '기준표와 다른 선택 복습', assessment: '새 문제 평가', retest: '지연 재평가' });
const ACTIONS = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', bet: '벳' };
const GRADES = { preferred: '기준표 주력 선택', mixed: '기준표 허용 선택', 'low-frequency': '기준표 저빈도 허용 선택', 'off-policy': '기준표와 다른 선택' };
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = (value) => number(value) !== null && value <= 1 ? `${Math.round(value * 100)}%` : '측정 자료 없음';
const verified = (source) => referenceQuality(source).quality === 'heuristic-reference';
const hand = (value) => /^[2-9TJQKA]{2}[so]?$/.test(value ?? '') ? value : '손패 정보 없음';
const position = (value) => ['utg', 'hj', 'co', 'btn', 'sb', 'bb'].includes(String(value).toLowerCase()) ? value.toUpperCase() : '위치 정보 없음';

export function formatSource(source) {
  return verified(source)
    ? `로컬 프리플롭 기준표 v${source.version} · 휴리스틱 참고 자료. 솔버 검증 자료가 아니며 실제 포커 실력을 측정하지 않습니다.`
    : '출처 근거를 확인할 수 없어 기준표 점수와 추천을 표시하지 않습니다.';
}
export function formatStudyError(error = {}) {
  const messages = {
    UNAUTHORIZED: '학습실 접속 권한이 만료되었습니다. 새 게임 또는 독립 학습실에서 새 링크를 열어 주세요.',
    NO_SESSION: '시작한 연습이 없습니다. 모드를 선택하고 연습 시작을 눌러 주세요.',
    STALE_QUESTION: '문항 상태가 바뀌었습니다. 현재 상태를 확인해 이어서 진행하세요.',
    PENDING_UNRESOLVED: '이전 답안의 저장을 마무리하지 못했습니다. 상태 확인 또는 같은 답안 다시 확인을 눌러 주세요.',
    SOURCE_CHANGED: '이전 문항의 기준표 버전을 사용할 수 없습니다. 현재 상태를 확인한 뒤 지원되는 새 연습을 시작하세요.',
    SOURCE_UNVERIFIED: '이전 문항의 출처를 확인할 수 없습니다. 지원되는 새 연습을 시작하세요.',
    RETEST_NOT_DUE: '재평가는 마지막 완료로부터 24시간 뒤에 열립니다. 표시된 가능 시각을 확인하세요.',
    INCOMPLETE_ASSESSMENT: '새 문제 평가의 모든 문항을 완료한 뒤 재평가할 수 있습니다.',
    FUTURE_EVIDENCE: '기록 시각의 근거가 유효하지 않아 점수를 표시하지 않습니다.',
    FUTURE_OR_INCONSISTENT_EVIDENCE: '기록 시각 또는 순서의 근거가 유효하지 않아 평가를 사용할 수 없습니다.',
    INCONSISTENT_RUN: '평가 기록이 일치하지 않아 점수를 표시하지 않습니다.',
    INCOMPLETE_RUN: '평가가 아직 완료되지 않았습니다.',
    LEGACY_EVIDENCE: '추적 시작 이전의 기록으로는 이 평가를 확인할 수 없습니다.',
    UNSUPPORTED_SPOT: '이 상황은 현재 기준표에서 지원하지 않습니다. 지정 상황을 해제했으니 자유 연습을 다시 시작하세요.',
    UNSUPPORTED_HAND: '이 손패는 현재 기준표에서 지원하지 않습니다. 지정 상황을 해제했으니 자유 연습을 다시 시작하세요.',
    INVALID_DRILL_LIMIT: '문항 요청이 올바르지 않습니다. 지원되는 연습 모드로 다시 시작하세요.',
    USAGE: '시작 요청의 형식이 올바르지 않습니다. 연습 모드를 다시 선택해 시작하세요.',
    BAD_JSON: '요청 형식이 올바르지 않아 시작하지 않았습니다. 연습 시작을 다시 눌러 주세요.',
    PAYLOAD_TOO_LARGE: '요청이 너무 커서 시작하지 않았습니다. 기본 연습 모드로 다시 시작하세요.',
    INVALID_DRILL_ANSWER: '제공된 액션과 크기 중에서 다시 선택하세요.',
    INVALID_DRILL_MODE: '지원되는 연습 모드를 선택하세요.',
  };
  return messages[error.code] ?? '요청을 완료하지 못했습니다. 연결을 확인하고 현재 상태 확인을 눌러 주세요.';
}
export function formatQuestion(question) {
  const prompt = question?.prompt ?? {};
  const history = Array.isArray(prompt.actionHistory) && prompt.actionHistory.length
    ? prompt.actionHistory.map((action) => ACTIONS[action] ?? '액션').join(' → ') : '선행 레이즈 없음';
  const actions = [];
  for (const offered of prompt.legalActions ?? []) {
    if (typeof offered !== 'string') continue;
    const match = /^(fold|check|call|raise|bet)(?::([0-9]+(?:\.[0-9]+)?))?$/.exec(offered);
    if (!match) continue;
    const [, action, size] = match;
    if ((action === 'raise' || action === 'bet') !== Boolean(size)) continue;
    const sizeBb = size === undefined ? undefined : Number(size);
    if (sizeBb !== undefined && (!Number.isFinite(sizeBb) || sizeBb <= 0)) continue;
    actions.push({ action, ...(sizeBb !== undefined ? { sizeBb } : {}), label: `${ACTIONS[action]}${sizeBb !== undefined ? ` · 총액 ${sizeBb}BB` : ''}` });
  }
  return { title: `${position(prompt.position)} · ${hand(prompt.handClass)}`,
    context: `${number(prompt.stackBb) ?? '—'}BB · ${history}`, actions };
}
export function formatFeedback(result, source) {
  if (!result) return null;
  if (!verified(source) || result.status !== 'reference-adherence' || !GRADES[result.grade]) {
    return { title: '채점 근거 확인 불가', detail: '확인된 기준표 자료가 없어 이 답안을 점수로 표시하지 않습니다.', actions: [] };
  }
  return { title: GRADES[result.grade], detail: `선택한 액션의 기준 빈도 ${percent(result.frequency)}. 한 번의 선택은 전체 빈도 일치도나 실제 실력을 뜻하지 않습니다.`,
    actions: (result.recommended ?? []).filter((row) => ACTIONS[row.action]).map((row) => `${ACTIONS[row.action]}${number(row.sizeBb) !== null ? ` ${row.sizeBb}BB` : ''} · ${percent(row.frequency)}`) };
}
export function formatFeedbackStep(current) {
  // Completion comes only from the current server DTO. Matching local counts do
  // not authorize terminal copy because an answer may still be unsettled.
  if (current?.done === true) return {
    title: '마지막 답안을 확인하세요',
    context: '마지막 답안을 확인한 뒤 연습을 마무리해 결과를 확인합니다.',
    nextLabel: '연습 마무리',
  };
  return {
    title: '이전 답안을 확인하세요',
    context: '확인 후 다음 문제를 눌러 이어서 진행합니다.',
    nextLabel: '다음 문제',
  };
}
function originSummary(origin, allowed) {
  const overall = origin?.overall ?? {};
  const supported = count(overall.supportedDecisions);
  const coverage = origin?.coverage ?? overall;
  const calibration = origin?.calibration ?? {};
  const eligible = count(calibration.eligibleObservations);
  return {
    rate: allowed && supported > 0 ? percent(overall.allowedActionRate) : '측정 자료 없음',
    samples: `${supported}개 지원 표본 · 표본 가중치 ${number(overall.sampleWeight) ?? 0}`,
    coverage: `${count(coverage.supportedDecisions)} / ${count(coverage.evaluatedDecisions)}개 결정이 기준표 범위에 포함 · 지원 제외 ${count(coverage.unsupportedDecisions)}개 · 출처 미검증 ${count(coverage.unverifiedDecisions)}개(지원 제외와 중복 가능)`,
    calibration: allowed && eligible > 0 && !calibration.reason
      ? `${percent(calibration.distributionAgreement)} · ${eligible}개 관측`
      : (calibration.reason === 'insufficient-observations' ? '표본 부족 · 같은 상황에서 20회 이상 필요' : '빈도 관측 자료 없음'),
    candidates: Array.isArray(origin?.candidates) ? origin.candidates.slice(0, 5).map((row) => `${position(row.spotKey?.split('-')[2])} · ${hand(row.handClass)} 연습 후보`) : [],
  };
}
function runSummary(run, allowed) {
  const valid = allowed && verified(run.sourceIdentity) && run.complete === true && !run.reason;
  const retest = run.retest ?? run.retestAvailability ?? {};
  return { id: run.id, assessmentId: run.assessmentId, title: STUDY_MODES[run.mode] ?? '새 문제 평가',
    rate: valid ? percent(run.result?.allowedActionRate) : '측정 자료 없음',
    samples: `${count(run.result?.total)} / ${count(run.total)}문항`,
    status: valid ? '완료 · 기준표 참고 측정치' : formatStudyError({ code: run.reason ?? 'INCOMPLETE_RUN' }),
    canRetest: valid && retest.eligible === true,
    availableAt: typeof retest.nextAvailableAt === 'string' && Number.isFinite(Date.parse(retest.nextAvailableAt))
      ? new Date(retest.nextAvailableAt).toLocaleString('ko-KR') : null,
  };
}
export function formatSummary(summary = {}) {
  const source = summary.source?.identity ?? summary.source;
  const allowed = verified(source);
  const goal = summary.goal;
  const goalAllowed = goal && (verified(goal.sourceIdentity) || goal.origin === 'default');
  return {
    source: formatSource(source), game: originSummary(summary.game, allowed), practice: originSummary(summary.practice, allowed),
    due: `${count(summary.bank?.dueCount)}개 오늘 복습 · 전체 ${count(summary.bank?.totalCount)}개`,
    goal: goalAllowed ? `${goal.origin === 'game' ? '게임 기록' : goal.origin === 'practice' ? '연습 기록' : '기본 지원 상황'}에서 정한 목표: ${position(goal.spotKey?.split('-')[2])} · ${hand(goal.handClass)}의 기준 빈도 확인` : '확인된 근거가 없어 목표를 준비하지 못했습니다.',
    assessments: (summary.assessments ?? []).map((run) => runSummary(run, allowed)),
    retests: (summary.retests ?? []).map((run) => runSummary(run, allowed && (summary.assessments ?? []).some((base) => base.id === run.assessmentId && base.complete && !base.reason && verified(base.sourceIdentity) && JSON.stringify(base.sourceIdentity) === JSON.stringify(run.sourceIdentity)))),
  };
}
export function drillRequest(pathname, authToken, { method = 'GET', body, signal } = {}) {
  const headers = { 'x-drill-token': authToken };
  if (body) headers['Content-Type'] = 'application/json';
  return [pathname, { method, headers, signal, body: body ? JSON.stringify(body) : undefined }];
}
export function readStudyEntry(location) {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  return { token: fragment.get('token') || query.get('token'),
    mode: Object.hasOwn(STUDY_MODES, query.get('mode')) ? query.get('mode') : 'free',
    spotKey: /^[a-z0-9-]{1,100}$/.test(query.get('spotKey') ?? '') ? query.get('spotKey') : null,
    handClass: /^[2-9TJQKA]{2}[so]?$/.test(query.get('handClass') ?? '') ? query.get('handClass') : null };
}
