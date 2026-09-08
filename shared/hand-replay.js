export const HAND_REPLAY_SCHEMA_VERSION = 1;

export const SAFE_ACTION_KEYS = [
  'decisionId', 'playerId', 'action', 'amount', 'street', 'potTotal',
  'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks', 'currentBet',
];

export const REPLAY_ACTION_KEYS = [
  'decisionId', 'playerId', 'action', 'amount', 'street', 'potTotal',
  'callAmount', 'minRaiseTo', 'maxRaiseTo', 'currentBet', 'board',
  'forced', 'reasonKind', 'reason', 'note',
];

const DECISION_KEYS = [
  'decisionId', 'street', 'position', 'holeCards', 'potBefore',
  'toCall', 'effectiveStack', 'forced', 'chosenAction',
];

function reasonKindOf(action) {
  if (action.forced === true) return 'forced';
  if (action.policyId != null) return 'policy';
  if (typeof action.reason === 'string') return 'model';
  return 'none';
}

function copyPots(record) {
  return (record.pots ?? []).map((pot) => ({
    potIndex: pot.potIndex,
    amount: pot.amount,
    eligible: [...(pot.eligible ?? [])],
    winners: (pot.winners ?? []).map((winner) => ({ ...winner })),
  }));
}

function copyShowdown(record) {
  if (!record.showdown) return null;
  return {
    reveals: (record.showdown.reveals ?? []).map((reveal) => ({
      playerId: reveal.playerId,
      cards: [...reveal.cards],
      ...(reveal.handName == null ? {} : { handName: reveal.handName }),
    })),
    mucks: [...(record.showdown.mucks ?? [])],
  };
}

export function replayRecord(record, { reveal } = {}) {
  const mode = reveal === 'all' ? 'all' : 'showdown';
  const shown = new Set(['user']);
  if (mode === 'all') {
    for (const pid of Object.keys(record.holes ?? {})) shown.add(pid);
  } else {
    for (const row of record.showdown?.reveals ?? []) shown.add(row.playerId);
  }

  const holes = {};
  for (const pid of shown) {
    if (record.holes?.[pid]) holes[pid] = [...record.holes[pid]];
  }

  const actions = (record.actions ?? []).map((action) => {
    const row = {};
    for (const key of REPLAY_ACTION_KEYS) {
      if (key === 'forced' || key === 'reasonKind' || key === 'reason' || key === 'note') continue;
      if (key in action) row[key] = structuredClone(action[key]);
    }
    if (action.forced === true) row.forced = true;
    if (action.playerId === 'user') {
      if (typeof action.note === 'string') row.note = action.note;
    } else {
      const hidden = !shown.has(action.playerId);
      row.reasonKind = hidden ? 'hidden' : reasonKindOf(action);
      if (!hidden && row.reasonKind === 'model' && typeof action.reason === 'string') {
        row.reason = action.reason;
      }
    }
    return row;
  });

  const replay = {
    schemaVersion: HAND_REPLAY_SCHEMA_VERSION,
    reveal: mode,
    handNo: record.handNo,
    level: record.level,
    blinds: record.blinds,
    button: record.button,
    board: [...(record.board ?? [])],
    folded: [...(record.folded ?? [])],
    allIn: [...(record.allIn ?? [])],
    startStacks: structuredClone(record.startStacks ?? {}),
    endStacks: structuredClone(record.endStacks ?? {}),
    posts: structuredClone(record.posts ?? []),
    uncalledReturns: structuredClone(record.uncalledReturns ?? {}),
    holes,
    showdown: copyShowdown(record),
    pots: copyPots(record),
    actions,
    decisions: (record.decisions ?? [])
      .filter((snap) => snap.actorId === 'user')
      .map((snap) => {
        const out = {};
        for (const key of DECISION_KEYS) {
          if (key in snap) out[key] = structuredClone(snap[key]);
        }
        return out;
      }),
  };
  if (record.positions) replay.positions = structuredClone(record.positions);
  return replay;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function canonicalHandReplayJson(replay) {
  return JSON.stringify(sortKeys(replay));
}
