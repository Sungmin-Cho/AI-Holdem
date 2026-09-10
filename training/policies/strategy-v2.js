import { fallbackLegal, isStrategyV2, legalizeEntries } from './contracts.js';
import { estimatePublicStrength } from './hand-strength.js';
import { raiseToFor } from './sizing.js';
import { hasPublicDraw, positionSizeMix, publicLine } from './public-line.js';

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function traitsOf(config) {
  const traits = config?.traits;
  if (
    !isStrategyV2(config)
    || !traits
    || ['tightness', 'aggression', 'calling', 'bluff'].some(
      (key) => !Number.isFinite(traits[key]) || traits[key] < 0 || traits[key] > 1,
    )
  ) {
    const error = new Error('v2 policy config is invalid');
    error.code = 'POLICY_CONFIG_MISMATCH';
    throw error;
  }
  return traits;
}

function priorRaises(snapshot) {
  return (snapshot?.priorActions ?? []).filter((action) => action?.action === 'raise');
}

export function unopenedPreflop(snapshot) {
  return snapshot?.street === 'preflop'
    && priorRaises(snapshot).length === 0
    && !(snapshot?.priorActions ?? []).some((action) => action?.action === 'call');
}

export function facingDistribution(snapshot, legal, traits, strength, { raiseTo, rule } = {}) {
  const pot = Math.max(0, Number(snapshot?.potBefore) || 0);
  const callAmount = Math.max(0, Number(legal?.callAmount) || 0);
  const price = callAmount / Math.max(1, pot + callAmount);
  const looseness = 1 - traits.tightness;
  const nonFold = clamp(
    0.03
      + 0.92 * strength
      + 0.18 * looseness
      + 0.10 * traits.bluff * (1 - strength)
      - 0.90 * price * (1 - strength),
    0.02,
    0.98,
  );
  const raiseShare = clamp(
    0.04
      + traits.aggression * (0.18 + 0.48 * strength)
      + traits.bluff * 0.18 * (1 - strength)
      - traits.calling * 0.12,
    0.02,
    0.88,
  );
  return [
    { action: 'fold', frequency: 1 - nonFold, reasonCode: 'v2-fold' },
    { action: 'call', frequency: nonFold * (1 - raiseShare), reasonCode: 'v2-call' },
    { action: 'raise', raiseTo, frequency: nonFold * raiseShare, reasonCode: `v2-raise:${rule}` },
  ];
}

export function unopenedDistribution(traits, strength, { raiseTo } = {}) {
  const threshold = 0.20 + 0.52 * traits.tightness;
  const participation = clamp(
    0.50 + 1.60 * (strength - threshold) + 0.25 * (0.50 - traits.tightness),
    0.02,
    0.98,
  );
  return [
    { action: 'fold', frequency: 1 - participation, reasonCode: 'v2-open-fold' },
    { action: 'raise', raiseTo, frequency: participation, reasonCode: 'v2-open-2.5bb' },
  ];
}

export function checkedToDistribution(traits, strength, { raiseTo, rule } = {}) {
  const bet = clamp(
    0.03
      + traits.aggression * (0.12 + 0.58 * strength)
      + traits.bluff * 0.22 * (1 - strength),
    0.02,
    0.88,
  );
  return [
    { action: 'check', frequency: 1 - bet, reasonCode: 'v2-check' },
    { action: 'raise', raiseTo, frequency: bet, reasonCode: `v2-bet:${rule}` },
  ];
}

export function distributionV2(snapshot, legal, config) {
  const traits = traitsOf(config);
  const strength = estimatePublicStrength(
    snapshot,
    snapshot.strengthSamples != null ? { samples: snapshot.strengthSamples } : undefined,
  );
  const sized = raiseToFor(snapshot, legal);
  let proposed;
  if (unopenedPreflop(snapshot)) {
    proposed = unopenedDistribution(traits, strength, sized);
  } else if (!legal?.canCheck && legal?.callAmount > 0) {
    proposed = facingDistribution(snapshot, legal, traits, strength, sized);
  } else {
    proposed = checkedToDistribution(traits, strength, sized);
  }
  if (snapshot.street !== 'preflop') {
    const line = publicLine(snapshot);
    const role = strength >= 0.67 ? 'value' : hasPublicDraw(snapshot) ? 'draw' : 'showdown';
    for (const entry of proposed) {
      if (entry.action !== 'raise') continue;
      if (role !== 'value') {
        // A conservative heuristic cap, not a solved bluff/value ratio.
        const mass = line.eligible ? Math.min(entry.frequency, traits.bluff * (role === 'draw' ? 0.35 : 0.15)) : 0;
        const removed = entry.frequency - mass;
        entry.frequency = mass;
        const passive = proposed.find(row => row.action === (legal.canCheck ? 'check' : 'call'));
        if (passive) passive.frequency += removed;
      }
      entry.reasonCode = `v2-${role === 'value' ? 'value' : 'bluff'}:${line.reason}:${sized.rule}`;
    }
  }
  // The same size support is used for value and every eligible bluff. Keep
  // the canonical size first for existing diagnostics; legalize merges clamps.
  const sizeMix = positionSizeMix(snapshot.position);
  proposed = proposed.flatMap(entry => entry.action !== 'raise' ? [entry] : [
    {...entry, frequency:entry.frequency * sizeMix},
    {...entry, raiseTo: Math.round(sized.target * 1.2 / (snapshot.blinds?.[0] || 1)) * (snapshot.blinds?.[0] || 1), frequency:entry.frequency * (1-sizeMix)},
  ]);
  const legalItems = legalizeEntries(proposed, legal, { bb: snapshot?.blinds?.[1] });
  return legalItems.length ? legalItems : fallbackLegal(legal);
}
