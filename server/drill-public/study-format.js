import { referenceQuality, matchReferenceActionFor } from '../../shared/reference.js';
import { PREFLOP_ORDERS, PREFLOP_ORDERS_V3, parsePreflopKey, parsePreflopKeyV3 } from '../../shared/preflop-key.js';
import { handClassParts } from '../public/card-render.js';

export const STUDY_MODES = Object.freeze({ free: '자유 연습', leak: '연습 후보', daily: '오늘 복습', 'mistake-review': '기준표와 다른 선택 복습', assessment: '새 문제 평가', retest: '지연 재평가', transfer: '일반화 연습' });
const ACTIONS = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈', bet: '벳' };
const GRADES = { preferred: '기준표 주력 선택', mixed: '기준표 허용 선택', 'low-frequency': '기준표 저빈도 허용 선택', 'off-policy': '기준표와 다른 선택' };
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = (value) => number(value) !== null && value <= 1 ? `${Math.round(value * 100)}%` : '측정 자료 없음';
const verified = (source) => referenceQuality(source).quality === 'heuristic-reference';
const hand = (value) => /^[2-9TJQKA]{2}[so]?$/.test(value ?? '') ? value : '손패 정보 없음';
const position = (value) => ['utg', 'utg1', 'utg2', 'lj', 'hj', 'co', 'btn', 'sb', 'bb'].includes(String(value).toLowerCase()) ? value.toUpperCase() : '위치 정보 없음';

/** One line per mode under the picker: what the mode draws from, and when it
 * can be empty or closed. Mirrors training/drill-generator.js and drill-cli.js. */
export const STUDY_MODE_HELP = Object.freeze({
  free: '기준표가 다루는 상황과 손패를 무작위로 10문항 풉니다. 게임에서 연 상황이 있으면 그 상황으로 풉니다.',
  leak: '게임 기록에서 기준표와 자주 달랐던 상황(연습 후보)을 중심으로 풉니다. 후보가 없으면 문항이 없습니다.',
  daily: '기준표와 다른 선택으로 모인 복습 항목 가운데 복습 시각이 된 것만 풉니다.',
  'mistake-review': '기준표와 다른 선택으로 모인 복습 항목을 복습 시각과 상관없이 다시 풉니다.',
  assessment: '추적된 기록에서 아직 답하지 않은 상황 10문항으로 평가합니다. 최근 7일 안에 차트를 본 상황은 빼고, 추적 이전의 노출은 알 수 없습니다.',
  retest: '완료한 새 문제 평가를 24시간 뒤 같은 문항으로 다시 풉니다.',
  transfer: '틀렸던 손패 바로 옆(같은 상황의 이웃 손패) 가운데 아직 답하지 않은 것을 풉니다. 외운 답이 아니라 원리를 확인합니다.',
});

/** Why a mode may give no questions or refuse to start, from the summary. */
export function modeAvailability(mode, formatted) {
  if (!formatted) return '';
  if (mode === 'daily' || mode === 'mistake-review') return formatted.due;
  if (mode !== 'retest') return '';
  return [retestAvailability(formatted), enrollmentRetestHint(formatted.enrollment)].filter(Boolean).join(' ');
}
function retestAvailability(formatted) {
  // "연습 시작" retests the most recent completed assessment (drill-cli.js);
  // an older one is retested from its own card below.
  const runs = formatted.assessments ?? [];
  const latest = [...runs].reverse().find((run) => run.complete);
  // The summary carries the latest 100 runs only (study-summary.js).
  if (!latest && runs.length >= 100) return '최근 100건에 완료한 평가가 없습니다. 연습 시작을 누르면 이전 완료 평가로 재평가할 수 있는지 확인합니다.';
  if (!latest) return '완료한 새 문제 평가가 없어 아직 시작할 수 없습니다.';
  if (latest.canRetest) return '가장 최근 평가를 지금 재평가할 수 있습니다.';
  if (latest.availableAt) return `가장 최근 평가의 재평가 가능 시각: ${latest.availableAt} · 다른 평가는 아래 카드에서 재평가합니다.`;
  return '가장 최근 평가는 재평가할 수 없습니다. 다른 평가는 아래 카드에서 재평가합니다.';
}
function enrollmentRetestHint(enrollment) {
  if (enrollment?.status !== 'active') return '';
  return enrollment.postOpen
    ? "학습 효과 평가의 지연 재평가는 아래 '등록 기준' 카드에서 시작하세요. 연습 시작은 가장 최근 평가를 재평가합니다."
    : `학습 효과 평가 진행 중: 등록 기준 평가의 지연 재평가는 사후 기간(${whenOf(enrollment.postOpensAt)}부터)에 합니다.`;
}

