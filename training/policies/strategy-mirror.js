import { clampRaiseTo, fallbackLegal, legalizeEntries } from './contracts.js';
import { estimatePublicStrength } from './hand-strength.js';
import { raiseToFor, roundToUnit } from './sizing.js';
import {
  checkedToDistribution,
  facingDistribution,
  unopenedDistribution,
  unopenedPreflop,
} from './strategy-v2.js';
import {
  ENGINE_POSITION_LABELS,
  HAND_CLASSES,
  POSITIONAL_SEATS,
  TENDENCY_MIN_N,
  medianOf,
  normalizePosition,
  rateOf,
} from '../tendency/contracts.js';
import { CALIBRATION } from '../tendency/traits.js';

const WIDTH = 0.04;
const COMBO_TOTAL = 1326;

function comboWeight(handClass) {
  if (handClass.length === 2) return 6;
  if (handClass.endsWith('s')) return 4;
  return 12;
}

function holeCardsFromClass(handClass) {
  if (handClass.length === 2) return [`${handClass[0]}h`, `${handClass[1]}d`];
  if (handClass[2] === 's') return [`${handClass[0]}h`, `${handClass[1]}h`];
  return [`${handClass[0]}h`, `${handClass[1]}d`];
}

function buildQuantiles() {
  const tables = Object.create(null);
  for (const label of ENGINE_POSITION_LABELS) {
    const rows = HAND_CLASSES.map((handClass) => ({
      strength: estimatePublicStrength({
        street: 'preflop',
        holeCards: holeCardsFromClass(handClass),
        position: label,
      }),
      weight: comboWeight(handClass),
    }));
    rows.sort((a, b) => b.strength - a.strength);
    tables[label] = Object.freeze(rows.map((row) => Object.freeze(row)));
  }
  return Object.freeze(tables);
}

export const PREFLOP_STRENGTH_QUANTILES = buildQuantiles();

