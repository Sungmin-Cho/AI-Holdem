import { independentAssessmentEligibility } from '../../shared/assistance.js';
import {referenceAssessmentEligibility} from '../../shared/reference-coverage.js';
import {parsePreflopKey} from '../../shared/preflop-key.js';
import { formatReferenceReason, referenceClaimAllowed, referenceQuality } from '../../shared/reference.js';

/**
 * An evaluationId's machine digest is set-once (R3/R5). A later publish carrying
 * a different digest for the same id is a conflict, not an update, so the card
 * already on screen wins and the newcomer is dropped.
 */
export function mergeTrainingItems(list, incoming) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const item of incoming ?? []) {
    const at = out.findIndex((existing) => existing.evaluationId === item.evaluationId);
    if (at === -1) out.push(item);
    else out[at] = mergeTrainingItem(out[at], item);
  }
  out.sort((left, right) => (left.handNo ?? 0) - (right.handNo ?? 0));
  return out;
}

export function mergeTrainingItem(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming || existing.evaluationId !== incoming.evaluationId) return existing;
  if (existing.payloadSha256 !== incoming.payloadSha256) return existing;
  return existing;
}

const ACTION = Object.freeze({
  fold: '폴드',
  check: '체크',
  call: '콜',
  bet: '벳',
  raise: '레이즈',
});

const GRADE = Object.freeze({
  preferred: '기준표 주력 선택',
  mixed: '기준표 허용 선택',
  'low-frequency': '기준표 저빈도 허용 선택',
  'off-policy': '기준표와 다른 선택',
});

const SOURCE_LABEL = Object.freeze({
  'heuristic-reference': '휴리스틱 참고 자료',
  synthetic: '테스트용 합성 자료 · 학습 근거 제외',
  unverified: '출처 미검증 · 기준표 비교 불가',
});

// This is only a navigation shape check. Source/status authority comes from the
// verified detail below, never from compact card fields or a second digest path.
function practiceTargetOf(item, sourceEligible) {
  if (!sourceEligible || item.status !== 'supported' || item.forced
    || (item.street !== undefined && item.street !== 'preflop')
    || !parsePreflopKey(item.spotKey)) return null;
  const hand = /^([AKQJT2-9])([AKQJT2-9])([so]?)$/.exec(item.handClass ?? '');
  if (!hand) return null;
  const ranks = 'AKQJT98765432';
  if (hand[1] === hand[2] ? hand[3] !== '' : (!hand[3] || ranks.indexOf(hand[1]) >= ranks.indexOf(hand[2]))) return null;
  return Object.freeze({ spotKey: item.spotKey, handClass: item.handClass });
}

function actionLabel(action) {
  return ACTION[action] ?? action ?? '—';
}

export function applyTrainingAnnotation(item, annotation) {
  if (!item || !annotation || item.evaluationId !== annotation.evaluationId) return item;
  const next = { ...item };
  if (annotation.field === 'explanation') {
    next.explanationStatus = annotation.status;
    next.explanation = annotation.status === 'unavailable' ? null : annotation.value;
  }
  if (annotation.field === 'exploit') {
    next.exploitStatus = annotation.status;
    next.exploit = annotation.status === 'unavailable' ? null : annotation.value;
  }
  return next;
}

const verifiedDetails = new WeakMap();
const HEX64 = /^[0-9a-f]{64}$/;
const detailBinding = (item) => JSON.stringify([
  item.evaluationId, item.payloadSha256, item.detailRef, item.detailSha256,
  item.decisionId, item.handNo, item.source?.id, item.source?.version,
]);

