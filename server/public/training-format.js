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
    explanation: item.explanation ?? '',
    source: item.source?.id ? `${item.source.id}@${item.source.version ?? ''}` : '',
    status: item.status ?? null,
    exploit: '',
  };
  if (item.exploit?.accuracy === 'heuristic' && item.exploit.adjustment) {
    const adj = item.exploit.adjustment;
    card.exploit = `Exploit 방향: bluff ${adj.bluff} / thin value ${adj.thinValue} (heuristic, EV 없음)`;
  }
  if (item.forced) card.note = '워치독 몰수 폴드 — 실력 표본에서 제외';
  else if (item.status === 'unsupported') {
    card.note = item.reason ? `지원되지 않는 스팟 (${item.reason})` : '지원되지 않는 스팟';
  }
  return card;
}
