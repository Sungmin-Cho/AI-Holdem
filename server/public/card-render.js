/** Shared playing-card renderer for the table, board, log, replayer and study
 * room. Suit glyphs are inlined (no page sprite needed) and colours come from
 * design tokens via the suit-* class, so the four-colour / two-colour deck
 * preference is pure CSS. Class names and accessible labels match the
 * previous table renderer, which browser journeys depend on. */
const SVG_NS = 'http://www.w3.org/2000/svg';

export const SUITS = Object.freeze({
  s: Object.freeze({ key: 's', name: '스페이드', red: false, path: 'M12 2C9.2 6.6 4.5 9.3 4.5 13.2 4.5 15.6 6.3 17.2 8.4 17.2 9.6 17.2 10.6 16.7 11.3 15.9 11.1 17.8 10.3 19.3 8.9 20.3L8.9 21.5 15.1 21.5 15.1 20.3C13.7 19.3 12.9 17.8 12.7 15.9 13.4 16.7 14.4 17.2 15.6 17.2 17.7 17.2 19.5 15.6 19.5 13.2 19.5 9.3 14.8 6.6 12 2Z' }),
  h: Object.freeze({ key: 'h', name: '하트', red: true, path: 'M12 21.1 10.55 19.78C5.4 15.11 2 12.03 2 8.25 2 5.17 4.42 2.75 7.5 2.75 9.24 2.75 10.91 3.56 12 4.84 13.09 3.56 14.76 2.75 16.5 2.75 19.58 2.75 22 5.17 22 8.25 22 12.03 18.6 15.11 13.45 19.78L12 21.1Z' }),
  d: Object.freeze({ key: 'd', name: '다이아몬드', red: true, path: 'M12 2.2 19.2 12 12 21.8 4.8 12Z' }),
  c: Object.freeze({ key: 'c', name: '클럽', red: false, path: 'M12 2.5C10 2.5 8.4 4.1 8.4 6.1 8.4 6.9 8.7 7.7 9.2 8.3 8.8 8.2 8.5 8.1 8.1 8.1 6.1 8.1 4.5 9.7 4.5 11.7 4.5 13.7 6.1 15.3 8.1 15.3 9.4 15.3 10.5 14.7 11.2 13.7 11 16 10.2 18.9 8.9 20.3L8.9 21.5 15.1 21.5 15.1 20.3C13.8 18.9 13 16 12.8 13.7 13.5 14.7 14.6 15.3 15.9 15.3 17.9 15.3 19.5 13.7 19.5 11.7 19.5 9.7 17.9 8.1 15.9 8.1 15.5 8.1 15.2 8.2 14.8 8.3 15.3 7.7 15.6 6.9 15.6 6.1 15.6 4.1 14 2.5 12 2.5Z' }),
});
const RANKS = new Set(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);

/** Parse an engine card code ("Ks", "Td"). Invalid input yields rank "?". */
export function parseCard(code) {
  if (typeof code !== 'string' || code.length !== 2 || !RANKS.has(code[0]) || !SUITS[code[1]]) {
    return { valid: false, rank: '?', suit: null, red: false };
  }
  const suit = SUITS[code[1]];
  return { valid: true, rank: code[0] === 'T' ? '10' : code[0], suit, red: suit.red };
}

export function cardLabel(parsed) {
  return `${parsed.rank} ${parsed.suit?.name ?? ''}`.trim();
}

function suitIcon(doc, suit, className) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', suit.path);
  svg.append(path);
  return svg;
}

/** A table/board/replay card. Face-down, empty and invalid codes render as a
 * back (or an empty slot when `slot`), never as a guessed face. */
export function renderCard(code, { faceDown = false, small = false, hero = false, slot = false, doc = globalThis.document } = {}) {
  const node = doc.createElement('div');
  const classes = ['card'];
  if (small) classes.push('card--sm');
  if (hero) classes.push('card--hero');
  if (slot) {
    node.className = [...classes, 'card--slot'].join(' ');
    return node;
  }
  const parsed = parseCard(code);
  if (faceDown || !parsed.valid) {
    node.className = [...classes, 'card--back'].join(' ');
    return node;
  }
  classes.push(`suit-${parsed.suit.key}`);
  if (parsed.red) classes.push('is-red');
  node.className = classes.join(' ');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', cardLabel(parsed));
  const rank = doc.createElement('span');
  rank.className = parsed.rank === '10' ? 'card-rank is-ten' : 'card-rank';
  rank.textContent = parsed.rank;
  node.append(rank, suitIcon(doc, parsed.suit, 'card-suit'), suitIcon(doc, parsed.suit, 'card-pip'));
  return node;
}

/** Inline card for logs and text rows. */
export function renderMiniCard(code, { doc = globalThis.document } = {}) {
  const parsed = parseCard(code);
  const node = doc.createElement('span');
  node.className = ['mini-card', parsed.suit ? `suit-${parsed.suit.key}` : '', parsed.red ? 'is-red' : ''].filter(Boolean).join(' ');
  node.setAttribute('aria-label', cardLabel(parsed));
  node.append(doc.createTextNode(parsed.rank));
  if (parsed.suit) node.append(suitIcon(doc, parsed.suit, 'mini-suit'));
  return node;
}

/** Hand-class card pair for the study room ("ATo", "QQ", "KJs"). Ranks only;
 * suited/offsuit is stated in text so no specific suit is invented. */
export function handClassParts(handClass) {
  const match = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/.exec(String(handClass ?? ''));
  if (!match) return null;
  const rank = (r) => (r === 'T' ? '10' : r);
  const kind = match[1] === match[2] ? 'pair' : match[3] === 's' ? 'suited' : 'offsuit';
  return { ranks: [rank(match[1]), rank(match[2])], kind, label: { pair: '페어', suited: '같은 무늬', offsuit: '다른 무늬' }[kind] };
}
