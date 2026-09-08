import { STREETS, TENDENCY_MIN_N, medianOf, rateOf } from './contracts.js';

export const SIMILARITY_MIN_COMPONENTS = 6;

function pooledFacing(tendency) {
  let n = 0;
  let fold = 0;
  let call = 0;
  let raise = 0;
  for (const street of STREETS) {
    const row = tendency?.postflop?.byStreet?.[street]?.facingBet;
    if (!row) continue;
    n += row.n ?? 0;
    fold += row.fold ?? 0;
    call += row.call ?? 0;
    raise += row.raise ?? 0;
  }
  return { n, fold, call, raise };
}

function pooledBetSize(tendency) {
  const buckets = {};
  let n = 0;
  for (const street of STREETS) {
    const hist = tendency?.postflop?.byStreet?.[street]?.betSizePot;
    if (!hist) continue;
    n += hist.n ?? 0;
    for (const [key, count] of Object.entries(hist.buckets ?? {})) {
      buckets[key] = (buckets[key] ?? 0) + count;
    }
  }
  return { n, median: medianOf(buckets) };
}

function afComponent(tendency) {
  const af = tendency?.postflop?.af ?? { bets: 0, raises: 0, calls: 0 };
  const bets = af.bets ?? 0;
  const raises = af.raises ?? 0;
  const calls = af.calls ?? 0;
  const n = bets + raises + calls;
  if (n === 0) return { n: 0, value: null };
  const raw = calls === 0 ? (bets + raises > 0 ? Infinity : 0) : (bets + raises) / calls;
  return { n, value: Math.min(1, raw / 3) };
}

function unitInterval(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function tendencyComponents(tendency) {
  const facing = pooledFacing(tendency);
  const bet = pooledBetSize(tendency);
  const af = afComponent(tendency);
  const openHist = tendency?.preflop?.openSizeBb;
  const openMedian = medianOf(openHist?.buckets ?? {});
  const vs = tendency?.preflop?.vsRaise ?? { n: 0, raise: 0 };
  return [
    { id: 'vpip', n: tendency?.preflop?.vpip?.n ?? 0, value: rateOf(tendency?.preflop?.vpip) },
    { id: 'pfr', n: tendency?.preflop?.pfr?.n ?? 0, value: rateOf(tendency?.preflop?.pfr) },
    { id: 'limp', n: tendency?.preflop?.limp?.n ?? 0, value: rateOf(tendency?.preflop?.limp) },
    { id: 'threeBet', n: vs.n ?? 0, value: vs.n ? vs.raise / vs.n : null },
    { id: 'foldVsBet', n: facing.n, value: facing.n ? facing.fold / facing.n : null },
    { id: 'callVsBet', n: facing.n, value: facing.n ? facing.call / facing.n : null },
    { id: 'raiseVsBet', n: facing.n, value: facing.n ? facing.raise / facing.n : null },
    { id: 'cbet', n: tendency?.postflop?.cbet?.n ?? 0, value: rateOf(tendency?.postflop?.cbet) },
    { id: 'wtsd', n: tendency?.postflop?.wtsd?.n ?? 0, value: rateOf(tendency?.postflop?.wtsd) },
    { id: 'af', n: af.n, value: Number.isFinite(af.value) ? af.value : (af.n ? 1 : null) },
    { id: 'openSizeBb', n: openHist?.n ?? 0, value: openMedian == null ? null : unitInterval(openMedian / 5) },
    { id: 'betSizePot', n: bet.n, value: unitInterval(bet.median) },
  ];
}

export function eligibleComponentCount(tendency) {
  return tendencyComponents(tendency)
    .filter((row) => row.n >= TENDENCY_MIN_N && row.value != null)
    .length;
}

export function tendencySimilarity(left, right) {
  const a = tendencyComponents(left);
  const b = tendencyComponents(right);
  const used = [];
  let skipped = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (
      a[index].n >= TENDENCY_MIN_N
      && b[index].n >= TENDENCY_MIN_N
      && a[index].value != null
      && b[index].value != null
    ) {
      used.push([a[index].value, b[index].value]);
    } else {
      skipped += 1;
    }
  }
  if (used.length < SIMILARITY_MIN_COMPONENTS) {
    return { similarity: null, used: used.length, skipped };
  }
  const distance = used.reduce((sum, [x, y]) => sum + Math.abs(x - y), 0) / used.length;
  return { similarity: Math.round(100 * (1 - distance)), used: used.length, skipped };
}
