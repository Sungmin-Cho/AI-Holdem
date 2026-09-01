function streetHeader(street) {
  if (street === 'flop') return '*** FLOP ***';
  if (street === 'turn') return '*** TURN ***';
  if (street === 'river') return '*** RIVER ***';
  return null;
}

function formatCards(cards) {
  return `[${(cards ?? []).join(' ')}]`;
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
    let street = 'preflop';
    lines.push('*** HOLE CARDS ***');
    if (hand.heroCards?.length) lines.push(`Dealt to user ${formatCards(hand.heroCards)}`);
    for (const action of hand.actions ?? []) {
      if (action.street !== street) {
        const header = streetHeader(action.street);
        if (header) {
          const board = (hand.board ?? []).slice(0, action.street === 'flop' ? 3 : action.street === 'turn' ? 4 : 5);
          lines.push(`${header} ${formatCards(board)}`);
        }
        street = action.street;
      }
      if (action.action === 'fold') lines.push(`${action.playerId}: folds`);
      else if (action.action === 'check') lines.push(`${action.playerId}: checks`);
      else if (action.action === 'call') lines.push(`${action.playerId}: calls ${action.amount}`);
      else if (action.action === 'raise') lines.push(`${action.playerId}: raises to ${action.amount}`);
    }
    const pot = (hand.pots ?? []).reduce((sum, item) => sum + (item.amount ?? 0), 0);
    lines.push('*** SUMMARY ***');
    lines.push(`Total pot ${pot} | Rake 0`);
    if (hand.board?.length) lines.push(`Board ${formatCards(hand.board)}`);
    for (const reveal of hand.showdown?.reveals ?? []) {
      lines.push(`${reveal.playerId}: shows ${formatCards(reveal.cards)}`);
    }
    lines.push('');
  }
  return { text: lines.join('\n'), warnings };
}
