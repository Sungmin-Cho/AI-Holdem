function streetHeader(street) {
  if (street === 'flop') return '*** FLOP ***';
  if (street === 'turn') return '*** TURN ***';
  if (street === 'river') return '*** RIVER ***';
  return null;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatCards(cards) {
  return `[${(cards ?? []).join(' ')}]`;
}

function boardCount(street) {
  if (street === 'flop') return 3;
  if (street === 'turn') return 4;
  if (street === 'river') return 5;
  return 0;
}

function streetFromBoard(board) {
  const n = board?.length ?? 0;
  if (n >= 5) return 'river';
  if (n >= 4) return 'turn';
  if (n >= 3) return 'flop';
  return 'preflop';
}

function emitStreetHeaders(lines, board, fromStreet, toStreet) {
  const order = ['preflop', 'flop', 'turn', 'river'];
  const start = order.indexOf(fromStreet);
  const end = order.indexOf(toStreet);
  if (start < 0 || end < 0) return;
  for (let i = start + 1; i <= end; i += 1) {
    const street = order[i];
    const n = boardCount(street);
    if ((board?.length ?? 0) >= n) {
      lines.push(`${streetHeader(street)} ${formatCards(board.slice(0, n))}`);
    }
  }
}

function isAllInAction(hand, action, index) {
  if (action.action !== 'call' && action.action !== 'raise') return false;
  if (!(hand.allIn ?? []).includes(action.playerId)) return false;
  return !(hand.actions ?? []).slice(index + 1).some(
    (later) => later.playerId === action.playerId
      && (later.action === 'call' || later.action === 'raise'),
  );
}

function formatActionLine(hand, action, index) {
  const suffix = isAllInAction(hand, action, index) ? ' and is all-in' : '';
  if (action.action === 'fold') return `${action.playerId}: folds`;
  if (action.action === 'check') return `${action.playerId}: checks`;
  if (action.action === 'call') return `${action.playerId}: calls ${action.amount}${suffix}`;
  if (action.action === 'raise') {
    const currentBet = action.currentBet;
    if (typeof currentBet === 'number' && currentBet === 0) {
      return `${action.playerId}: bets ${action.amount}${suffix}`;
    }
    if (typeof currentBet === 'number') {
      return `${action.playerId}: raises ${action.amount - currentBet} to ${action.amount}${suffix}`;
    }
    throw coded('EXPORT_CONTRACT_VIOLATION', 'raise action에 currentBet이 없습니다.');
  }
  return null;
}

export function renderPokerStars(canonical, { gameId = '1', exportedAt = '2026/09/01 0:00:00 ET' } = {}) {
  const lines = [];
  const warnings = [];
  for (const hand of canonical.hands) {
    const blinds = hand.blinds ?? [50, 100];
    const seats = hand.seats ?? [];
    if (seats.length < 2) {
      warnings.push({ handNo: hand.handNo, exportStatus: 'unsupported', reason: 'not enough seats' });
      continue;
    }
    lines.push(`PokerStars Hand #AIH${gameId}-${hand.handNo}: Hold'em No Limit (${blinds[0]}/${blinds[1]} PLAY) - ${exportedAt}`);
    const buttonSeat = seats.findIndex((seat) => seat.playerId === hand.button) + 1;
    lines.push(`Table 'AI-Holdem' ${seats.length}-max Seat #${buttonSeat || 1} is the button`);
    seats.forEach((seat, index) => {
      lines.push(`Seat ${index + 1}: ${seat.playerId} (${seat.stack} in chips)`);
    });
    const posts = hand.posts ?? [];
    if (posts[0]) {
      const extra = posts[0].allIn ? ' and is all-in' : '';
      lines.push(`${posts[0].playerId}: posts small blind ${posts[0].amount}${extra}`);
    }
    if (posts[1]) {
      const extra = posts[1].allIn ? ' and is all-in' : '';
      lines.push(`${posts[1].playerId}: posts big blind ${posts[1].amount}${extra}`);
    }
    let street = 'preflop';
    lines.push('*** HOLE CARDS ***');
    if (hand.heroCards?.length) lines.push(`Dealt to user ${formatCards(hand.heroCards)}`);
    const actions = hand.actions ?? [];
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      if (action.street && action.street !== street) {
        emitStreetHeaders(lines, hand.board, street, action.street);
        street = action.street;
      }
      const line = formatActionLine(hand, action, i);
      if (line) lines.push(line);
    }

    for (const [pid, amount] of Object.entries(hand.uncalledReturns ?? {})) {
      if (amount > 0) lines.push(`Uncalled bet (${amount}) returned to ${pid}`);
    }

    const remaining = streetFromBoard(hand.board);
    if (remaining !== street) emitStreetHeaders(lines, hand.board, street, remaining);

    const showdown = hand.showdown;
    const hasShowdown = Boolean(
      (showdown?.reveals?.length ?? 0) > 0 || (showdown?.mucks?.length ?? 0) > 0,
    );
    if (hasShowdown) {
      lines.push('*** SHOW DOWN ***');
      for (const reveal of showdown.reveals ?? []) {
        const name = reveal.handName ? ` (${reveal.handName})` : '';
        lines.push(`${reveal.playerId}: shows ${formatCards(reveal.cards)}${name}`);
      }
      for (const pid of showdown.mucks ?? []) {
        lines.push(`${pid}: mucks`);
      }
    }

    for (const pot of hand.pots ?? []) {
      for (const winner of pot.winners ?? []) {
        if (winner?.playerId == null || winner.share == null) continue;
        const source = (pot.potIndex ?? 0) === 0 ? 'pot' : `side pot-${pot.potIndex}`;
        lines.push(`${winner.playerId} collected ${winner.share} from ${source}`);
      }
    }

    const pot = (hand.pots ?? []).reduce((sum, item) => sum + (item.amount ?? 0), 0);
    lines.push('*** SUMMARY ***');
    lines.push(`Total pot ${pot} | Rake 0`);
    if (hand.board?.length) lines.push(`Board ${formatCards(hand.board)}`);
    lines.push('');
  }
  return { text: lines.join('\n'), warnings };
}
