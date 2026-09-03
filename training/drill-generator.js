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

function questionFrom({ mode, spotKey, handClass = 'AJo', skillKey, nonce, providerVersion = '1.0.0' }) {
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
      providerId: 'local-preflop-baseline',
      providerVersion,
    },
  };
}

const POSITIONS = ['btn', 'co', 'mp', 'utg', 'sb', 'bb'];
// A leak names a position and a situation; the drill should follow it rather
// than collapse every leak onto one of two spots with one hand.
const HAND_ROTATION = ['AJo', 'KQs', 'A5s', '77', 'QTs', 'T9s', 'KJo', '22'];

export function spotForSkillKey(skillKey) {
  const key = String(skillKey ?? '').toLowerCase();
  const position = POSITIONS.find((name) => key.includes(`.${name}`) || key.endsWith(`-${name}`));
  if (key.includes('defense') || key.includes('vs-')) {
    return `6max-100bb-bb-vs-single-raise${position && position !== 'bb' ? `-${position}` : ''}`
      .replace(/-bb$/, '');
  }
  return `6max-100bb-${position ?? 'btn'}-rfi-unopened`;
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
} = {}) {
  const nonce = 1;
  if (mode === 'leak') {
    const leak = profile?.leaks?.[0];
    const key = leak?.recommendedDrill ?? leak?.id ?? 'preflop.rfi.BTN';
    const spot = spotForSkillKey(key);
    return [questionFrom({
      mode, spotKey: spot, skillKey: key, nonce, handClass: handClassForSkillKey(key),
    })];
  }
  if (mode === 'mistake-review') {
    return mistakes.slice(0, limit).map((item, index) => {
      const [spot, handClass] = String(item.spotSignature).split(':');
      return questionFrom({
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
    mode: 'free',
    spotKey: spot,
    skillKey: 'preflop.free',
    nonce: index + 1,
  }));
}
