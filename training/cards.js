const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANK_INDEX = Object.fromEntries(RANKS.map((rank, i) => [rank, i]));

function parseCard(card) {
  if (typeof card !== 'string' || card.length < 2) return null;
  const rank = card[0] === 'T' || card[0] === 't' ? 'T' : card[0].toUpperCase();
  const suit = card.slice(1).toLowerCase();
  if (!(rank in RANK_INDEX) || !/^[shdc]$/.test(suit)) return null;
  return { rank, suit };
}

export function handClassOf(holeCards) {
  if (!Array.isArray(holeCards) || holeCards.length !== 2) return null;
  const a = parseCard(holeCards[0]);
  const b = parseCard(holeCards[1]);
  if (!a || !b) return null;
  if (a.rank === b.rank) return `${a.rank}${b.rank}`;
  const [high, low] = RANK_INDEX[a.rank] < RANK_INDEX[b.rank] ? [a.rank, b.rank] : [b.rank, a.rank];
  return `${high}${low}${a.suit === b.suit ? 's' : 'o'}`;
}

export function allHandClasses() {
  const classes = [];
  for (let i = 0; i < RANKS.length; i += 1) {
    classes.push(`${RANKS[i]}${RANKS[i]}`);
    for (let j = i + 1; j < RANKS.length; j += 1) {
      classes.push(`${RANKS[i]}${RANKS[j]}s`);
      classes.push(`${RANKS[i]}${RANKS[j]}o`);
    }
  }
  return classes;
}
