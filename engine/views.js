import { blindsForLevel, legalFor } from './hand.js';
import { seatedFromButton, positionsOf } from './positions.js';
import { buildPots } from './sidepots.js';

function currentHandData(state) {
  if (state.hand) return state.hand;
  if (state.lastHand) {
    return {
      street: ['preflop', null, null, 'flop', 'turn', 'river'][state.lastHand.board?.length ?? 0] ?? null,
      board: state.lastHand.board ?? [],
      holes: state.lastHand.holes ?? {},
      bets: {},
      folded: state.lastHand.folded ?? [],
      allIn: state.lastHand.allIn ?? [],
      contribs: new Map(),
      pots: state.lastHand.pots ?? [],
    };
  }
  return null;
}

function publicPots(hand) {
  if (!hand) return [];
  if (Array.isArray(hand.pots)) return structuredClone(hand.pots);
  const pots = buildPots(
    new Map(Object.entries(hand.contribs ?? {})),
    new Set(hand.folded ?? []),
  );
  return pots.map((pot, potIndex) => ({ potIndex, ...pot }));
}

function publicSeat(state, hand, seat) {
  return {
    playerId: seat.playerId,
    name: seat.name,
    stack: seat.stack,
    bet: hand?.bets?.[seat.playerId] ?? 0,
    folded: Boolean(hand?.folded?.includes(seat.playerId)),
    allIn: Boolean(hand?.allIn?.includes(seat.playerId)),
    isButton: state.seats[state.button]?.playerId === seat.playerId,
  };
}

export function viewFor(state, playerId) {
  const hand = currentHandData(state);
  const legal = state.hand ? legalFor(state) : null;
  const view = {
    handNo: state.handNo,
    level: state.level,
    levelEvery: state.config.levelEvery,
    blinds: state.hand
      ? blindsForLevel(state.level, state.config.blinds0)
      : (state.lastHand?.blinds ? [...state.lastHand.blinds] : blindsForLevel(state.level, state.config.blinds0)),
    street: hand?.street ?? null,
    board: [...(hand?.board ?? [])],
    pots: publicPots(hand),
    seats: state.seats.map((seat) => publicSeat(state, hand, seat)),
    toAct: legal?.toAct ?? null,
    myCards: [...(hand?.holes?.[playerId] ?? [])],
    gameOver: Boolean(state.gameOver),
  };

  if (state.hand && legal?.toAct === playerId) view.legal = structuredClone(legal);
  if (state.result != null) view.result = state.result;
  return view;
}

export function userView(state) {
  return viewFor(state, 'user');
}

const STREET_KO = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
const ACTION_KO = { fold: '폴드', check: '체크', call: '콜', raise: '레이즈' };

