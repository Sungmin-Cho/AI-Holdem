// Pure, dependency-free poker math shared by tools, training, the relay and the
// browser. Cards are engine strings ('As', 'Td', '2c'); internally a card is an
// integer 0..51 with rank = card >> 2 (0 = deuce .. 12 = ace) and suit = card & 3.
// Every Monte Carlo helper takes an explicit seed so results are reproducible.

const RANK_CHARS = '23456789TJQKA';
const SUIT_CHARS = 'shdc';
const CATEGORY_SPAN = 13 ** 5;

export const CATEGORY_NAMES = Object.freeze([
  '하이 카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시',
]);

export function cardInt(card) {
  if (typeof card !== 'string' || card.length !== 2) return -1;
  const rank = RANK_CHARS.indexOf(card[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(card[1].toLowerCase());
  return rank < 0 || suit < 0 ? -1 : rank * 4 + suit;
}

export function cardStr(card) {
  return `${RANK_CHARS[card >> 2]}${SUIT_CHARS[card & 3]}`;
}

export function toCardInts(cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  const out = cards.map(card => (typeof card === 'number' ? card : cardInt(card)));
  if (out.some(card => !Number.isInteger(card) || card < 0 || card > 51)) throw new TypeError('invalid card');
  if (new Set(out).size !== out.length) throw new TypeError('duplicate card');
  return out;
}

const STRAIGHTS = [];
for (let high = 12; high >= 4; high -= 1) STRAIGHTS.push([high, 0x1f << (high - 4)]);
STRAIGHTS.push([3, 0x100f]);

function straightHigh(mask) {
  for (const [high, bits] of STRAIGHTS) if ((mask & bits) === bits) return high;
  return -1;
}

function popcount(value) {
  let x = value;
  let n = 0;
  while (x) { x &= x - 1; n += 1; }
  return n;
}

function topRanks(mask, count) {
  let out = 0;
  let taken = 0;
  for (let rank = 12; rank >= 0 && taken < count; rank -= 1) {
    if (mask & (1 << rank)) { out = out * 13 + rank; taken += 1; }
  }
  for (; taken < count; taken += 1) out *= 13;
  return out;
}

// Integer hand score for 1..7 card ints; higher is stronger. Category is
// Math.floor(score / 13 ** 5). Fewer than five cards cannot make a straight or flush.
export function scoreCards(cards) {
  const suitMasks = [0, 0, 0, 0];
  const counts = new Int8Array(13);
  let rankMask = 0;
  for (const card of cards) {
    const rank = card >> 2;
    suitMasks[card & 3] |= 1 << rank;
    counts[rank] += 1;
    rankMask |= 1 << rank;
  }
  for (const mask of suitMasks) {
    if (popcount(mask) >= 5) {
      const high = straightHigh(mask);
      return high >= 0 ? 8 * CATEGORY_SPAN + high : 5 * CATEGORY_SPAN + topRanks(mask, 5);
    }
  }
  let quad = -1;
  const trips = [];
  const pairs = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    if (counts[rank] === 4) quad = rank;
    else if (counts[rank] === 3) trips.push(rank);
    else if (counts[rank] === 2) pairs.push(rank);
  }
  if (quad >= 0) return 7 * CATEGORY_SPAN + quad * 13 + topRanks(rankMask & ~(1 << quad), 1);
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const pair = trips.length > 1 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0];
    return 6 * CATEGORY_SPAN + trips[0] * 13 + pair;
  }
  const high = straightHigh(rankMask);
  if (high >= 0) return 4 * CATEGORY_SPAN + high;
  if (trips.length) return 3 * CATEGORY_SPAN + trips[0] * 169 + topRanks(rankMask & ~(1 << trips[0]), 2);
  if (pairs.length >= 2) {
    const [first, second] = pairs;
    return 2 * CATEGORY_SPAN + first * 169 + second * 13
      + topRanks(rankMask & ~(1 << first) & ~(1 << second), 1);
  }
  if (pairs.length === 1) return CATEGORY_SPAN + pairs[0] * 2197 + topRanks(rankMask & ~(1 << pairs[0]), 3);
  return topRanks(rankMask, 5);
}

