// Coverage for reference v3 (local-preflop-baseline@3.0.0): the closed public
// input projected from an engine decision, and the one derivation both the
// resolver (to produce) and the validator (to check) use. Pure and browser-safe.
import { PREFLOP_ORDERS_V3, PUSHFOLD_STACKS_BB, parsePreflopKeyV3, preflopKeysV3 } from './preflop-key.js';
import { matchReferenceActionV3, sameReferenceSource } from './reference.js';

export { matchReferenceActionV3 };

export const COVERAGE_V3_SCHEMA = 2;
export const COVERAGE_V3_POLICY = 'preflop-projection-v2';
export const COVERAGE_V3_REASONS = Object.freeze([
  'NO_DECISION', 'UNSUPPORTED_SPOT', 'SEAT_COUNT_UNSUPPORTED', 'POSITION_INVALID', 'LIMP_OR_CALLER',
  'FOUR_BET_PLUS', 'FACING_ALLIN_UNMODELED', 'DATASET_SPOT_MISSING', 'FORCED_STACK', 'MID_STACK_UNSUPPORTED',
  'STACK_OUT_OF_RANGE', 'FACING_SIZE_OUT_OF_RANGE', 'OPENER_RANGE_UNREACHABLE', 'REFERENCE_ACTION_ILLEGAL',
  'STACK_PROJECTED', 'FACING_SIZE_PROJECTED', 'PUSHFOLD_PROJECTED',
  'CHOICE_SIZE_OUT_OF_RANGE', 'CHOICE_OUT_OF_TREE', 'DEEP_ALLIN_UNMODELED',
]);
const V3_KEYS = new Set(preflopKeysV3());
const ACTIONS = new Set(['fold', 'check', 'call', 'raise']);
// Exact and projected bands (big blinds), design D6.3/D6.4.
export const V3_BANDS = Object.freeze({
  deepExact: [80, 150], deepProjected: [25, 250], midStack: [15.5, 25], pushMax: 15.5, pushMin: 2.6,
  bucketTolerance: 0.15, behindRatio: 0.75, pushBehindMax: 4, shoveBehindMax: 2,
  facingOpenExact: [2.0, 3.0], facingOpenProjected: [3.0, 4.0], threeBetExact: [6, 12], threeBetProjected: [12, 16],
  openChoice: [2.0, 3.2], threeBetChoice: [6, 12], fourBetChoice: [16, 30], deepAllIn: 40,
});

/** Whether a key's synthetic table is an exact (gradeable) context: push and
 * shove models only cover a few players behind the hero (design D6.3). */
export function practiceKeyExactV3(spotKey) {
  const spot = parsePreflopKeyV3(spotKey);
  if (!spot) return false;
  const order = PREFLOP_ORDERS_V3[spot.seated];
  const behind = order.length - order.indexOf(spot.position) - 1;
  if (spot.context === 'push') return behind <= V3_BANDS.pushBehindMax;
  if (spot.context === 'vs-shove') return behind <= V3_BANDS.shoveBehindMax;
  return true;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (field) => { throw coded('REFERENCE_COVERAGE_INVALID', `Invalid reference coverage v3: ${field}`); };
const chips = (n) => Number.isSafeInteger(n) && n >= 0;
const exactKeys = (o, list) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).length === list.length && list.every((k, i) => Object.keys(o)[i] === k);
const within = (x, [lo, hi]) => x >= lo - 1e-9 && x <= hi + 1e-9;
const lower = (p) => p.toLowerCase();

export function nearestBucket(stackBb) {
  return PUSHFOLD_STACKS_BB.reduce((best, s) => (Math.abs(Math.log(s / stackBb)) < Math.abs(Math.log(best / stackBb)) ? s : best),
    PUSHFOLD_STACKS_BB[0]);
}

function sortedReasons(list) {
  return COVERAGE_V3_REASONS.filter((r) => list.includes(r));
}