export function quantileStrength(engineLabel, p) {
  const rows = PREFLOP_STRENGTH_QUANTILES[engineLabel];
  if (!rows) return null;
  if (p == null || p === '') return null;
  const ratio = Number(p);
  if (!Number.isFinite(ratio)) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  const target = clamped * COMBO_TOTAL;
  if (target <= 0) return rows[0].strength;
  let acc = 0;
  for (const row of rows) {
    acc += row.weight;
    if (acc >= target) return row.strength;
  }
  return rows[rows.length - 1].strength;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function priorRaisesAndCalls(snapshot) {
  const prior = snapshot?.priorActions ?? [];
  const raises = [];
  let calls = 0;
  for (const action of prior) {
    if (action?.action === 'raise') raises.push(action);
    else if (action?.action === 'call') calls += 1;
  }
  return { raises, calls };
}

function singleOpenCallers0(snapshot) {
  if (snapshot?.street !== 'preflop') return false;
  const { raises, calls } = priorRaisesAndCalls(snapshot);
  return raises.length === 1 && calls === 0;
}

function vsThreeBet(snapshot) {
  if (snapshot?.street !== 'preflop') return false;
  const { raises } = priorRaisesAndCalls(snapshot);
  return raises.length === 2 && raises[0]?.playerId === snapshot.actorId;
}

function liveSeatCount(snapshot) {
  return (snapshot?.publicSeats ?? []).filter((seat) => !seat?.out).length;
}

function enough(counter) {
  return Boolean(counter && counter.n >= TENDENCY_MIN_N);
}

function openToOf(snapshot) {
  const raise = (snapshot?.priorActions ?? []).find((action) => action?.action === 'raise');
  return Number.isFinite(raise?.amount) ? raise.amount : null;
}

function traitsFor(config) {
  const traits = config?.traits;
  if (
    traits
    && ['tightness', 'aggression', 'calling', 'bluff'].every((key) => Number.isFinite(traits[key]))
  ) {
    return traits;
  }
  return CALIBRATION.baseline;
}

export function mirrorRaiseTo(snapshot, legal, tendency) {
  const fallback = raiseToFor(snapshot, legal);
  let target = fallback.target;
  let observed = false;
  if (unopenedPreflop(snapshot) && enough(tendency?.preflop?.openSizeBb)) {
    const median = medianOf(tendency.preflop.openSizeBb.buckets);
    const bb = snapshot?.blinds?.[1];
    if (median != null && Number.isFinite(bb)) {
      target = median * bb;
      observed = true;
    }
  } else if (singleOpenCallers0(snapshot) && enough(tendency?.preflop?.threeBetMultiple)) {
    const median = medianOf(tendency.preflop.threeBetMultiple.buckets);
    const openTo = openToOf(snapshot);
    if (median != null && openTo > 0) {
      target = median * openTo;
      observed = true;
    }
  } else if (
    snapshot?.street
    && snapshot.street !== 'preflop'
    && snapshot?.currentBet === 0
    && enough(tendency?.postflop?.byStreet?.[snapshot.street]?.betSizePot)
  ) {
    const median = medianOf(tendency.postflop.byStreet[snapshot.street].betSizePot.buckets);
    const pot = snapshot?.potBefore;
    if (median != null && Number.isFinite(pot)) {
      target = median * pot;
      observed = true;
    }
  }
  const rounded = roundToUnit(target, snapshot?.blinds?.[0]);
  if (!legal?.canRaise) return { rule: fallback.rule, target, raiseTo: null, observed };
  return { rule: fallback.rule, target, raiseTo: clampRaiseTo(rounded, legal), observed };
}

function withSizing(entries, sized, nameOf) {
  const suffix = sized.observed ? 'observed' : 'rule';
  return entries.map((entry) => {
    const name = nameOf(entry);
    if (entry.action === 'raise') {
      return { ...entry, raiseTo: sized.raiseTo, reasonCode: `${name}:${suffix}` };
    }
    return { ...entry, reasonCode: name };
  });
}

function finish(entries, legal, snapshot) {
  const items = legalizeEntries(entries, legal, { bb: snapshot?.blinds?.[1] });
  return items.length ? items : fallbackLegal(legal);
}

function observedUnopened(snapshot, legal, tendency, strength, sized) {
  const liveSeats = liveSeatCount(snapshot);
  if (!POSITIONAL_SEATS.includes(liveSeats)) return null;
  const pos = normalizePosition(snapshot?.position, liveSeats);
  const block = pos ? tendency?.preflop?.byPosition?.[pos] : null;
  if (!enough(block?.rfi) || !enough(block?.limp)) return null;
  const r = rateOf(block.rfi);
  const l = rateOf(block.limp);
  const qRaise = quantileStrength(snapshot?.position, r);
  const qLimp = quantileStrength(snapshot?.position, r + l);
  if (qRaise == null || qLimp == null) return null;
  const pRaise = sigmoid((strength - qRaise) / WIDTH);
  const pLimp = Math.max(0, sigmoid((strength - qLimp) / WIDTH) - pRaise);
  const pFold = Math.max(0, 1 - pRaise - pLimp);
  const limpAction = legal.canCheck ? 'check' : 'call';
  const limpEntry = { action: limpAction, frequency: pLimp };
  const foldEntry = { action: 'fold', frequency: pFold };
  const raiseEntry = { action: 'raise', frequency: pRaise, raiseTo: sized.raiseTo };
  // legalizeEntries maps fold→check when canCheck, then renormalize keeps the first
  // check's reasonCode. Emit limp-as-check before fold so the merge stays mirror-limp.
  const entries = legal.canCheck
    ? [limpEntry, foldEntry, raiseEntry]
    : [foldEntry, limpEntry, raiseEntry];
  return withSizing(entries, sized, (entry) => {
    if (entry.action === 'raise') return 'mirror-open';
    if (entry.action === 'fold') return 'mirror-fold';
    return 'mirror-limp';
  });
}

function observedVs(snapshot, tendency, strength, sized, counter) {
  if (!enough(counter) || !counter.n) return null;
  const rateRaise = counter.raise / counter.n;
  const rateCall = counter.call / counter.n;
  const qRaise = quantileStrength(snapshot?.position, rateRaise);
  const qCall = quantileStrength(snapshot?.position, rateRaise + rateCall);
  if (qRaise == null || qCall == null) return null;
  const pRaise = sigmoid((strength - qRaise) / WIDTH);
  const pCall = Math.max(0, sigmoid((strength - qCall) / WIDTH) - pRaise);
  const pFold = Math.max(0, 1 - pRaise - pCall);
  return withSizing([
    { action: 'fold', frequency: pFold },
    { action: 'call', frequency: pCall },
    { action: 'raise', frequency: pRaise, raiseTo: sized.raiseTo },
  ], sized, (entry) => {
    if (entry.action === 'raise') return 'mirror-3bet';
    if (entry.action === 'call') return 'mirror-call';
    return 'mirror-fold';
  });
}

export function distributionMirror(snapshot, legal, config) {
  const tendency = config?.params?.tendency;
  const traits = traitsFor(config);
  const strength = estimatePublicStrength(snapshot);
  const sized = mirrorRaiseTo(snapshot, legal, tendency);

  if (unopenedPreflop(snapshot)) {
    const observed = observedUnopened(snapshot, legal, tendency, strength, sized);
    if (observed) return finish(observed, legal, snapshot);
    return finish(withSizing(
      unopenedDistribution(traits, strength, sized),
      sized,
      () => 'mirror-v2-open',
    ), legal, snapshot);
  }

  if (singleOpenCallers0(snapshot)) {
    const liveSeats = liveSeatCount(snapshot);
    const pos = normalizePosition(snapshot?.position, liveSeats);
    const positional = pos ? tendency?.preflop?.byPosition?.[pos]?.vsRaise : null;
    const pooled = tendency?.preflop?.vsRaise;
    const observed = observedVs(snapshot, tendency, strength, sized, enough(positional) ? positional : pooled);
    if (observed) return finish(observed, legal, snapshot);
    return finish(withSizing(
      facingDistribution(snapshot, legal, traits, strength, sized),
      sized,
      () => 'mirror-v2-facing',
    ), legal, snapshot);
  }

  if (vsThreeBet(snapshot)) {
    const observed = observedVs(snapshot, tendency, strength, sized, tendency?.preflop?.vs3Bet);
    if (observed) return finish(observed, legal, snapshot);
    return finish(withSizing(
      facingDistribution(snapshot, legal, traits, strength, sized),
      sized,
      () => 'mirror-v2-facing',
    ), legal, snapshot);
  }

  if (!legal?.canCheck && legal?.callAmount > 0) {
    return finish(withSizing(
      facingDistribution(snapshot, legal, traits, strength, sized),
      sized,
      () => 'mirror-v2-facing',
    ), legal, snapshot);
  }

  return finish(withSizing(
    checkedToDistribution(traits, strength, sized),
    sized,
    (entry) => (entry.action === 'raise' ? 'mirror-v2-bet' : 'mirror-v2-check'),
  ), legal, snapshot);
}