export function categoryOfScore(score) {
  return Math.floor(score / CATEGORY_SPAN);
}

// ---- deterministic randomness -------------------------------------------

export function seedFrom(text) {
  let hash = 0x811c9dc5;
  for (const ch of String(text)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function xorshift32(seed) {
  let x = (seed >>> 0) || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

// ---- hand classes ---------------------------------------------------------

const CLASS_RANKS = 'AKQJT98765432';
export const HAND_CLASSES = Object.freeze((() => {
  const out = [];
  for (let i = 0; i < 13; i += 1) {
    out.push(`${CLASS_RANKS[i]}${CLASS_RANKS[i]}`);
    for (let j = i + 1; j < 13; j += 1) out.push(`${CLASS_RANKS[i]}${CLASS_RANKS[j]}s`, `${CLASS_RANKS[i]}${CLASS_RANKS[j]}o`);
  }
  return out;
})());
export const HAND_CLASS_INDEX = Object.freeze(Object.fromEntries(HAND_CLASSES.map((cls, i) => [cls, i])));

export function combosOfClass(cls) {
  if (!Object.hasOwn(HAND_CLASS_INDEX, cls)) throw new TypeError(`unknown hand class ${cls}`);
  const high = RANK_CHARS.indexOf(cls[0]);
  const low = RANK_CHARS.indexOf(cls[1]);
  const out = [];
  if (cls.length === 2) {
    for (let a = 0; a < 4; a += 1) for (let b = a + 1; b < 4; b += 1) out.push([high * 4 + a, low * 4 + b]);
  } else if (cls[2] === 's') {
    for (let s = 0; s < 4; s += 1) out.push([high * 4 + s, low * 4 + s]);
  } else {
    for (let a = 0; a < 4; a += 1) for (let b = 0; b < 4; b += 1) if (a !== b) out.push([high * 4 + a, low * 4 + b]);
  }
  return out;
}

export function comboCount(cls) {
  return cls.length === 2 ? 6 : cls[2] === 's' ? 4 : 12;
}

export function classOfCards(cards) {
  const [a, b] = toCardInts(cards);
  const [hi, lo] = (a >> 2) >= (b >> 2) ? [a, b] : [b, a];
  const high = RANK_CHARS[hi >> 2];
  const low = RANK_CHARS[lo >> 2];
  if (high === low) return `${high}${low}`;
  return `${high}${low}${(hi & 3) === (lo & 3) ? 's' : 'o'}`;
}

// ---- made hands and draws -------------------------------------------------

function rankName(rank) {
  return RANK_CHARS[rank];
}

// Korean, coaching-oriented description of what the hole cards contribute.
export function describeMadeHand(holeCards, boardCards) {
  const hole = toCardInts(holeCards);
  const board = toCardInts(boardCards);
  if (hole.length !== 2) throw new TypeError('two hole cards required');
  const all = [...hole, ...board];
  const score = scoreCards(all);
  const category = categoryOfScore(score);
  const boardScore = board.length ? scoreCards(board) : -1;
  const playsBoard = board.length === 5 && boardScore === score;
  const boardRanks = board.map(card => card >> 2).sort((a, b) => b - a);
  const holeRanks = hole.map(card => card >> 2);
  let detail = null;
  if (category === 1 && board.length) {
    const pairRank = holeRanks[0] === holeRanks[1] ? holeRanks[0]
      : holeRanks.find(rank => boardRanks.includes(rank));
    const distinctBoard = [...new Set(boardRanks)];
    if (pairRank === undefined) detail = '보드 페어';
    else if (holeRanks[0] === holeRanks[1]) {
      detail = pairRank > distinctBoard[0] ? '오버페어' : pairRank > distinctBoard.at(-1) ? '미들 포켓페어' : '언더페어';
    } else if (pairRank === distinctBoard[0]) detail = '탑페어';
    else if (pairRank === distinctBoard[1]) detail = '세컨드페어';
    else detail = '약한 페어';
  } else if (category === 3 && board.length) {
    const tripsRank = Math.floor((score - 3 * CATEGORY_SPAN) / 169);
    const fromHole = holeRanks.filter(rank => rank === tripsRank).length;
    detail = fromHole === 2 ? '셋' : fromHole === 1 ? '트립스' : '보드 트리플';
  }
  return { category, name: CATEGORY_NAMES[category], detail, playsBoard,
    label: playsBoard ? `${CATEGORY_NAMES[category]}(보드 플레이)` : detail ? `${CATEGORY_NAMES[category]} · ${detail}` : CATEGORY_NAMES[category] };
}

// Flush and straight draws and the cards that complete them ("outs" here means
// completing cards, not guaranteed winners). Straight and flush completion are
// judged separately, so a combo draw keeps both its straight type and its
// flush outs; the out count is their union. Flop and turn only.
function rankMaskOf(cards) {
  let mask = 0;
  for (const card of cards) mask |= 1 << (card >> 2);
  return mask;
}

export function drawsOf(holeCards, boardCards) {
  const hole = toCardInts(holeCards);
  const board = toCardInts(boardCards);
  const empty = { flushDraw: false, straightDraw: null, outs: 0, outCards: [] };
  if (board.length < 3 || board.length > 4) return empty;
  const all = [...hole, ...board];
  // A flush or better has nothing to draw to; a made straight can still draw
  // to a flush (a redraw), but not to another straight.
  if (categoryOfScore(scoreCards(all)) >= 5) return empty;
  const used = new Set(all);
  const suitCount = [0, 0, 0, 0];
  for (const card of all) suitCount[card & 3] += 1;
  const boardSuits = [0, 0, 0, 0];
  for (const card of board) boardSuits[card & 3] += 1;
  const flushSuit = suitCount.findIndex((count, suit) => count === 4 && hole.some(card => (card & 3) === suit));
  const hasStraight = straightHigh(rankMaskOf(all)) >= 0;
  const straightRanks = new Set();
  const outCards = [];
  for (let card = 0; card < 52; card += 1) {
    if (used.has(card)) continue;
    const makesStraight = !hasStraight && straightHigh(rankMaskOf([...all, card])) >= 0
      && straightHigh(rankMaskOf([...board, card])) < 0;
    const makesFlush = flushSuit >= 0 && (card & 3) === flushSuit && boardSuits[flushSuit] + 1 < 5;
    if (makesStraight) straightRanks.add(card >> 2);
    if (makesStraight || makesFlush) outCards.push(cardStr(card));
  }
  // Two completing ranks are open-ended only at both ends of four in a row;
  // otherwise they are two gutshots (the same eight cards, a different shape).
  const mask = rankMaskOf(all);
  const run4 = (low) => [0, 1, 2, 3].every((k) => {
    const rank = low + k;
    return rank === -1 ? (mask & (1 << 12)) !== 0 : rank >= 0 && rank <= 12 && (mask & (1 << rank)) !== 0;
  });
  const openEnded = [...straightRanks].some((rank) => {
    const lowEnd = rank === 12 ? -1 : rank; // an ace completes the wheel below a 2-3-4-5 run
    return (straightRanks.has(rank + 5) && run4(lowEnd + 1)) || (rank === 12 && straightRanks.has(4) && run4(0));
  });
  const straightDraw = straightRanks.size >= 2 ? (openEnded ? 'open-ended' : 'double-gutshot') : straightRanks.size === 1 ? 'gutshot' : null;
  return { flushDraw: flushSuit >= 0, straightDraw, outs: outCards.length, outCards };
}

// ---- Monte Carlo equity ---------------------------------------------------

function drawCard(next, used) {
  for (;;) {
    const card = next() % 52;
    if (!used[card]) { used[card] = 1; return card; }
  }
}

// Individual combos of a range that avoid the known cards, each weighted by its
// class frequency: card removal is applied per combo, not per class.
function rangeCombos(range, known) {
  const combos = [];
  let total = 0;
  for (let i = 0; i < 169; i += 1) {
    const freq = Array.isArray(range) || range instanceof Float64Array ? range[i] : range?.[HAND_CLASSES[i]];
    if (!(typeof freq === 'number' && freq > 0)) continue;
    for (const [a, b] of combosOfClass(HAND_CLASSES[i])) {
      if (known[a] || known[b]) continue;
      combos.push([a, b, freq]);
      total += freq;
    }
  }
  return { combos, total };
}

// One weighted combo of a prepared range (its known cards already removed).
function drawCombo(next, prepared) {
  const { combos, total } = prepared;
  let pick = (next() / 4294967296) * total;
  let index = 0;
  while (index < combos.length - 1 && (pick -= combos[index][2]) >= 0) index += 1;
  return combos[index];
}

// Range: object {class: frequency} or array of 169 frequencies; combos weighted.
export function rangeWeights(range) {
  const weights = new Float64Array(169);
  for (let i = 0; i < 169; i += 1) {
    const freq = Array.isArray(range) ? range[i] : range?.[HAND_CLASSES[i]];
    if (typeof freq === 'number' && freq > 0) weights[i] = freq * comboCount(HAND_CLASSES[i]);
  }
  return weights;
}

// Share of the pot won by hero (ties split) against opponents dealt from
// `ranges` (null entry = any two cards), over `samples` random runouts.
export function equityVs({ holeCards, boardCards = [], ranges = [null], samples = 2000, seed = 1 }) {
  const hole = toCardInts(holeCards);
  const board = toCardInts(boardCards);
  if (hole.length !== 2 || board.length > 5 || !ranges.length || ranges.length > 8) throw new TypeError('invalid equity input');
  const next = xorshift32(seed);
  const known = new Uint8Array(52);
  for (const card of [...hole, ...board]) known[card] = 1;
  const prepared = ranges.map(range => {
    if (range === null) return null;
    const combos = rangeCombos(range, known);
    if (!combos.combos.length) throw new RangeError('a range has no combo left after card removal');
    return combos;
  });
  let won = 0;
  let dealt = 0;
  const used = new Uint8Array(52);
  for (let n = 0; n < samples; n += 1) {
    used.set(known);
    // Range opponents are drawn independently from their own ranges and a deal
    // in which two of them share a card is rejected as a whole: the accepted
    // deals follow the joint distribution whatever the opponents' order.
    // Random hands are dealt from the cards left afterwards.
    const villains = new Array(prepared.length);
    let blocked = false;
    for (let i = 0; i < prepared.length && !blocked; i += 1) {
      if (!prepared[i]) continue;
      const [a, b] = drawCombo(next, prepared[i]);
      if (used[a] || used[b]) { blocked = true; break; }
      used[a] = 1; used[b] = 1;
      villains[i] = [a, b];
    }
    if (blocked) continue;
    for (let i = 0; i < prepared.length; i += 1) {
      if (!prepared[i]) villains[i] = [drawCard(next, used), drawCard(next, used)];
    }
    const runout = [...board];
    while (runout.length < 5) runout.push(drawCard(next, used));
    const heroScore = scoreCards([...hole, ...runout]);
    let best = heroScore;
    let tied = 1;
    let heroBest = true;
    for (const villain of villains) {
      const score = scoreCards([...villain, ...runout]);
      if (score > best) { best = score; heroBest = false; tied = 1; }
      else if (score === best) tied += 1;
    }
    if (heroBest) won += 1 / tied;
    dealt += 1;
  }
  if (!dealt) throw new RangeError('no compatible deal for these ranges');
  return won / dealt;
}