// input → { context, spotKey, villainPosition, effectiveChips, bucketBb, facingToBb,
//           referenceMatch, reasonCodes, choiceMatch, raiseTo }
export function deriveCoverageV3(input) {
  const { mode, seated, bbChips, heroPosition, players, preflopActions, chosen, street } = input;
  const out = { context: null, spotKey: null, villainPosition: null, effectiveChips: null, bucketBb: null,
    facingToBb: null, referenceMatch: 'unsupported', reasons: [], choiceMatch: chosen ? 'unavailable' : 'not-observed', choiceReasons: [] };
  const fail = (code) => { out.reasons.push(code); return out; };
  if (street !== 'preflop') return fail('UNSUPPORTED_SPOT');
  const order = PREFLOP_ORDERS_V3[seated];
  if (!order || !['cash-training', 'tournament'].includes(mode)) return fail('SEAT_COUNT_UNSUPPORTED');
  if (!order.includes(heroPosition)) return fail('POSITION_INVALID');
  const total = (pos) => players.find((p) => p.position === pos)?.totalChips ?? 0;
  const heroTotal = total(heroPosition);
  const bb = (n) => n / bbChips;
  const heroIndex = order.indexOf(heroPosition);
  const raises = preflopActions.filter((a) => a.action === 'raise');
  if (preflopActions.some((a) => a.action === 'call' || a.action === 'check')) return fail('LIMP_OR_CALLER');
  let context;
  let villain = null;
  if (raises.length === 0) {
    if (heroPosition === 'BB') return fail('DATASET_SPOT_MISSING');
    context = 'unopened';
  } else if (raises.length === 1 && raises[0].position !== heroPosition) {
    villain = raises[0].position;
    if (order.indexOf(villain) >= heroIndex) return fail('POSITION_INVALID');
    context = raises[0].allIn ? 'vs-shove' : 'vs-single-raise';
  } else if (raises.length === 2 && raises[0].position === heroPosition) {
    villain = raises[1].position;
    if (raises[1].allIn) return fail('FACING_ALLIN_UNMODELED');
    context = 'vs-3bet';
  } else {
    return fail('FOUR_BET_PLUS');
  }
  out.villainPosition = villain;
  // Players still to act behind hero (preflop order), for push/fold models.
  const behind = order.slice(heroIndex + 1).filter((pos) => !players.find((p) => p.position === pos)?.folded);
  const reasons = [];
  let referenceMatch = 'exact';
  let key;
  if (context === 'unopened') {
    const behindMax = Math.max(0, ...behind.map(total));
    const eff = Math.min(heroTotal, behindMax);
    out.effectiveChips = eff;
    const s = bb(eff);
    if (s <= 1) return fail('FORCED_STACK');
    if (s <= V3_BANDS.pushMax) {
      context = 'push';
      const bucket = nearestBucket(s);
      out.bucketBb = bucket;
      const modelled = s >= V3_BANDS.pushMin && Math.abs(s - bucket) / bucket <= V3_BANDS.bucketTolerance
        && behind.length <= V3_BANDS.pushBehindMax
        && behind.every((pos) => Math.min(total(pos), heroTotal) >= V3_BANDS.behindRatio * eff);
      if (!modelled) { referenceMatch = 'projected'; reasons.push('PUSHFOLD_PROJECTED'); }
      key = `${seated}max-${bucket}bb-${lower(heroPosition)}-push-v3`;
    } else {
      context = 'rfi-unopened';
      if (within(s, V3_BANDS.midStack) && s < V3_BANDS.midStack[1]) return fail('MID_STACK_UNSUPPORTED');
      if (!within(s, V3_BANDS.deepProjected)) return fail('STACK_OUT_OF_RANGE');
      if (!within(s, V3_BANDS.deepExact)) { referenceMatch = 'projected'; reasons.push('STACK_PROJECTED'); }
      key = `${seated}max-100bb-${lower(heroPosition)}-rfi-v3`;
    }
  } else if (context === 'vs-shove') {
    const shover = total(villain);
    const eff = Math.min(heroTotal, shover);
    out.effectiveChips = eff;
    const s = bb(eff);
    out.facingToBb = bb(raises[0].toChips);
    if (bb(shover) > V3_BANDS.pushMax) return fail('FACING_ALLIN_UNMODELED');
    if (s <= 1) return fail('FORCED_STACK');
    const bucket = nearestBucket(s);
    out.bucketBb = bucket;
    const modelled = s >= V3_BANDS.pushMin && Math.abs(s - bucket) / bucket <= V3_BANDS.bucketTolerance
      && behind.length <= V3_BANDS.shoveBehindMax
      && behind.every((pos) => {
        const capped = Math.min(total(pos), heroTotal);
        return bb(capped) <= V3_BANDS.pushMax && capped >= V3_BANDS.behindRatio * eff;
      });
    if (!modelled) { referenceMatch = 'projected'; reasons.push('PUSHFOLD_PROJECTED'); }
    key = `${seated}max-${bucket}bb-${lower(heroPosition)}-vs-${lower(villain)}-shove-v3`;
  } else {
    const eff = Math.min(heroTotal, total(villain));
    out.effectiveChips = eff;
    const s = bb(eff);
    if (s <= V3_BANDS.pushMax) return fail('STACK_OUT_OF_RANGE');
    if (within(s, V3_BANDS.midStack) && s < V3_BANDS.midStack[1]) return fail('MID_STACK_UNSUPPORTED');
    if (!within(s, V3_BANDS.deepProjected)) return fail('STACK_OUT_OF_RANGE');
    if (!within(s, V3_BANDS.deepExact)) { referenceMatch = 'projected'; reasons.push('STACK_PROJECTED'); }
    const facing = bb(raises.at(-1).toChips);
    out.facingToBb = facing;
    const [exactBand, projectedBand] = context === 'vs-single-raise'
      ? [V3_BANDS.facingOpenExact, V3_BANDS.facingOpenProjected] : [V3_BANDS.threeBetExact, V3_BANDS.threeBetProjected];
    if (!within(facing, exactBand)) {
      if (!within(facing, projectedBand)) return fail('FACING_SIZE_OUT_OF_RANGE');
      referenceMatch = 'projected';
      reasons.push('FACING_SIZE_PROJECTED');
    }
    key = context === 'vs-single-raise'
      ? `${seated}max-100bb-${lower(heroPosition)}-vs-${lower(villain)}-open-v3`
      : `${seated}max-100bb-${lower(heroPosition)}-vs-${lower(villain)}-3bet-v3`;
  }
  if (!V3_KEYS.has(key)) return fail('DATASET_SPOT_MISSING');
  out.context = context;
  out.spotKey = key;
  out.referenceMatch = referenceMatch;
  out.reasons = reasons;
  if (!chosen) return out;
  // Choice: action class inside the modelled tree and size band.
  const toBb = chosen.action === 'raise' ? bb(chosen.toChips) : null;
  const choice = (() => {
    if (chosen.action === 'fold') return 'exact';
    if (chosen.action === 'check') return 'CHOICE_OUT_OF_TREE';
    if (chosen.action === 'call') return ['rfi-unopened', 'push'].includes(context) ? 'CHOICE_OUT_OF_TREE' : 'exact';
    if (context === 'push') return chosen.allIn ? 'exact' : 'CHOICE_OUT_OF_TREE';
    if (context === 'vs-shove') return 'CHOICE_OUT_OF_TREE';
    if (chosen.allIn && bb(out.effectiveChips) > V3_BANDS.deepAllIn) return 'DEEP_ALLIN_UNMODELED';
    const band = context === 'rfi-unopened' ? V3_BANDS.openChoice : context === 'vs-single-raise' ? V3_BANDS.threeBetChoice : V3_BANDS.fourBetChoice;
    return within(toBb, band) ? 'exact' : 'CHOICE_SIZE_OUT_OF_RANGE';
  })();
  if (choice === 'exact') out.choiceMatch = 'exact';
  else { out.choiceMatch = 'unavailable'; out.choiceReasons.push(choice); }
  return out;
}

