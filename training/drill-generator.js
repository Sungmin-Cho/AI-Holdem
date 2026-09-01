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
    const spot = key.includes('bbDefense') ? '6max-100bb-bb-vs-single-raise' : '6max-100bb-btn-rfi-unopened';
    return [questionFrom({ mode, spotKey: spot, skillKey: key, nonce, handClass: 'AJo' })];
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