// The compact item is obtained from the authenticated snapshot/SSE channel. The
// detail API returns parsed JSON, serialized exactly as the immutable detail writer.
// Keep verification outside card rendering and never enrich the compact item itself.
export async function verifyTrainingDetail(item, detail) {
  try {
    const binding = detailBinding(item);
    if (!item || !detail || !HEX64.test(item.payloadSha256 ?? '')
      || !HEX64.test(item.detailSha256 ?? '') || !HEX64.test(item.detailRef ?? '')
      || typeof item.evaluationId !== 'string') return null;
    const identity = /^([0-9a-f]{64}):(d-([1-9][0-9]*)-[a-z]+-[0-9]+):([a-z0-9-]+)@(\d+\.\d+\.\d+)$/.exec(item.evaluationId);
    if (!identity || item.decisionId !== identity[2] || item.handNo !== Number(identity[3])
      || detail.evaluationId !== item.evaluationId || detail.decisionId !== item.decisionId
      || (detail.handNo !== undefined && detail.handNo !== item.handNo)
      || detail.source?.id !== identity[4] || detail.source?.version !== identity[5]
      || item.source?.id !== identity[4] || item.source?.version !== identity[5]) return null;
    const bytes = JSON.stringify(detail);
    if (bytes.length > 1_000_000) return null;
    const sha256 = async (text) => Array.from(new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (await sha256(bytes) !== item.detailSha256 || await sha256(item.evaluationId) !== item.detailRef) return null;
    if (binding !== detailBinding(item)) return null;
    const receipt = Object.freeze({ evaluationId: item.evaluationId, detailSha256: item.detailSha256 });
    verifiedDetails.set(receipt, { binding, detail: JSON.parse(bytes) });
    return receipt;
  } catch {
    return null;
  }
}

export function formatTrainingCard(item, { verifiedDetail = null } = {}) {
  const receipt = verifiedDetail && verifiedDetails.get(verifiedDetail);
  const verified = receipt?.binding === detailBinding(item);
  if (verified) {
    const detail = receipt.detail;
    item = { ...item };
    for (const key of ['status', 'grade', 'chosen', 'recommended', 'source', 'spotKey', 'handClass', 'street', 'forced', 'coverage', 'assistance']) {
      item[key] = detail[key];
    }
  }
  const identityQuality = referenceQuality(item.source);
  const quality = verified || identityQuality.quality !== 'heuristic-reference' ? identityQuality
    : { quality: 'unverified', reason: 'LEARNING_AUTHORITY_UNAVAILABLE' };
  const eligibility = referenceAssessmentEligibility(item);
  const sourceEligible = verified && quality.quality === 'heuristic-reference' && eligibility.verified;
  const metricEligible = sourceEligible && independentAssessmentEligibility(item).metricEligible;
  const rec = sourceEligible && Array.isArray(item.recommended) ? item.recommended[0] : null;
  const recFreq = rec?.frequency != null ? ` ${Math.round(rec.frequency * 100)}%` : '';
  const recSize = rec?.sizeBb != null ? ` ${rec.sizeBb}bb` : '';
  const spot = parsePreflopKey(item.spotKey);
  const title = [
    `핸드 ${item.handNo ?? '?'}`,
    spot?.version === 2 ? `${spot.seated}인 ${spot.position}` : item.spotKey ? String(item.spotKey).split('-')[2]?.toUpperCase() : null,
    spot?.version === 2 && spot.openerPosition ? `${spot.openerPosition} 오픈 대응` : null,
    item.handClass,
  ].filter(Boolean).join(' · ');
  const card = {
    title,
    choice: `내 선택: ${actionLabel(item.chosen?.action)}`,
    recommendation: rec ? `기준표 참고: ${actionLabel(rec.action)}${recSize}${recFreq}` : '',
    grade: item.status === 'supported' && metricEligible ? (item.grade ?? null) : null,
    gradeLabel: item.status === 'supported' && metricEligible ? (GRADE[item.grade] ?? '') : '',
    forced: Boolean(item.forced),
    note: '',
    explanation: item.explanationStatus === 'unavailable'
      ? 'unavailable'
      : (sourceEligible && referenceClaimAllowed(item.explanation) ? (item.explanation ?? '') : ''),
    source: item.source?.id ? `${item.source.id}@${item.source.version ?? ''}` : '',
    sourceQuality: quality.quality,
    sourceLabel: SOURCE_LABEL[quality.quality] ?? SOURCE_LABEL.unverified,
    practiceTarget: practiceTargetOf(item, metricEligible),
    status: item.status ?? null,
    exploit: '',
  };
  const exploitVal = item.exploit;
  if (exploitVal?.opponents && exploitVal.primary) {
    const primary = exploitVal.opponents.find((row) => row.opponentId === exploitVal.primary);
    if (primary?.adjustment) {
      const adj = primary.adjustment;
      card.exploit = `Exploit 방향: bluff ${adj.bluff} / thin value ${adj.thinValue}`;
    }
  }
  if (sourceEligible && item.coverage?.reference) {
    const c=item.coverage,i=c.input,r=c.reference;
    const projections=[];
    if(c.reasonCodes.includes('STACK_PROJECTED'))projections.push(`스택 ${i.effectiveStackBb}bb → ${r.stackBb}bb`);
    if(c.reasonCodes.includes('FACING_SIZE_PROJECTED'))projections.push(`오픈 ${i.facingRaiseToBb}bb → ${r.openRaiseToBb}bb`);
    if(c.reasonCodes.includes('CHOICE_SIZE_PROJECTED'))projections.push(`선택 ${i.chosenRaiseToBb}bb → ${i.openerPosition ? r.threeBetRaiseToBb : r.openRaiseToBb}bb`);
    if(projections.length)card.note=`투영 참고: ${projections.join(' · ')} · 점수 제외`;
    if(c.choiceMatch==='unavailable')card.note=[card.note,'선택 사이즈 비교 불가 · 점수 제외'].filter(Boolean).join(' · ');
    else if(c.metricEligible)card.note='직접 기준표 비교';
  }
  if (item.assistance?.hintShown) card.note = [card.note,'힌트 도움을 받은 결정 · 점수 제외'].filter(Boolean).join(' · ');
  if (item.forced) card.note = '워치독 몰수 폴드 — 실력 표본에서 제외';
  else if (item.status === 'unsupported') {
    card.note = formatReferenceReason(item.code ?? 'UNSUPPORTED_SPOT', item.reason);
  } else if (!sourceEligible) {
    card.note = formatReferenceReason(quality.reason);
  } else if (!referenceClaimAllowed(item.explanation)) {
    card.note = [card.note,'근거 범위를 벗어난 표현을 제외했습니다.'].filter(Boolean).join(' · ');
  }
  if (['flop', 'turn', 'river'].includes(item.street)
    || (typeof item.spotKey === 'string' && item.spotKey.startsWith('postflop-'))) {
    card.note = [card.note, '학습 집계 제외(postflop)'].filter(Boolean).join('\n');
  }
  return card;
}