export function formatSource(source) {
  return verified(source)
    ? `로컬 프리플롭 기준표 v${source.version} · 휴리스틱 참고 자료. 솔버 검증 자료가 아니며 실제 포커 실력을 측정하지 않습니다.`
    : '출처 근거를 확인할 수 없어 기준표 점수와 추천을 표시하지 않습니다.';
}
/** The short per-question source tag; the full statement sits once at the foot. */
export function formatSourceShort(source) {
  return verified(source) ? `기준표 v${source.version} · 휴리스틱 참고` : '출처 확인 불가 · 점수 미표시';
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
    UNFINISHED_RUN: '진행 중인 연습이 있거나 상태를 확인할 수 없어 새 연습을 시작하지 않았습니다. 다른 창에서 시작한 연습일 수 있습니다. 표시된 연습을 끝낸 뒤 다시 시도하세요. 연습 시작을 누르면 진행 중인 연습을 버리고 새로 시작합니다.',
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
  const v3 = parsePreflopKeyV3(prompt.spotKey);
  if (v3) {
    const villain = position(v3.openerPosition);
    const line = { 'rfi-unopened': '앞 좌석 모두 폴드', 'vs-single-raise': `${villain} 오픈 대응`, 'vs-3bet': `내 오픈에 ${villain} 3벳`,
      push: '푸시/폴드(올인 또는 폴드)', 'vs-shove': `${villain} 올인 대응` }[v3.context];
    return { title: `${position(prompt.position)} · ${hand(prompt.handClass)}`, context: `${v3.seated}인 · ${line} · ${v3.stackBb}BB`, actions };
  }
  return { title: `${position(prompt.position)} · ${hand(prompt.handClass)}`,
    context: `${prompt.seated ? `${prompt.seated}인 · ` : ''}${prompt.openerPosition ? `${position(prompt.openerPosition)} 오픈 대응 · ` : ''}${number(prompt.stackBb) ?? '—'}BB · ${history}`, actions };
}
/** Position diagram model: the seats of the reference table in preflop order,
 * the hero, the opener, and the seats known to have folded before the hero.
 * Only what the spot states — an unknown table size or opener draws nothing. */
export function spotDiagram(prompt = {}) {
  const v3 = parsePreflopKeyV3(prompt.spotKey);
  if (v3) {
    const order = PREFLOP_ORDERS_V3[v3.seated];
    const heroAt = order.indexOf(v3.position);
    const villainAt = v3.openerPosition ? order.indexOf(v3.openerPosition) : -1;
    // Every v3 line folds around the hero and the one raiser (3-bet: after the hero).
    const seats = order.map((pos, index) => ({ position: pos,
      role: index === heroAt ? 'hero' : index === villainAt ? 'opener' : v3.context === 'vs-3bet' || index < heroAt ? 'folded' : 'waiting' }));
    const what = { 'rfi-unopened': ' · 앞 좌석 모두 폴드', push: ' · 앞 좌석 모두 폴드', 'vs-single-raise': ` · ${v3.openerPosition} 오픈`,
      'vs-3bet': ` · ${v3.openerPosition} 3벳`, 'vs-shove': ` · ${v3.openerPosition} 올인` }[v3.context];
    return { seated: v3.seated, hero: v3.position, opener: v3.openerPosition, seats, label: `${v3.seated}인 테이블 · 내 위치 ${v3.position}${what}` };
  }
  const parsed = parsePreflopKey(prompt.spotKey);
  const seated = Number.isSafeInteger(prompt.seated) ? prompt.seated : parsed?.seated;
  const order = PREFLOP_ORDERS[seated];
  const hero = String(prompt.position ?? parsed?.position ?? '').toUpperCase();
  if (!order || !order.includes(hero)) return null;
  const openerRaw = prompt.openerPosition ?? parsed?.openerPosition ?? null;
  const opener = openerRaw ? String(openerRaw).toUpperCase() : null;
  const heroAt = order.indexOf(hero);
  const openerAt = opener ? order.indexOf(opener) : -1;
  if (opener && (openerAt < 0 || openerAt >= heroAt)) return null;
  const history = Array.isArray(prompt.actionHistory) ? prompt.actionHistory : [];
  // Folds before the hero are known when no one raised, or when the opener is named.
  const foldsKnown = opener ? true : history.length === 0;
  const seats = order.map((position, index) => ({
    position,
    role: index === heroAt ? 'hero' : index === openerAt ? 'opener' : index < heroAt && foldsKnown ? 'folded' : 'waiting',
  }));
  const label = `${seated}인 테이블 · 내 위치 ${hero}${opener ? ` · ${opener} 오픈` : history.length ? ' · 앞에서 레이즈' : ' · 앞 좌석 모두 폴드'}`;
  return { seated, hero, opener, seats, label };
}

/** Hand-class cards: two ranks and whether they share a suit. No suit is made up. */
export function handCards(prompt = {}) {
  const parts = handClassParts(prompt.handClass);
  if (!parts) return null;
  return { ranks: parts.ranks, kind: parts.kind, label: parts.label, name: `${parts.ranks.join(' ')} ${parts.label}` };
}

/** Reference frequency bars for the feedback, with the viewer's own choice marked
 * when this page still knows it (the server does not return the choice). */