const INPUT_KEYS = ['mode', 'street', 'seated', 'bbChips', 'heroPosition', 'players', 'preflopActions', 'legal', 'chosen', 'forced'];
const PLAYER_KEYS = ['position', 'totalChips', 'contributionChips', 'folded', 'allIn'];
const ACTION_KEYS = ['position', 'action', 'toChips', 'allIn'];
const LEGAL_KEYS = ['canCheck', 'canRaise', 'actorBetChips', 'callAmountChips', 'minRaiseToChips', 'maxRaiseToChips'];
const CHOSEN_KEYS = ['action', 'toChips', 'allIn'];
const DERIVED_KEYS = ['context', 'spotKey', 'villainPosition', 'effectiveChips', 'bucketBb', 'facingToBb'];
export const COVERAGE_V3_KEYS = Object.freeze(['schemaVersion', 'policyVersion', 'referenceMatch', 'choiceMatch',
  'metricEligible', 'reasonCodes', 'input', 'derived']);

// Closed structural check of the public input, independent of the derivation.
export function assertCoverageInputV3(i) {
  if (!exactKeys(i, INPUT_KEYS)) invalid('input keys');
  if (!['cash-training', 'tournament'].includes(i.mode) || typeof i.street !== 'string' || i.street.length > 10) invalid('mode/street');
  if (!Number.isSafeInteger(i.seated) || i.seated < 2 || i.seated > 9 || !chips(i.bbChips) || !i.bbChips) invalid('seated/bb');
  const order = PREFLOP_ORDERS_V3[i.seated];
  if (typeof i.heroPosition !== 'string' || !order.includes(i.heroPosition)) invalid('hero');
  if (!Array.isArray(i.players) || i.players.length !== i.seated) invalid('players');
  i.players.forEach((p, k) => {
    if (!exactKeys(p, PLAYER_KEYS) || p.position !== order[k] || !chips(p.totalChips) || !chips(p.contributionChips)
      || p.contributionChips > p.totalChips || typeof p.folded !== 'boolean' || typeof p.allIn !== 'boolean') invalid('player');
  });
  if (!Array.isArray(i.preflopActions) || i.preflopActions.length > 64) invalid('actions');
  for (const a of i.preflopActions) {
    if (!exactKeys(a, ACTION_KEYS) || !order.includes(a.position) || !ACTIONS.has(a.action) || !chips(a.toChips)
      || typeof a.allIn !== 'boolean') invalid('action');
  }
  const l = i.legal;
  if (!exactKeys(l, LEGAL_KEYS) || typeof l.canCheck !== 'boolean' || typeof l.canRaise !== 'boolean'
    || !LEGAL_KEYS.slice(2).every((k) => chips(l[k])) || l.canCheck !== (l.callAmountChips === 0)) invalid('legal');
  if (i.chosen !== null && (!exactKeys(i.chosen, CHOSEN_KEYS) || !ACTIONS.has(i.chosen.action) || !chips(i.chosen.toChips)
    || typeof i.chosen.allIn !== 'boolean')) invalid('chosen');
  if (typeof i.forced !== 'boolean') invalid('forced');
}

