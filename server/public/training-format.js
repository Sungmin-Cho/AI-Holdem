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

export function formatTrainingCard(item) {
  const rec = Array.isArray(item.recommended) ? item.recommended[0] : null;
  const recFreq = rec?.frequency != null ? ` ${Math.round(rec.frequency * 100)}%` : '';
  const recSize = rec?.sizeBb != null ? ` ${rec.sizeBb}bb` : '';
  const title = [
    `핸드 ${item.handNo ?? '?'}`,
    item.spotKey ? String(item.spotKey).split('-')[2]?.toUpperCase() : null,
    item.handClass,
  ].filter(Boolean).join(' · ');
  const card = {
    title,
    choice: `내 선택: ${actionLabel(item.chosen?.action)}`,
    recommendation: rec ? `추천: ${actionLabel(rec.action)}${recSize}${recFreq}` : '',
    grade: item.status === 'supported' ? (item.grade ?? null) : null,
    forced: Boolean(item.forced),
    note: '',
    explanation: item.explanationStatus === 'unavailable'
      ? 'unavailable'
      : (item.explanation ?? ''),
    source: item.source?.id ? `${item.source.id}@${item.source.version ?? ''}` : '',
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
  if (item.forced) card.note = '워치독 몰수 폴드 — 실력 표본에서 제외';
  else if (item.status === 'unsupported') {
    card.note = item.reason ? `지원되지 않는 스팟 (${item.reason})` : '지원되지 않는 스팟';
  }
  if (['flop', 'turn', 'river'].includes(item.street)
    || (typeof item.spotKey === 'string' && item.spotKey.startsWith('postflop-'))) {
    card.note = [card.note, '학습 집계 제외(postflop)'].filter(Boolean).join('\n');
  }
  return card;
}
