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
  return {
    source: formatSource(source), sourceShort: formatSourceShort(source), game: originSummary(summary.game, allowed), practice: originSummary(summary.practice, allowed),
    due: `${count(summary.bank?.dueCount)}개 오늘 복습 · 전체 ${count(summary.bank?.totalCount)}개${count(summary.bank?.graduatedCount) ? ` · 졸업 ${count(summary.bank.graduatedCount)}개` : ''}`,
    goal: goalAllowed ? `${goal.origin === 'game' ? '게임 기록' : goal.origin === 'practice' ? '연습 기록' : '기본 지원 상황'}에서 정한 목표: ${position(goal.spotKey?.split('-')[2])} · ${hand(goal.handClass)}의 기준 빈도 확인` : '확인된 근거가 없어 목표를 준비하지 못했습니다.',
    assessments: (summary.assessments ?? []).map((run) => runSummary(run, allowed)),
    retests: (summary.retests ?? []).map((run) => runSummary(run, allowed && (summary.assessments ?? []).some((base) => base.id === run.assessmentId && base.complete && !base.reason && verified(base.sourceIdentity) && JSON.stringify(base.sourceIdentity) === JSON.stringify(run.sourceIdentity)))),
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
