export const REPLAY_NOT_COMPLETED = '이 핸드는 아직 끝나지 않아 복기를 열 수 없습니다.';
export const REPLAY_UNAVAILABLE = '이 핸드의 복기를 불러올 수 없습니다.';

export const HEADER_DISCLAIMER = '핸드 종료 후 복기 공개(실전에서는 비공개 정보)';
export const HEADER_RELIABILITY = '사후 설명은 실제 의도를 보장하지 않습니다.';

const STREET_LABEL = Object.freeze({
  preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버',
});

const ACTION_LABEL = Object.freeze({
  fold: '폴드', check: '체크', call: '콜', bet: '벳', raise: '레이즈',
});

const REASON_COPY = Object.freeze({
  policy: '정책 플레이어 — 빈도표에서 샘플된 결정, 사유 없음. 정책 정체는 종합 리뷰에서 공개',
  forced: '워치독 강제',
  none: '사유 없음',
  hidden: '비공개(복기 공개 범위: 쇼다운)',
});

// 엔진은 자발적 베팅을 전부 raise로 내보낸다. 스트리트에 선행 베팅이 없었다면
// 그것은 레이즈가 아니라 벳이므로, 로그·복기에서만 그 구분을 되살린다.
export function actionVerbs(items) {
  const verbs = new Map();
  let street = null;
  let wagered = false;
  for (const item of items) {
    if (item.type === 'hand_start') {
      street = 'preflop';
      wagered = true;
      continue;
    }
    if (item.type === 'street') {
      street = item.street;
      wagered = false;
      continue;
    }
    const isLogAction = item.type === 'action';
    const isReplayAction = item.type == null && typeof item.action === 'string';
    if (!isLogAction && !isReplayAction) continue;
    if (item.street !== street) {
      street = item.street;
      wagered = item.street === 'preflop';
    }
    if (item.action === 'raise') {
      verbs.set(item, wagered ? 'raise' : 'bet');
      wagered = true;
      continue;
    }
    verbs.set(item, item.action);
    if (item.action === 'call') wagered = true;
  }
  return verbs;
}

function displayName(playerId, names) {
  if (names?.[playerId]) return names[playerId];
  return playerId === 'user' ? '나' : (playerId ?? '');
}

function reasonText(action) {
  if (action.playerId === 'user' || action.reasonKind == null) return '';
  if (action.reasonKind === 'model') {
    return `모델이 밝힌 사유: ${action.reason ?? ''}`.trim();
  }
  return REASON_COPY[action.reasonKind] ?? '';
}

function coachFor(action, coachNote) {
  if (action.playerId !== 'user') return null;
  if (coachNote?.unavailable) return { status: 'unavailable', message: '코치 피드백 불가' };
  if (coachNote == null) return { status: 'pending', message: '코치 피드백 대기 중' };
  const hit = (coachNote.decisions ?? []).find((row) => row.decisionId === action.decisionId);
  if (hit) {
    return {
      status: 'ready',
      why: hit.why,
      outcome: hit.outcome,
      alternative: hit.alternative,
    };
  }
  return null;
}

function studyFor(action, trainingItems) {
  if (action.playerId !== 'user' || typeof action.decisionId !== 'string') return null;
  const item = (trainingItems ?? []).find((row) => row.decisionId === action.decisionId);
  if (!item) return null;
  return { decisionId: item.decisionId, evaluationId: item.evaluationId };
}

function markerView(replay) {
  const reason = replay?.reason === 'REPLAY_NOT_COMPLETED'
    ? 'REPLAY_NOT_COMPLETED'
    : 'REPLAY_UNAVAILABLE';
  return {
    kind: 'marker',
    handNo: replay?.handNo,
    reason,
    message: reason === 'REPLAY_NOT_COMPLETED' ? REPLAY_NOT_COMPLETED : REPLAY_UNAVAILABLE,
  };
}

export function formatReplay(replay, { coachNote, trainingItems, names } = {}) {
  if (!replay || replay.unavailable === true
    || replay.reason === 'REPLAY_NOT_COMPLETED'
    || replay.reason === 'REPLAY_UNAVAILABLE') {
    return markerView(replay);
  }

  const verbs = actionVerbs(replay.actions ?? []);
  const streets = [];
  let current = null;
  for (const action of replay.actions ?? []) {
    const street = action.street ?? 'preflop';
    if (!current || current.street !== street) {
      current = { street, label: STREET_LABEL[street] ?? street, rows: [] };
      streets.push(current);
    }
    const verb = verbs.get(action) ?? action.action;
    const cards = replay.holes?.[action.playerId]
      ? [...replay.holes[action.playerId]]
      : null;
    const note = action.playerId === 'user' && typeof action.note === 'string' ? action.note : null;
    current.rows.push({
      street,
      playerId: action.playerId,
      decisionId: action.decisionId ?? null,
      name: displayName(action.playerId, names),
      position: replay.positions?.[action.playerId] ?? '',
      verb,
      verbLabel: ACTION_LABEL[verb] ?? verb,
      amount: action.amount ?? null,
      pot: action.potTotal ?? null,
      cards,
      reasonKind: action.reasonKind ?? null,
      reasonText: reasonText(action),
      note,
      noteText: note ? `내 메모: ${note}` : '',
      coach: coachFor(action, coachNote),
      study: studyFor(action, trainingItems),
    });
  }

  const winners = [];
  for (const pot of replay.pots ?? []) {
    for (const winner of pot.winners ?? []) {
      const label = displayName(winner.playerId, names);
      if (!winners.includes(label)) winners.push(label);
    }
  }

  return {
    kind: 'replay',
    header: {
      handNo: replay.handNo,
      blinds: Array.isArray(replay.blinds) ? [...replay.blinds] : replay.blinds,
      board: [...(replay.board ?? [])],
      winners,
      disclaimer: HEADER_DISCLAIMER,
      reliability: HEADER_RELIABILITY,
    },
    streets,
    coachSummary: coachNote?.text ?? null,
  };
}