export function turnSummary(state, playerId) {
  const legal = legalFor(state);
  if (legal.handOver || legal.toAct !== playerId) return null;

  const view = viewFor(state, playerId);
  const pos = positionsOf(state);
  const hand = state.hand;
  const me = state.seats.find((seat) => seat.playerId === playerId);
  const nameOf = (pid) => state.seats.find((seat) => seat.playerId === pid)?.name ?? pid;
  const [sb, bb] = view.blinds;

  // Unequal blinds split the pot too; the breakdown only informs a decision once someone is all-in.
  const sidePots = hand?.allIn?.length && view.pots.length > 1;
  const pots = sidePots
    ? `${legal.potTotal} (${view.pots.map((pot) => `팟${pot.potIndex} ${pot.amount}`).join(', ')})`
    : String(legal.potTotal);

  const survivors = seatedFromButton(state).map((seat) => {
    const status = hand?.folded?.includes(seat.playerId) ? '폴드'
      : hand?.allIn?.includes(seat.playerId) ? '올인' : '참여';
    const bet = hand?.bets?.[seat.playerId] ?? 0;
    return `${seat.name}(${pos[seat.playerId]}, 스택 ${seat.stack}, 이번 스트리트 ${bet}, ${status})`;
  });

  const actions = (hand?.actions ?? []).map((entry) => {
    const amount = entry.action === 'raise' || entry.action === 'call' ? ` ${entry.amount}` : '';
    return `${STREET_KO[entry.street] ?? entry.street} ${nameOf(entry.playerId)} ${ACTION_KO[entry.action] ?? entry.action}${amount}`;
  });

  const choices = ['fold'];
  if (legal.canCheck) choices.push('check');
  else choices.push(`call ${legal.callAmount}`);
  if (legal.canRaise) {
    // Short stack: the raise clears the current bet but not the minimum, so all-in
    // is the only legal amount. Printing "150~120" would read as no legal raise.
    choices.push(legal.minRaiseTo > legal.maxRaiseTo
      ? `raise ${legal.maxRaiseTo} (올인, 유일한 합법 레이즈)`
      : `raise ${legal.minRaiseTo}~${legal.maxRaiseTo}`);
  }

  const lines = [
    `[핸드 ${view.handNo} / ${STREET_KO[view.street] ?? view.street}] 당신: ${me.name} (${pos[playerId]}, 스택 ${me.stack}) | decisionId: ${legal.decisionId}`,
    `홀카드: ${view.myCards.join(' ')} | 보드: ${view.board.length ? view.board.join(' ') : '없음'}`,
    `팟: ${pots} | 블라인드 ${sb}/${bb} | 내 이번 스트리트 베팅: ${hand?.bets?.[playerId] ?? 0}`,
    `생존자: ${survivors.join(' / ')}`,
    `이번 핸드 공개 액션: ${actions.length ? actions.join(' → ') : '없음'}`,
    `가능한 액션: ${choices.join(' / ')}`,
    `legal 수치: canCheck=${legal.canCheck} callAmount=${legal.callAmount} canRaise=${legal.canRaise} minRaiseTo=${legal.minRaiseTo} maxRaiseTo=${legal.maxRaiseTo}`,
  ];
  if (legal.canRaise && legal.minRaiseTo > legal.maxRaiseTo) {
    lines.push(`minRaiseTo>maxRaiseTo 이므로 합법 레이즈는 ${legal.maxRaiseTo}(올인)뿐이다.`);
  }
  lines.push(`JSON 한 줄로 응답: {"decisionId":"${legal.decisionId}","action":"fold|check|call|raise","amount":숫자?}`);
  return lines.join('\n');
}

function safeAction(action) {
  const keys = [
    'decisionId', 'playerId', 'action', 'amount', 'street', 'potTotal',
    'callAmount', 'minRaiseTo', 'maxRaiseTo', 'board', 'stacks',
  ];
  const result = {};
  for (const key of keys) {
    if (key in action) result[key] = structuredClone(action[key]);
  }
  return result;
}

export function redactRecord(record, viewerId = 'user') {
  if (!record) return null;
  const result = {};
  for (const key of ['handNo', 'level', 'blinds', 'button', 'board', 'folded', 'allIn', 'startStacks', 'endStacks']) {
    if (key in record) result[key] = structuredClone(record[key]);
  }
  result.holes = {};
  if (record.holes?.[viewerId]) result.holes[viewerId] = [...record.holes[viewerId]];
  result.actions = (record.actions ?? []).map(safeAction);
  result.pots = (record.pots ?? []).map((pot) => ({
    potIndex: pot.potIndex,
    amount: pot.amount,
    eligible: [...(pot.eligible ?? [])],
    winners: (pot.winners ?? []).map((winner) => ({ ...winner })),
  }));
  if (record.showdown) {
    result.showdown = {
      reveals: (record.showdown.reveals ?? []).map((reveal) => ({
        playerId: reveal.playerId,
        cards: [...reveal.cards],
        ...(reveal.handName == null ? {} : { handName: reveal.handName }),
      })),
      mucks: [...(record.showdown.mucks ?? [])],
    };
  } else {
    result.showdown = null;
  }
  if (Array.isArray(record.decisions)) {
    result.decisions = record.decisions
      .filter((snap) => snap.actorId === viewerId)
      .map((snap) => {
        const copy = structuredClone(snap);
        copy.priorActions = (copy.priorActions ?? []).map(safeAction);
        return copy;
      });
  }
  return result;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function statsReport(state) {
  const perPlayer = {};
  for (const seat of state.seats) {
    const raw = state.stats?.[seat.playerId] ?? {};
    const sample = raw.hands ?? 0;
    const calls = raw.calls ?? 0;
    const betsRaises = raw.betsRaises ?? 0;
    perPlayer[seat.playerId] = {
      vpip: ratio(raw.vpip ?? 0, sample),
      pfr: ratio(raw.pfr ?? 0, sample),
      af: calls > 0 ? betsRaises / calls : betsRaises,
      showdownWin: ratio(raw.showdownWins ?? 0, raw.showdowns ?? 0),
      net: raw.net ?? 0,
      sample,
    };
  }
  return { perPlayer };
}