// Builds the coverage object from an input (used by the resolver).
export function buildCoverageV3(input) {
  assertCoverageInputV3(input);
  const d = deriveCoverageV3(input);
  const reasonCodes = sortedReasons([...d.reasons, ...d.choiceReasons]);
  return {
    schemaVersion: COVERAGE_V3_SCHEMA,
    policyVersion: COVERAGE_V3_POLICY,
    referenceMatch: d.referenceMatch,
    choiceMatch: d.choiceMatch,
    metricEligible: d.referenceMatch === 'exact' && d.choiceMatch === 'exact' && !input.forced,
    reasonCodes,
    input: structuredClone(input),
    derived: { context: d.context, spotKey: d.spotKey, villainPosition: d.villainPosition,
      effectiveChips: d.effectiveChips, bucketBb: d.bucketBb, facingToBb: d.facingToBb },
  };
}

// Validator: rejects anything that is not exactly what the derivation produces
// from its own input (a publisher cannot claim a context, key or eligibility).
// Callers that bind a coverage to a completed engine decision do so separately.
export function projectReferenceCoverageV3(c) {
  // An unsupported result with no coverage input (postflop, no preflop context)
  // carries null, as in v2.
  if (c === null) return null;
  if (!exactKeys(c, COVERAGE_V3_KEYS) || c.schemaVersion !== COVERAGE_V3_SCHEMA || c.policyVersion !== COVERAGE_V3_POLICY) invalid('envelope');
  if (!exactKeys(c.derived, DERIVED_KEYS)) invalid('derived keys');
  const expected = buildCoverageV3(c.input);
  if (JSON.stringify(expected) !== JSON.stringify(c)) invalid('derivation mismatch');
  return expected;
}

// The v3 tree's raise sizes (big blinds); push rows are all-in. The dataset
// records the same values in data.tree (test-pinned).
export const V3_TREE = Object.freeze({ openBb: 2.5, threeBetBb: 8.5, fourBetBb: 20 });
const TREE_RAISE_BB = Object.freeze({ 'rfi-unopened': V3_TREE.openBb, 'vs-single-raise': V3_TREE.threeBetBb, 'vs-3bet': V3_TREE.fourBetBb });

