import { allHandClasses, handClassOf } from '../cards.js';

export { handClassOf };

export const TENDENCY_SCHEMA_VERSION = 1;
export const TENDENCY_MIN_HANDS = 60;
export const TENDENCY_MIN_N = 8;
export const POSITIONS = Object.freeze(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
export const STREETS = Object.freeze(['flop', 'turn', 'river']);
export const POSITIONAL_SEATS = Object.freeze([5, 6, 7]);
export const ENGINE_POSITION_LABELS = Object.freeze([
  'BTN/SB', 'BB', 'BTN', 'SB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4', 'CO',
]);
export const HAND_CLASSES = Object.freeze(allHandClasses());

const POSITION_SET = new Set(POSITIONS);
const STREET_SET = new Set(STREETS);
const CLASS_SET = new Set(HAND_CLASSES);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nk() {
  return { n: 0, k: 0 };
}

function fcr() {
  return { n: 0, fold: 0, call: 0, raise: 0 };
}

function hist() {
  return { n: 0, buckets: {} };
}

function positionBlock() {
  return {
    dealt: 0,
    vpip: nk(),
    rfi: nk(),
    limp: nk(),
    vsRaise: fcr(),
  };
}

function streetBlock() {
  return {
    facingBet: fcr(),
    checkedTo: { n: 0, check: 0, bet: 0 },
    betSizePot: hist(),
  };
}

export function emptyTendency(subject) {
  const byPosition = {};
  const entered = {};
  for (const pos of POSITIONS) {
    byPosition[pos] = positionBlock();
    const classes = {};
    for (const handClass of HAND_CLASSES) classes[handClass] = nk();
    entered[pos] = classes;
  }
  const byStreet = {};
  for (const street of STREETS) byStreet[street] = streetBlock();
  return {
    schemaVersion: TENDENCY_SCHEMA_VERSION,
    subject,
    hands: 0,
    decisions: 0,
    sources: [],
    seatMix: {},
    preflop: {
      vpip: nk(),
      pfr: nk(),
      limp: nk(),
      vsRaise: fcr(),
      vs3Bet: fcr(),
      byPosition,
      openSizeBb: hist(),
      threeBetMultiple: hist(),
      entered,
    },
    postflop: {
      byStreet,
      cbet: nk(),
      wtsd: nk(),
      wsd: nk(),
      af: { bets: 0, raises: 0, calls: 0 },
      bluff: nk(),
    },
  };
}

export function rateOf(counter) {
  if (!counter || !counter.n) return null;
  return counter.k / counter.n;
}

export function medianOf(buckets) {
  if (!buckets || typeof buckets !== 'object') return null;
  const samples = [];
  for (const key of Object.keys(buckets).sort((a, b) => Number(a) - Number(b))) {
    const count = buckets[key];
    const value = Number(key);
    if (!Number.isFinite(value) || !Number.isInteger(count) || count < 0) continue;
    for (let i = 0; i < count; i += 1) samples.push(value);
  }
  if (samples.length === 0) return null;
  const mid = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) return samples[mid];
  return (samples[mid - 1] + samples[mid]) / 2;
}

export function bucketKey(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return null;
  const n = Math.round(value / step) * step;
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return n.toFixed(Math.max(decimals, 1));
}

export function normalizePosition(engineLabel, liveSeats) {
  if (!POSITIONAL_SEATS.includes(liveSeats)) return null;
  if (engineLabel === 'BTN/SB') return 'BTN';
  if (engineLabel === 'BTN' || engineLabel === 'SB' || engineLabel === 'BB'
    || engineLabel === 'CO' || engineLabel === 'UTG') {
    return engineLabel;
  }
  const match = typeof engineLabel === 'string' ? /^UTG\+(\d+)$/.exec(engineLabel) : null;
  if (!match) return null;
  const k = Number(match[1]);
  if (!Number.isInteger(k) || k < 1) return null;
  const index = 3 + k;
  const hjIndex = liveSeats - 2;
  if (index === hjIndex) return 'HJ';
  if (index < hjIndex) return 'UTG';
  return null;
}

function invalid(message) {
  throw coded('TENDENCY_INVALID', message);
}

function assertInt(value, label) {
  if (!Number.isInteger(value) || value < 0) invalid(`${label} must be a non-negative integer`);
}