export function feedbackBars(result, source, chosen) {
  if (!result || !verified(source) || result.status !== 'reference-adherence' || !GRADES[result.grade]) return { rows: [], mineLabel: null };
  const rows = (result.recommended ?? []).filter((row) => ACTIONS[row.action] && number(row.frequency) !== null && row.frequency <= 1);
  const known = Boolean(chosen && result.questionId && chosen.questionId === result.questionId && ACTIONS[chosen.action]);
  // The same matcher the evaluator used, so the mark sits on the graded row.
  const mine = known ? matchReferenceActionFor(source, rows, { action: chosen.action, ...(chosen.sizeBb !== undefined ? { sizeBb: chosen.sizeBb } : {}) }) : null;
  return {
    rows: rows.map((row) => ({
      label: `${ACTIONS[row.action]}${number(row.sizeBb) !== null ? ` ${row.sizeBb}BB` : ''}`,
      percent: percent(row.frequency),
      width: Math.round(row.frequency * 1000) / 10,
      mine: row === mine,
    })),
    mineLabel: known ? `내 선택: ${ACTIONS[chosen.action]}${chosen.sizeBb !== undefined ? ` 총액 ${chosen.sizeBb}BB` : ''}` : null,
  };
}

/** Run progress for the bar: answered of total, or null before a run. */
export function runProgress(current) {
  if (!current?.sessionId || !Number.isSafeInteger(current.count) || current.count <= 0) return null;
  const index = Number.isSafeInteger(current.index) ? Math.max(0, Math.min(current.index, current.count)) : 0;
  return { index, count: current.count, width: Math.round((index / current.count) * 1000) / 10 };
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
    coverage: Object.hasOwn(coverage,'exactComparableDecisions')
      ? `${count(coverage.evaluatedDecisions)}개 결정 · 참고 가능 ${count(coverage.referenceAvailableDecisions)}개 · 직접 비교 ${count(coverage.exactComparableDecisions)}개 · 힌트 보조 ${count(coverage.assistedDecisions)}개 · 투영 ${count(coverage.projectedReferenceDecisions)}개 · 선택 비교 불가 ${count(coverage.comparisonUnavailableDecisions)}개 · 지원 제외 ${count(coverage.unsupportedDecisions)}개 · 출처 미검증 ${count(coverage.unverifiedDecisions)}개`
      : `${count(coverage.supportedDecisions)} / ${count(coverage.evaluatedDecisions)}개 결정이 기준표 범위에 포함 · 지원 제외 ${count(coverage.unsupportedDecisions)}개 · 출처 미검증 ${count(coverage.unverifiedDecisions)}개(지원 제외와 중복 가능)`,
    calibration: allowed && eligible > 0 && !calibration.reason
      ? `${percent(calibration.distributionAgreement)} · ${eligible}개 관측`
      : (calibration.reason === 'insufficient-observations' ? '표본 부족 · 같은 상황에서 20회 이상 필요' : '빈도 관측 자료 없음'),
    candidates: Array.isArray(origin?.candidates) ? origin.candidates.slice(0, 5).map((row) => `${position(row.spotKey?.split('-')[2])} · ${hand(row.handClass)} 연습 후보`) : [],
  };
}
function runSummary(run, allowed) {
  const valid = allowed && verified(run.sourceIdentity) && run.complete === true && !run.reason;
  const retest = run.retest ?? run.retestAvailability ?? {};
  return { id: run.id, assessmentId: run.assessmentId, complete: run.complete === true, title: STUDY_MODES[run.mode] ?? '새 문제 평가',
    rate: valid ? percent(run.result?.allowedActionRate) : '측정 자료 없음',
    // What always folding would have scored on the same questions.
    baseline: valid && number(run.result?.foldBaselineRate) !== null ? `항상 폴드 기준선 ${percent(run.result.foldBaselineRate)}` : null,
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
  const enrollment = enrollmentView(summary.enrollment);
  const assessments = (summary.assessments ?? []).map((run) => runSummary(run, allowed));
  const retests = (summary.retests ?? []).map((run) => runSummary(run, allowed && (summary.assessments ?? []).some((base) => base.id === run.assessmentId && base.complete && !base.reason && verified(base.sourceIdentity) && JSON.stringify(base.sourceIdentity) === JSON.stringify(run.sourceIdentity))));
  return {
    source: formatSource(source), sourceShort: formatSourceShort(source), game: originSummary(summary.game, allowed), practice: originSummary(summary.practice, allowed),
    due: `${count(summary.bank?.dueCount)}개 오늘 복습 · 전체 ${count(summary.bank?.totalCount)}개${count(summary.bank?.graduatedCount) ? ` · 졸업 ${count(summary.bank.graduatedCount)}개` : ''}`,
    goal: goalAllowed ? `${goal.origin === 'game' ? '게임 기록' : goal.origin === 'practice' ? '연습 기록' : '기본 지원 상황'}에서 정한 목표: ${position(goal.spotKey?.split('-')[2])} · ${hand(goal.handClass)}의 기준 빈도 확인` : '확인된 근거가 없어 목표를 준비하지 못했습니다.',
    assessments, retests,
    cards: formatCards(summary, assessments, retests, enrollment),
    enrollment, enrollmentLine: enrollmentLine(enrollment),
  };
}
// ---- Learning-effect enrollment on the cards (issue 335) ---------------------
const CIRCLED = ['①', '②', '③', '④', '⑤'];
/** One formatter for every time shown on the cards; null when it is not an instant. */
export function formatWhen(iso) {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return null;
  return new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function whenOf(iso) { return formatWhen(iso) ?? '시각 확인 불가'; }
const circled = (slot) => CIRCLED[slot - 1] ?? String(slot);
const SLOT_STATUS = { complete: '완료', UNANSWERED: '아직 확인된 응답 없음', INCOMPLETE_RUN: '미완료', BASELINE_INCOMPLETE: '기준 평가 미완료' };
const slotStatusText = (status) => SLOT_STATUS[status] ?? '확인 불가';

/** The server's enrollment slots as the page may use them: null (hidden), an
 * unavailable marker, or a shape-checked active view. A key that is absent
 * (an older service) claims nothing. */
export function enrollmentView(raw) {
  if (raw === undefined || raw === null) return null;
  if (!plain(raw) || raw.status !== 'active') return { status: 'unavailable' };
  const slots = (rows, keys) => Array.isArray(rows) && rows.every((row) => plain(row) && Number.isSafeInteger(row.slot) && row.slot > 0
    && keys.every((key) => row[key] === null || typeof row[key] === 'string') && typeof row.status === 'string');
  if (isoTime(raw.postOpensAt) === null || isoTime(raw.postClosesAt) === null || !slots(raw.baselines, ['runId']) || !slots(raw.post, ['runId'])
    || !slots(raw.retention, ['runId', 'assessmentId']) || raw.retention.some((row) => typeof row.current !== 'boolean')) return { status: 'unavailable' };
  return { status: 'active', postOpen: raw.postOpen === true, postOpensAt: raw.postOpensAt, postClosesAt: raw.postClosesAt,
    baselines: raw.baselines.map((row) => ({ slot: row.slot, runId: row.runId, status: row.status })),
    post: raw.post.map((row) => ({ slot: row.slot, runId: row.runId, status: row.status })),
    retention: raw.retention.map((row) => ({ slot: row.slot, assessmentId: row.assessmentId, runId: row.runId, status: row.status, current: row.current })) };
}
/** The line above the cards, or null when nothing is to be said. */
function enrollmentLine(enrollment) {
  if (!enrollment) return null;
  if (enrollment.status !== 'active') return '학습 효과 평가 등록 정보를 확인하지 못해 등록 기준 평가를 표시하지 않습니다.';
  return `학습 효과 평가 진행 중 · 사후 기간 ${whenOf(enrollment.postOpensAt)} ~ ${whenOf(enrollment.postClosesAt)} · 기준 평가마다 지연 재평가 1회`;
}
/** Badge and advance note of one card (first matching row of the design table).
 * Units are kept apart: slot choice, item exclusion and exposure are not mixed. */
export function cardEnrollment(card, enrollment) {
  const none = { badge: null, note: null };
  if (enrollment?.status !== 'active' || !card) return none;
  if (card.kind === 'retest') {
    const kept = enrollment.retention.find((row) => row.runId !== null && row.runId === card.id);
    return kept ? { badge: `등록 기준 ${circled(kept.slot)} 지연 재평가`, note: '이번 등록의 지연 재평가 슬롯으로 선택된 실행입니다.' } : none;
  }
  const open = whenOf(enrollment.postOpensAt);
  const close = whenOf(enrollment.postClosesAt);
  const base = enrollment.baselines.find((row) => row.runId !== null && row.runId === card.id);
  if (base) {
    const badge = `등록 기준 ${circled(base.slot)}`;
    const kept = enrollment.retention.find((row) => row.slot === base.slot);
    if (!enrollment.postOpen) {
      return { badge, note: `학습 효과 평가의 기준 평가입니다. 지연 재평가는 사후 기간(${open} ~ ${close})에 하세요. 그 전에 재평가해 답한 문항은 지연 유지 측정에서 제외됩니다.` };
    }
    if (base.status !== 'complete') {
      return { badge, note: '이 기준 평가는 사후 기간이 시작되기 전에 완료되지 않아 지연 유지 측정에 쓰이지 않습니다. 재평가는 연습으로만 기록됩니다.' };
    }
    if (kept?.status === 'NOT_STARTED') {
      return { badge, note: `이번 등록의 지연 재평가 슬롯은 사후 기간에 이 평가를 처음 재평가한 실행으로 정해집니다. 시작하면 ${close} 전에 끝까지 풀어 주세요.` };
    }
    if (kept?.current === true) return { badge, note: '이 기준의 지연 재평가가 진행 중입니다. 이어서 끝까지 풀어 주세요.' };
    return { badge, note: `이 기준의 지연 재평가 슬롯은 이미 정해졌습니다(${slotStatusText(kept?.status)}). 다시 재평가해도 이번 등록의 슬롯으로 선택되지 않습니다.` };
  }
  const post = enrollment.post.find((row) => row.runId !== null && row.runId === card.id);
  if (post) return { badge: `사후 평가 ${circled(post.slot)}`, note: '학습 효과 평가의 사후 평가입니다. 이 평가의 재평가는 이번 등록의 지연 재평가 슬롯으로 선택되지 않습니다.' };
  return { badge: null, note: '이번 등록의 기준 평가가 아닙니다. 재평가해도 지연 재평가 슬롯으로 선택되지 않습니다.' };
}
/** New-problem cards newest first (by start), then the delayed retests newest
 * first; an invalid start time sorts last, ties keep the summary order. */
function formatCards(summary, assessments, retests, enrollment) {
  const raws = summary.assessments ?? [];
  const startedAtOf = new Map(raws.map((run) => [run.id, run.startedAt]));
  const newest = (entries) => entries.map((entry, index) => ({ entry, index, time: isoTime(entry.raw.startedAt) }))
    .sort((a, b) => (a.time === null) - (b.time === null) || (b.time ?? 0) - (a.time ?? 0) || a.index - b.index).map(({ entry }) => entry);
  const list = [
    ...newest(raws.map((raw, index) => ({ raw, view: assessments[index], kind: 'assessment' }))),
    ...newest((summary.retests ?? []).map((raw, index) => ({ raw, view: retests[index], kind: 'retest' }))),
  ];
  const seen = new Set();
  const cards = [];
  for (const { raw, view, kind } of list) {
    if (seen.has(view.id)) continue;
    seen.add(view.id);
    const startedWhen = formatWhen(raw.startedAt);
    const targetWhen = kind === 'retest' ? formatWhen(startedAtOf.get(raw.assessmentId)) : null;
    const card = { key: view.id, kind, id: view.id, assessmentId: view.assessmentId, title: view.title, rate: view.rate, samples: view.samples,
      status: view.status, baseline: view.baseline, availableAt: view.availableAt, canRetest: kind === 'assessment' && view.canRetest,
      meta: [startedWhen ? `${startedWhen} 시작` : null, verified(raw.sourceIdentity) ? `기준표 v${raw.sourceIdentity.version}` : '출처 확인 불가'].filter(Boolean).join(' · '),
      relation: kind === 'retest' ? (targetWhen ? `${targetWhen} 평가의 재평가` : '이전 평가의 재평가') : null };
    cards.push({ ...card, ...cardEnrollment(card, enrollment) });
  }
  return cards;
}

/** The first enrollment boundary strictly after `nowMs`, or null. */
export function nextEnrollmentBoundary(enrollment, nowMs) {
  const view = enrollmentView(enrollment);
  if (view?.status !== 'active') return null;
  const later = [view.postOpensAt, view.postClosesAt].map(isoTime).filter((time) => time > nowMs);
  return later.length ? Math.min(...later) : null;
}
/** Did a boundary pass between `sinceMs` (when the summary was received) and `nowMs`? */
export function enrollmentBoundaryCrossed(enrollment, sinceMs, nowMs) {
  const view = enrollmentView(enrollment);
  if (view?.status !== 'active') return false;
  return [view.postOpensAt, view.postClosesAt].map(isoTime).some((time) => time > sinceMs && time <= nowMs);
}
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A setTimeout delay toward a boundary; beyond the timer's limit it re-arms in pieces. */
export const boundaryDelay = (boundaryMs, nowMs) => Math.min(Math.max(0, boundaryMs - nowMs), MAX_TIMER_MS);
export const ENROLLMENT_CHANGED_NOTICE = '학습 효과 평가 일정이 바뀌어 안내를 새로 고쳤습니다. 다시 확인하고 시작하세요.';

// ---- Next step (coaching-quality design decision 4) -------------------------
// Everything below reads the raw /api/summary counts and identities, never the
// formatted strings, and only describes an action: starting one stays an
// explicit click that goes through createStudyController.
const KEY_RE = /^[a-z0-9-]{1,100}$/;
const HAND_RE = /^[2-9TJQKA]{2}[so]?$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rawCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
/** A copy limited to the three identity fields, only when it is a known source. */
function knownSource(value) {
  if (!plain(value) || !verified(value)) return null;
  return { id: value.id, version: value.version, contentSha256: value.contentSha256 };
}
const sameIdentity = (a, b) => Boolean(a && b) && a.id === b.id && a.version === b.version && a.contentSha256 === b.contentSha256;
/** The reference version a spot key belongs to (v1 keys carry no suffix). */
export function spotKeyVersion(spotKey) {
  return typeof spotKey === 'string' ? (spotKey.endsWith('-v3') ? '3.0.0' : spotKey.endsWith('-v2') ? '2.0.0' : '1.0.0') : null;
}
/** Epoch ms of a canonical ISO-8601 instant (what the server writes with
 * toISOString), else null. Date.parse alone accepts loose strings and numbers. */
function isoTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
function availableAt(retest) {
  return typeof retest?.nextAvailableAt === 'string' && Number.isFinite(Date.parse(retest.nextAvailableAt))
    ? new Date(retest.nextAvailableAt).toLocaleString('ko-KR') : null;
}
/** Sparse direct coverage of the game record: how many evaluated decisions were
 * compared straight with the reference. Unknown or nonsensical counts claim nothing. */
export function coverageGuidance(summary) {
  const coverage = summary?.game?.coverage;
  if (!plain(coverage) || !Object.hasOwn(coverage, 'exactComparableDecisions')) return null;
  const evaluated = rawCount(coverage.evaluatedDecisions);
  const exact = rawCount(coverage.exactComparableDecisions);
  if (evaluated === null || exact === null || exact > evaluated) return null;
  const suggestion = '고정 100BB 캐시 트레이닝 게임을 더 하면 기준표와 바로 비교할 수 있는 프리플롭 예시가 늘 수 있습니다. 어떤 상황이 나올지, 비교 가능한 결정이 늘어날지는 보장하지 않으며 실력 향상을 뜻하지도 않습니다.';
  if (evaluated === 0) return { sparse: true, evaluated, exact, suggestion,
    text: '아직 평가된 게임 기록이 없어 기준표와 직접 비교한 결정이 없습니다.' };
  if (exact > 0 && exact * 2 >= evaluated) return null;
  return { sparse: true, evaluated, exact, suggestion,
    text: `게임 기록 ${evaluated}개 결정 중 기준표와 직접 비교한 결정은 ${exact}개입니다. 나머지는 참고만 가능하거나 비교할 수 없어, 게임 기록 수치와 연습 목표는 적은 표본에 의존합니다.` };
}

const NEXT_PRACTICE_NOTE = '연습: 지금 풀어 보는 용도이며 새 문제 평가·지연 재평가처럼 따로 측정하는 실행이 아닙니다.';
const NEXT_RECHECK_NOTE = '시작할 때 서버가 다시 확인하므로 풀 문항이 없을 수도 있습니다.';

/** One suggested next action from the verified summary, or kind "none".
 * Priority: due review, an eligible retest of a completed assessment (explicit
 * id), free practice on a source-matched observed goal, a fresh assessment.
 * Transfer practice is not offered: nothing in the summary proves it has questions. */
export function planNextStep(summary) {
  const source = knownSource(summary?.source?.identity ?? summary?.source);
  const coverage = coverageGuidance(summary);
  const notes = [];
  const done = (plan) => ({ measured: false, mode: null, selectors: null, notes, coverage, ...plan });
  const view = enrollmentView(summary?.enrollment);
  const enrolled = view?.status === 'active' ? view : null;

  // The learning-effect enrollment (issue 335): before the post window the
  // enrolled baselines are not offered for retest; inside it, a baseline whose
  // retention slot is still open comes before everything else.
  const isBaseline = (run) => Boolean(enrolled) && enrolled.baselines.some((row) => row.runId === run.id);
  const measuredSlot = (run) => {
    if (!enrolled?.postOpen) return false;
    const base = enrolled.baselines.find((row) => row.runId === run.id);
    return base?.status === 'complete' && enrolled.retention.some((row) => row.slot === base.slot && row.status === 'NOT_STARTED');
  };
  let candidate = null;
  let measured = null;
  let withheld = false;
  const loopNotes = [];
  for (const run of Array.isArray(summary?.assessments) ? summary.assessments : []) {
    if (!plain(run) || typeof run.id !== 'string' || !run.id || run.mode !== 'assessment' || run.assessmentId !== undefined
      || run.complete !== true || run.reason || !knownSource(run.sourceIdentity)) continue;
    if (isBaseline(run) && !enrolled.postOpen) { withheld = true; continue; }
    if (run.retest?.eligible === false) {
      const when = availableAt(run.retest);
      if (when) loopNotes.push(`재평가 가능 시각: ${when}`);
      continue;
    }
    if (run.retest?.eligible !== true) continue;
    // Only a real completion time can rank the baselines. A malformed one (NaN
    // compares false both ways) would otherwise win; skip it instead of guessing.
    const completed = isoTime(run.completedAt);
    if (completed === null) continue;
    if (!candidate || completed >= candidate.completed) candidate = { run, completed };
    if (measuredSlot(run) && (!measured || completed >= measured.completed)) measured = { run, completed };
  }
  const retestPlan = (pick, detail) => {
    const version = knownSource(pick.run.sourceIdentity).version;
    return done({ kind: 'retest', mode: 'retest', measured: true, selectors: { mode: 'retest', assessmentId: pick.run.id },
      label: '지연 재평가 시작 (측정)', title: '완료한 평가를 같은 문항으로 다시 확인할 수 있습니다',
      detail: detail ?? `기준표 v${version}으로 푼 그 평가의 같은 문항을 다시 풉니다. 측정 실행으로 기록되며, 결과는 같은 평가끼리만 비교합니다. ${STUDY_MODE_HELP.retest}` });
  };
  if (measured) {
    notes.push(...loopNotes);
    return retestPlan(measured, `이번 등록의 지연 재평가 슬롯은 사후 기간에 이 평가를 처음 재평가한 실행으로 정해집니다. 시작하면 ${whenOf(enrolled.postClosesAt)} 전에 끝까지 풀어 주세요.`);
  }

  const due = rawCount(summary?.bank?.dueCount);
  if (source && due > 0) {
    return done({ kind: 'daily', mode: 'daily', selectors: { mode: 'daily', source },
      label: '오늘 복습 시작 (연습)', title: `복습 시각이 된 항목이 ${due}개 있습니다`,
      detail: `복습할 항목이 있어 가장 먼저 제안합니다. ${NEXT_PRACTICE_NOTE} ${NEXT_RECHECK_NOTE}` });
  }

  notes.push(...loopNotes);
  if (withheld) notes.push(`등록 기준 평가의 지연 재평가는 사후 기간(${whenOf(enrolled.postOpensAt)}부터)에 제안합니다.`);
  if (candidate) {
    if (enrolled?.postOpen) notes.push('이 재평가는 이번 등록의 지연 재평가 슬롯으로 선택되지 않습니다.');
    return retestPlan(candidate);
  }

  if (!source) return done({ kind: 'none', title: '다음 단계를 제안할 수 없습니다',
    detail: '기준표 출처를 확인할 수 없어 복습·연습·평가를 제안하지 않습니다. 출처가 확인된 뒤 다시 확인하세요.' });

  const goal = summary?.goal;
  if (plain(goal) && ['game', 'practice'].includes(goal.origin) && sameIdentity(knownSource(goal.sourceIdentity), source)
    && typeof goal.spotKey === 'string' && KEY_RE.test(goal.spotKey) && spotKeyVersion(goal.spotKey) === source.version
    && typeof goal.handClass === 'string' && HAND_RE.test(goal.handClass)) {
    const where = `${position(goal.spotKey.split('-')[2])} · ${hand(goal.handClass)}`;
    return done({ kind: 'practice', mode: 'free', selectors: { mode: 'free', spotKey: goal.spotKey, handClass: goal.handClass, source },
      label: '이 상황 연습하기 (연습)', title: `${where} 상황을 연습해 보세요`,
      detail: `${goal.origin === 'game' ? '게임' : '연습'} 기록에서 기준표와 달랐던 상황입니다. ${NEXT_PRACTICE_NOTE}` });
  }

  return done({ kind: 'assessment', mode: 'assessment', measured: true, selectors: { mode: 'assessment', source },
    label: '새 문제 평가 시작 (측정)', title: '아직 풀지 않은 상황으로 평가해 보세요',
    detail: `${STUDY_MODE_HELP.assessment} 시작하면 측정 실행으로 기록됩니다. 연습이 아니라 기준표와의 일치도를 재는 실행입니다.` });
}

/** A run the user has not finished, in any mode: a question to answer, or a last
 * answer not yet acknowledged. */
export function unfinishedRun(state) {
  const session = state?.session;
  return Boolean(session?.sessionId) && (state.awaitNext === true || session.done !== true);
}
/** Why the next-step action is not startable now, or null. */
export function nextStepGate(state, { authenticated = true } = {}) {
  if (!authenticated) return { code: 'UNAUTHORIZED', text: formatStudyError({ code: 'UNAUTHORIZED' }) };
  if (!plain(state)) return { code: 'LOADING', text: '학습 상태를 확인하고 있습니다…' };
  if (state.busy) return { code: 'BUSY', text: '요청을 확인하고 있습니다. 끝난 뒤 시작할 수 있습니다.' };
  if (state.recovery || state.pending) return { code: 'RECOVERY', text: '이전 요청을 확인한 뒤 시작할 수 있습니다. 현재 상태 확인을 눌러 주세요.' };
  if (state.replacementOnly) return { code: 'REPLACEMENT_ONLY', text: '이전 연습의 출처를 확인할 수 없어 이어갈 수 없습니다. 연습 시작으로 직접 새 연습을 시작하세요.' };
  if (unfinishedRun(state)) return { code: 'UNFINISHED', text: '진행 중인 연습이 있습니다. 끝낸 뒤 다음 단계를 시작할 수 있습니다.' };
  return null;
}
/** The same gate for a card's retest button, with the card's own wording for an unfinished run. */
export function cardGate(state, options = {}) {
  const gate = nextStepGate(state, options);
  return gate?.code === 'UNFINISHED' ? { ...gate, text: '진행 중인 연습이 있습니다. 끝낸 뒤 재평가할 수 있습니다.' } : gate;
}
/** The plan plus whether its action may be started right now. */
export function nextStepView(summary, state, options = {}) {
  const plan = planNextStep(summary);
  const gate = nextStepGate(state, options);
  return { plan, gate, disabled: Boolean(gate) || !plan.selectors };
}

/** After a finished run: a variation and a delayed retest to consider. Text and
 * mode choices only; nothing here starts a run. */
export function completionGuidance(state, summary) {
  const session = state?.session;
  if (!session?.sessionId || session.done !== true || state.awaitNext || state.busy || state.recovery || state.pending
    || !(session.count > 0)) return null;
  const mode = STUDY_MODES[session.mode] ?? '연습';
  const own = (summary?.assessments ?? []).find((run) => run?.id === session.studyRun?.id);
  const when = availableAt(own?.retest);
  const view = enrollmentView(summary?.enrollment);
  const baseline = view?.status === 'active' && !view.postOpen && session.mode === 'assessment'
    && view.baselines.some((row) => row.runId !== null && row.runId === session.studyRun?.id);
  const retest = baseline
    ? `지연 재평가: 이 평가는 학습 효과 평가의 등록 기준입니다. 지연 재평가는 사후 기간(${whenOf(view.postOpensAt)} ~ ${whenOf(view.postClosesAt)})에 하세요.`
    : session.mode === 'assessment'
    ? `지연 재평가: 이 평가는 완료 24시간 뒤부터 같은 문항으로 다시 풀 수 있습니다${when ? ` (가능 시각 ${when})` : ''}.`
    : session.mode === 'retest'
      ? '지연 재평가: 같은 평가를 다시 재평가하려면 마지막 완료로부터 24시간이 지나야 합니다.'
      : '지연 재평가: 새 문제 평가를 완료하면 24시간 뒤 같은 문항으로 다시 확인할 수 있습니다.';
  return {
    title: `${mode}을 마쳤습니다`,
    variation: '변형 연습: 같은 상황의 이웃 손패를 푸는 일반화 연습이나 다른 상황의 자유 연습으로 이어갈 수 있습니다. 풀 이웃 손패가 없으면 문항이 없을 수 있습니다.',
    retest,
    choices: [{ mode: 'transfer', label: '일반화 연습 모드 선택' }, { mode: 'retest', label: '지연 재평가 모드 선택' }],
  };
}

/** Trends (design D12): one series per source and mode — runs from different
 * question distributions are never joined — and one row per game session. */
// A series names its source as a JSON [id, version, sha] key; a game row as id@version.
function sourceLabel(text) {
  let id = null;
  let version = null;
  try { [id, version] = JSON.parse(text); } catch { [id, version] = String(text ?? '').split('@'); }
  if (typeof id !== 'string' || typeof version !== 'string') return '';
  return id === 'local-preflop-baseline' ? `기준표 ${version}` : `${id}@${version}`;
}

// One line per comparable series (see training/study-history.js trendsOf): the
// assessments of a source, or one assessment with its retests. Game sessions
// are grouped by the reference source they were graded against.
export function formatTrends(trends = {}) {
  const series = new Map();
  for (const run of Array.isArray(trends.practice) ? trends.practice : []) {
    if (typeof run?.series !== 'string' || number(run.allowedActionRate) === null) continue;
    const [sourceText, kind] = run.series.split('|');
    if (!['assessment', 'retest'].includes(kind)) continue;
    const date = new Date(run.startedAt).toLocaleDateString('ko-KR');
    if (!series.has(run.series)) {
      series.set(run.series, { label: kind === 'retest'
        ? `${STUDY_MODES.retest} · ${date} 평가와 같은 문항 · ${sourceLabel(sourceText)}`
        : `${STUDY_MODES.assessment} · ${sourceLabel(sourceText)}`, rows: [] });
    }
    series.get(run.series).rows.push({ date: run.mode === 'assessment' && kind === 'retest' ? `${date} (기준)` : date, rate: percent(run.allowedActionRate),
      baseline: number(run.foldBaselineRate) !== null ? percent(run.foldBaselineRate) : null, width: Math.round(run.allowedActionRate * 1000) / 10 });
  }
  const games = new Map();
  for (const row of Array.isArray(trends.game) ? trends.game : []) {
    if (number(row?.allowedActionRate) === null) continue;
    const label = `게임 기록 · ${sourceLabel(row.source) || '출처 미상'}`;
    if (!games.has(label)) games.set(label, []);
    games.get(label).push({ label: `게임 ${count(row.session)} · ${new Date(row.startedAt).toLocaleDateString('ko-KR')}`, graded: `${count(row.graded)}결정 채점`,
      rate: percent(row.allowedActionRate), width: Math.round(row.allowedActionRate * 1000) / 10 });
  }
  return { series: [...series.values()].map((entry) => ({ label: entry.label, rows: entry.rows.slice(-12) })),
    game: [...games].map(([label, rows]) => ({ label, rows: rows.slice(-12) })) };
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