/** Grade by the reference frequency of the chosen action class (v2 thresholds). */
export function gradeOfFrequencyV3(frequency, actions) {
  if (!(frequency > 0)) return 'off-policy';
  const max = Math.max(...actions.map((row) => row.frequency));
  return frequency === max || frequency >= 0.5 ? 'preferred' : frequency >= 0.1 ? 'mixed' : 'low-frequency';
}

/** Eligibility of a v3 evaluation, profile event or mix observation: the
 * coverage must re-derive exactly, the chosen action must be the coverage's,
 * and an eligible row set must be the tree's legal rows with the stated grade. */
export function referenceAssessmentEligibilityV3(e, source) {
  const fail = () => ({ verified: false, referenceAvailable: false, metricEligible: false, reason: 'REFERENCE_COVERAGE_INVALID' });
  try {
    if (!e || !Object.hasOwn(e, 'coverage')) return fail();
    const c = projectReferenceCoverageV3(e.coverage);
    if (e.mixObservation && !sameReferenceSource(e.mixObservation.sourceIdentity, source)) return fail();
    if (c === null) {
      // Verified as unsupported only: no grade, no frequency, no observation.
      if (e.status === 'supported' || e.grade != null || e.chosen?.frequency != null || e.mixObservation) return fail();
      return { verified: true, referenceAvailable: false, metricEligible: false, reason: null };
    }
    const available = e.status === 'supported' && !e.forced;
    if (e.status === 'supported' && !c.derived.spotKey) return fail();
    const spotKey = e.spotKey ?? e.mixObservation?.spotKey;
    if (e.status === 'supported' && spotKey !== undefined && spotKey !== c.derived.spotKey) return fail();
    const eligible = available && c.metricEligible;
    const actions = e.recommended ?? e.mixObservation?.referenceActions;
    const choice = e.chosen ?? e.mixObservation?.chosenAction;
    const bb = c.input.bbChips;
    if (choice && c.input.chosen) {
      if (choice.action !== c.input.chosen.action) return fail();
      if (choice.action === 'raise' ? !(Math.abs(choice.sizeBb * bb - c.input.chosen.toChips) < 1e-6) : choice.sizeBb !== undefined) return fail();
      if (choice.allIn !== undefined && (choice.allIn !== true || choice.action !== 'raise')) return fail();
    } else if (choice) return fail();
    // A profile event keeps the choice only for scored results; without it the
    // coverage's own chosen action stands (an eligible result needs it below).
    if (!eligible && (e.grade != null || (e.chosen && e.chosen.frequency != null))) return fail();
    if (eligible) {
      if (!Array.isArray(actions) || !actions.length || actions.length > 3 || !choice) return fail();
      const legal = c.input.legal;
      const context = c.derived.context;
      const seen = new Set();
      let sum = 0;
      for (const row of actions) {
        if (!['fold', 'call', 'raise'].includes(row?.action) || seen.has(row.action) || !Number.isFinite(row.frequency)
          || row.frequency <= 0 || row.frequency > 1 || row.evBb != null) return fail();
        seen.add(row.action);
        sum += row.frequency;
        if (row.action === 'raise') {
          const to = context === 'push' ? legal.maxRaiseToChips : Math.round((TREE_RAISE_BB[context] ?? NaN) * bb);
          if (!legal.canRaise || !(Math.abs(row.sizeBb * bb - to) < 1e-6) || (row.allIn !== undefined && (row.allIn !== true || context !== 'push'))) return fail();
        } else if (row.sizeBb !== undefined || row.allIn !== undefined) return fail();
        if (row.action === 'call' && (legal.canCheck || ['rfi-unopened', 'push'].includes(context))) return fail();
        if (row.action === 'fold' && legal.canCheck) return fail();
      }
      if (Math.abs(sum - 1) > 1e-9) return fail();
      const f = matchReferenceActionV3(actions, choice)?.frequency ?? 0;
      if (e.grade !== gradeOfFrequencyV3(f, actions) || (choice.frequency !== undefined && choice.frequency !== f)) return fail();
    }
    return { verified: true, referenceAvailable: available, metricEligible: eligible, reason: null };
  } catch {
    return fail();
  }
}