function assertNk(counter, label) {
  if (!counter || typeof counter !== 'object') invalid(`${label} is missing`);
  assertInt(counter.n, `${label}.n`);
  assertInt(counter.k, `${label}.k`);
  if (counter.k > counter.n) invalid(`${label} k > n`);
}

function assertFcr(counter, label) {
  if (!counter || typeof counter !== 'object') invalid(`${label} is missing`);
  assertInt(counter.n, `${label}.n`);
  assertInt(counter.fold, `${label}.fold`);
  assertInt(counter.call, `${label}.call`);
  assertInt(counter.raise, `${label}.raise`);
  if (counter.fold + counter.call + counter.raise !== counter.n) {
    invalid(`${label} fold+call+raise != n`);
  }
}

function assertCheckedTo(counter, label) {
  if (!counter || typeof counter !== 'object') invalid(`${label} is missing`);
  assertInt(counter.n, `${label}.n`);
  assertInt(counter.check, `${label}.check`);
  assertInt(counter.bet, `${label}.bet`);
  if (counter.check + counter.bet !== counter.n) invalid(`${label} check+bet != n`);
}

function assertHist(histValue, label) {
  if (!histValue || typeof histValue !== 'object') invalid(`${label} is missing`);
  assertInt(histValue.n, `${label}.n`);
  if (!histValue.buckets || typeof histValue.buckets !== 'object' || Array.isArray(histValue.buckets)) {
    invalid(`${label}.buckets is missing`);
  }
  let sum = 0;
  for (const [key, count] of Object.entries(histValue.buckets)) {
    assertInt(count, `${label}.buckets.${key}`);
    sum += count;
  }
  if (sum !== histValue.n) invalid(`${label} bucket sum != n`);
}

export function assertTendency(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('tendency is not an object');
  }
  if (value.schemaVersion !== TENDENCY_SCHEMA_VERSION) invalid('schemaVersion');
  if (typeof value.subject !== 'string' || value.subject.length === 0) invalid('subject');
  assertInt(value.hands, 'hands');
  assertInt(value.decisions, 'decisions');
  if (!value.seatMix || typeof value.seatMix !== 'object' || Array.isArray(value.seatMix)) {
    invalid('seatMix');
  }
  if (!Array.isArray(value.sources)) invalid('sources');
  const pre = value.preflop;
  if (!pre || typeof pre !== 'object') invalid('preflop');
  assertNk(pre.vpip, 'preflop.vpip');
  assertNk(pre.pfr, 'preflop.pfr');
  assertNk(pre.limp, 'preflop.limp');
  assertFcr(pre.vsRaise, 'preflop.vsRaise');
  assertFcr(pre.vs3Bet, 'preflop.vs3Bet');
  assertHist(pre.openSizeBb, 'preflop.openSizeBb');
  assertHist(pre.threeBetMultiple, 'preflop.threeBetMultiple');
  if (!pre.byPosition || typeof pre.byPosition !== 'object') invalid('byPosition');
  for (const pos of Object.keys(pre.byPosition)) {
    if (!POSITION_SET.has(pos)) invalid(`unknown position ${pos}`);
    const block = pre.byPosition[pos];
    assertInt(block.dealt, `byPosition.${pos}.dealt`);
    assertNk(block.vpip, `byPosition.${pos}.vpip`);
    assertNk(block.rfi, `byPosition.${pos}.rfi`);
    assertNk(block.limp, `byPosition.${pos}.limp`);
    assertFcr(block.vsRaise, `byPosition.${pos}.vsRaise`);
  }
  if (!pre.entered || typeof pre.entered !== 'object') invalid('entered');
  for (const pos of Object.keys(pre.entered)) {
    if (!POSITION_SET.has(pos)) invalid(`unknown entered position ${pos}`);
    const classes = pre.entered[pos];
    if (!classes || typeof classes !== 'object') invalid(`entered.${pos}`);
    for (const handClass of Object.keys(classes)) {
      if (!CLASS_SET.has(handClass)) invalid(`unknown class ${handClass}`);
      assertNk(classes[handClass], `entered.${pos}.${handClass}`);
    }
  }
  const post = value.postflop;
  if (!post || typeof post !== 'object') invalid('postflop');
  if (!post.byStreet || typeof post.byStreet !== 'object') invalid('byStreet');
  for (const street of Object.keys(post.byStreet)) {
    if (!STREET_SET.has(street)) invalid(`unknown street ${street}`);
    const block = post.byStreet[street];
    assertFcr(block.facingBet, `byStreet.${street}.facingBet`);
    assertCheckedTo(block.checkedTo, `byStreet.${street}.checkedTo`);
    assertHist(block.betSizePot, `byStreet.${street}.betSizePot`);
  }
  assertNk(post.cbet, 'cbet');
  assertNk(post.wtsd, 'wtsd');
  assertNk(post.wsd, 'wsd');
  assertNk(post.bluff, 'bluff');
  if (!post.af || typeof post.af !== 'object') invalid('af');
  assertInt(post.af.bets, 'af.bets');
  assertInt(post.af.raises, 'af.raises');
  assertInt(post.af.calls, 'af.calls');
}

