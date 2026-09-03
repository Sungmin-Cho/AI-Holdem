import { createHash } from 'node:crypto';

const DEFAULT_SPOTS = [
  '6max-100bb-utg-rfi-unopened',
  '6max-100bb-hj-rfi-unopened',
  '6max-100bb-co-rfi-unopened',
  '6max-100bb-btn-rfi-unopened',
  '6max-100bb-sb-rfi-unopened',
  '6max-100bb-bb-vs-single-raise',
];

function rng(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
  let a = Number.parseInt(hex, 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const copy = [...items];
  const rand = rng(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function questionFrom({
  mode, spotKey, handClass = 'AJo', skillKey, nonce,
  providerId = 'local-preflop-baseline', providerVersion,
}) {
  if (typeof providerVersion !== 'string') {
    const error = new Error('drill question needs the dataset provider version');
    error.code = 'PROVIDER_VERSION_REQUIRED';
    throw error;
  }
  const pos = (spotKey.split('-')[2] ?? 'btn').toUpperCase();
  return {
    questionId: `drill:${providerVersion}:${spotKey}:${handClass}:${nonce}`,
    mode,
    skillKey,
    prompt: {
      position: pos,
      handClass,
      stackBb: 100,
      spotKey,
      actionHistory: spotKey.endsWith('vs-single-raise') ? ['raise'] : [],
      legalActions: spotKey.endsWith('vs-single-raise')
        ? ['fold', 'call', 'raise:8.5']
        : ['fold', 'raise:2.5'],
    },
    answerPolicy: {
      providerId,
      providerVersion,
    },
  };
}

// The spot grammar, not the dataset — `training/` stays pure. A leak names a
// seat and a situation, and the drill should follow it rather than collapse
// every leak onto one of two spots with one hand.
const RFI_SEATS = ['utg', 'hj', 'co', 'btn', 'sb'];
const DEFENSE_SEATS = ['bb', 'sb', 'btn'];
const SEAT_ALIASES = new Map([['mp', 'hj'], ['lj', 'hj'], ['bu', 'btn'], ['button', 'btn']]);
const HAND_ROTATION = ['AJo', 'KQs', 'A5s', '77', 'QTs', 'T9s', 'KJo', '22'];

function seatIn(key, seats) {
  for (const seat of seats) {
    if (new RegExp(`(^|[^a-z])${seat}([^a-z]|$)`).test(key)) return seat;
  }
  for (const [alias, seat] of SEAT_ALIASES) {
    if (!seats.includes(seat)) continue;
    if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(key)) return seat;
  }
  return null;
}

export function spotForSkillKey(skillKey) {
  const key = String(skillKey ?? '').toLowerCase();
  // `skillKeyOf` emits `preflop.rfi.<POS>`, `preflop.bbDefense.vsRaise` and
  // `preflop.vsRaise.<POS>`. The last two have no hyphen, so testing for `vs-`
  // alone sent every non-BB defence leak to an RFI spot.
  if (/defense|defence|vs-?raise|vs-/.test(key)) {
    // Named by the seat that defends: `preflop.vsRaise.CO` carries it after the
    // marker, `preflop.bbDefense.vsRaise` before it. Seats the grammar has no
    // defence spot for fall back to BB rather than to an unrelated RFI spot.
    const parts = key.split(/defense|defence|vs-?raise|vs-/);
    const defender = seatIn(parts[0] ?? '', DEFENSE_SEATS)
      ?? seatIn(parts.slice(1).join(' '), DEFENSE_SEATS)
      ?? 'bb';
    return `6max-100bb-${defender}-vs-single-raise`;
  }
  return `6max-100bb-${seatIn(key, RFI_SEATS) ?? 'btn'}-rfi-unopened`;
}

export function handClassForSkillKey(skillKey) {
  const key = String(skillKey ?? '');
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum = (sum * 31 + key.charCodeAt(i)) >>> 0;
  return HAND_ROTATION[sum % HAND_ROTATION.length];
}

export function generateQueue({
  mode = 'free',
  profile,
  mistakes = [],
  seed = '0',
  now = new Date().toISOString(),
  spotKey,
  limit = 10,
  // 데이터셋이 밝히는 provider. 기본값을 두면 데이터셋을 갈아도 질문 id와
  // answerPolicy가 옛 버전을 주장하므로, 없으면 fail-closed다.
  source,
} = {}) {
  if (typeof source?.version !== 'string' || typeof source?.id !== 'string') {
    const error = new Error('drill queue needs the dataset source');
    error.code = 'PROVIDER_VERSION_REQUIRED';
    throw error;
  }
  const nonce = 1;
  const provider = { providerId: source.id, providerVersion: source.version };
  if (mode === 'leak') {
    const leak = profile?.leaks?.[0];
    const key = leak?.recommendedDrill ?? leak?.id ?? 'preflop.rfi.BTN';
    const spot = spotForSkillKey(key);
    return [questionFrom({
      ...provider,
      mode, spotKey: spot, skillKey: key, nonce, handClass: handClassForSkillKey(key),
    })];
  }
  if (mode === 'mistake-review') {
    return mistakes.slice(0, limit).map((item, index) => {
      const [spot, handClass] = String(item.spotSignature).split(':');
      return questionFrom({
        ...provider,
        mode,
        spotKey: spot,
        handClass: handClass ?? 'AJo',
        skillKey: item.skillKey,
        nonce: index + 1,
      });
    });
  }
  if (mode === 'daily') {
    const due = mistakes.filter((item) => !item.nextReviewAt || item.nextReviewAt <= now);
    return due.slice(0, limit).map((item, index) => {
      const [spot, handClass] = String(item.spotSignature).split(':');
      return questionFrom({
        ...provider,
        mode,
        spotKey: spot,
        handClass: handClass ?? 'AJo',
        skillKey: item.skillKey,
        nonce: index + 1,
      });
    });
  }
  const spots = spotKey ? [spotKey] : shuffle(DEFAULT_SPOTS, seed);
  return spots.slice(0, limit).map((spot, index) => questionFrom({
    ...provider,
    mode: 'free',
    spotKey: spot,
    skillKey: 'preflop.free',
    nonce: index + 1,
  }));
}