function addNk(target, src) {
  if (!src) return;
  target.n += src.n ?? 0;
  target.k += src.k ?? 0;
}

function addFcr(target, src) {
  if (!src) return;
  target.n += src.n ?? 0;
  target.fold += src.fold ?? 0;
  target.call += src.call ?? 0;
  target.raise += src.raise ?? 0;
}

function addCheckedTo(target, src) {
  if (!src) return;
  target.n += src.n ?? 0;
  target.check += src.check ?? 0;
  target.bet += src.bet ?? 0;
}

function addHist(target, src) {
  if (!src) return;
  target.n += src.n ?? 0;
  for (const [key, count] of Object.entries(src.buckets ?? {})) {
    target.buckets[key] = (target.buckets[key] ?? 0) + count;
  }
}

export function mergeTendency(a, b) {
  const out = structuredClone(a);
  out.hands += b.hands ?? 0;
  for (const key of ['excludedAssistedHands','excludedUnknownAssistanceHands']) {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  out.decisions += b.decisions ?? 0;
  out.sources = [...(a.sources ?? []), ...(b.sources ?? [])];
  out.seatMix = { ...(a.seatMix ?? {}) };
  for (const [key, count] of Object.entries(b.seatMix ?? {})) {
    out.seatMix[key] = (out.seatMix[key] ?? 0) + count;
  }
  addNk(out.preflop.vpip, b.preflop?.vpip);
  addNk(out.preflop.pfr, b.preflop?.pfr);
  addNk(out.preflop.limp, b.preflop?.limp);
  addFcr(out.preflop.vsRaise, b.preflop?.vsRaise);
  addFcr(out.preflop.vs3Bet, b.preflop?.vs3Bet);
  addHist(out.preflop.openSizeBb, b.preflop?.openSizeBb);
  addHist(out.preflop.threeBetMultiple, b.preflop?.threeBetMultiple);
  for (const pos of POSITIONS) {
    const src = b.preflop?.byPosition?.[pos];
    if (src) {
      out.preflop.byPosition[pos].dealt += src.dealt ?? 0;
      addNk(out.preflop.byPosition[pos].vpip, src.vpip);
      addNk(out.preflop.byPosition[pos].rfi, src.rfi);
      addNk(out.preflop.byPosition[pos].limp, src.limp);
      addFcr(out.preflop.byPosition[pos].vsRaise, src.vsRaise);
    }
    const enteredSrc = b.preflop?.entered?.[pos];
    if (enteredSrc) {
      for (const handClass of Object.keys(enteredSrc)) {
        if (!out.preflop.entered[pos][handClass]) out.preflop.entered[pos][handClass] = nk();
        addNk(out.preflop.entered[pos][handClass], enteredSrc[handClass]);
      }
    }
  }
  for (const street of STREETS) {
    const src = b.postflop?.byStreet?.[street];
    if (!src) continue;
    addFcr(out.postflop.byStreet[street].facingBet, src.facingBet);
    addCheckedTo(out.postflop.byStreet[street].checkedTo, src.checkedTo);
    addHist(out.postflop.byStreet[street].betSizePot, src.betSizePot);
  }
  addNk(out.postflop.cbet, b.postflop?.cbet);
  addNk(out.postflop.wtsd, b.postflop?.wtsd);
  addNk(out.postflop.wsd, b.postflop?.wsd);
  addNk(out.postflop.bluff, b.postflop?.bluff);
  out.postflop.af.bets += b.postflop?.af?.bets ?? 0;
  out.postflop.af.raises += b.postflop?.af?.raises ?? 0;
  out.postflop.af.calls += b.postflop?.af?.calls ?? 0;
  return out;
}
