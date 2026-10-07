// Reference v3 resolver: projects an engine decision snapshot onto the closed
// coverage-v2 input, derives the context and spot (shared/reference-coverage-v3),
// looks the hand up and grades the chosen action class. v1/v2 sources keep
// training/preflop-reference.js untouched.
import { projectAssistance } from '../shared/assistance.js';
import { dealSelectionFields } from '../shared/deal-selection.js';
import { PREFLOP_ORDERS_V3, trainingPositionV3 } from '../shared/preflop-key.js';
import { buildCoverageV3, gradeOfFrequencyV3, V3_BANDS } from '../shared/reference-coverage-v3.js';
import { referenceQuality } from '../shared/reference.js';
import { handClassOf } from './cards.js';
import { coded, evaluationIdOf } from './contracts.js';
import { lookup } from './providers/preflop-json.js';

export { gradeOfFrequencyV3 };

function priorAllIn(action) {
  if (action.action === 'raise') return Number.isInteger(action.maxRaiseTo) && action.amount === action.maxRaiseTo;
  if (action.action === 'call') return Number.isInteger(action.stacks?.[action.playerId]) && action.amount === action.stacks[action.playerId];
  return false;
}

// Snapshot → closed coverage input, or { code } when no v3 seat model applies.
export function coverageInputV3(snapshot) {
  const live = (snapshot.publicSeats ?? []).filter((seat) => !seat.out);
  const seated = live.length;
  const order = PREFLOP_ORDERS_V3[seated];
  if (!order) return { code: 'SEAT_COUNT_UNSUPPORTED' };
  const positionOf = new Map(live.map((seat) => [seat.playerId, trainingPositionV3(seat.position, seated)]));
  if ([...positionOf.values()].some((pos) => !pos) || new Set(positionOf.values()).size !== seated) return { code: 'POSITION_INVALID' };
  const heroPosition = positionOf.get(snapshot.actorId);
  if (!heroPosition) return { code: 'POSITION_INVALID' };
  const hero = live.find((seat) => seat.playerId === snapshot.actorId);
  const players = order.map((pos) => {
    const seat = live.find((row) => positionOf.get(row.playerId) === pos);
    return { position: pos, totalChips: seat.stack + seat.contribution, contributionChips: seat.contribution,
      folded: Boolean(seat.folded), allIn: Boolean(seat.allIn) };
  });
  const preflopActions = (snapshot.priorActions ?? []).filter((a) => (a.street ?? 'preflop') === 'preflop').map((a) => {
    const position = positionOf.get(a.playerId);
    if (!position) throw coded('SNAPSHOT_INVALID', 'prior action seat');
    return { position, action: a.action, toChips: a.amount, allIn: priorAllIn(a) };
  });
  const chosen = snapshot.chosenAction ? {
    action: snapshot.chosenAction.action,
    toChips: snapshot.chosenAction.amount ?? 0,
    allIn: (snapshot.chosenAction.action === 'raise' && snapshot.chosenAction.amount === snapshot.maxRaiseTo)
      || (snapshot.chosenAction.action === 'call' && snapshot.toCall > 0 && snapshot.toCall >= hero.stack),
  } : null;
  return { input: {
    mode: snapshot.gameMode === 'cash-training' ? 'cash-training' : 'tournament',
    street: snapshot.street,
    seated,
    bbChips: snapshot.blinds[1],
    heroPosition,
    players,
    preflopActions,
    legal: { canCheck: snapshot.legal.canCheck, canRaise: snapshot.legal.canRaise, actorBetChips: snapshot.actorBet,
      callAmountChips: snapshot.toCall, minRaiseToChips: snapshot.minRaiseTo, maxRaiseToChips: snapshot.maxRaiseTo },
    chosen,
    forced: Boolean(snapshot.forced),
  } };
}

// Reference rows with concrete raise-to chips; null when the tree's action is
// not legal here (then the spot is not compared).
function materialize(actions, context, snapshot) {
  const bb = snapshot.blinds[1];
  const legal = snapshot.legal;
  const rows = [];
  for (const row of actions) {
    if (row.action === 'raise') {
      const to = row.allIn ? snapshot.maxRaiseTo : Math.round(row.sizeBb * bb);
      const ok = legal.canRaise && to <= snapshot.maxRaiseTo && (to >= snapshot.minRaiseTo || to === snapshot.maxRaiseTo);
      if (!ok) return null;
      rows.push({ action: 'raise', sizeBb: to / bb, ...(row.allIn ? { allIn: true } : {}), frequency: row.frequency, evBb: null });
    } else if (row.action === 'call') {
      if (legal.canCheck || !(snapshot.toCall > 0)) return null;
      rows.push({ action: 'call', frequency: row.frequency, evBb: null });
    } else if (row.action === 'fold') {
      if (legal.canCheck) return null;
      rows.push({ action: 'fold', frequency: row.frequency, evBb: null });
    } else return null;
  }
  return rows;
}

export function evaluatePreflopReferenceV3(snapshot, dataset, { gameEpoch } = {}) {
  const probe = lookup(dataset, { spotKey: '', handClass: '' });
  const source = probe.source;
  if (dataset.data.schemaVersion !== 3 || referenceQuality(source).quality !== 'heuristic-reference') {
    throw coded('SOURCE_UNAVAILABLE', 'v3 evaluation requires the registered v3 dataset');
  }
  const handClass = handClassOf(snapshot.holeCards);
  const base = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({ gameEpoch: gameEpoch ?? 'unknown-epoch', decisionId: snapshot.decisionId,
      providerId: source.id, providerVersion: source.version }),
    decisionId: snapshot.decisionId,
    street: snapshot.street,
    handClass,
    bestEvBb: null,
    evLossBb: null,
    forced: Boolean(snapshot.forced),
    source,
    ...(snapshot.assistance !== undefined ? { assistance: projectAssistance(snapshot.assistance) } : {}),
    ...dealSelectionFields(snapshot),
  };
  const chosenAction = snapshot.chosenAction;
  const chosen = chosenAction ? {
    action: chosenAction.action,
    ...(chosenAction.action === 'raise' ? { sizeBb: chosenAction.amount / snapshot.blinds[1] } : {}),
    frequency: null,
    evBb: null,
  } : null;
  const unsupported = (code, coverage = null) => ({ ...base, status: 'unsupported', spotKey: coverage?.derived.spotKey ?? null,
    recommended: [], chosen, grade: null, code, reason: code, coverage });
  if (snapshot.street !== 'preflop') return unsupported('UNSUPPORTED_SPOT');
  const projected = coverageInputV3(snapshot);
  if (!projected.input) return unsupported(projected.code);
  const coverage = buildCoverageV3(projected.input);
  if (!coverage.derived.spotKey) return unsupported(coverage.reasonCodes[0] ?? 'UNSUPPORTED_SPOT', coverage);
  const found = lookup(dataset, { spotKey: coverage.derived.spotKey, handClass });
  // A lookup-level refusal (unreachable hand, illegal tree action) is carried by
  // the evaluation's status and code; the coverage stays exactly what its input
  // derives, so the public validator can recompute it.
  if (found.status !== 'supported') return unsupported(found.code ?? 'DATASET_SPOT_MISSING', coverage);
  const recommended = materialize(found.actions, coverage.derived.context, snapshot);
  if (!recommended) return unsupported('REFERENCE_ACTION_ILLEGAL', coverage);
  let grade = null;
  if (chosen && coverage.metricEligible) {
    const row = recommended.find((r) => r.action === chosen.action);
    chosen.frequency = row?.frequency ?? 0;
    if (chosen.action === 'raise' && row?.allIn) chosen.allIn = true;
    grade = gradeOfFrequencyV3(chosen.frequency, recommended);
  }
  return { ...base, status: 'supported', spotKey: coverage.derived.spotKey,
    recommended: [...recommended].sort((a, b) => b.frequency - a.frequency || a.action.localeCompare(b.action)),
    chosen, grade, coverage };
}

export { V3_BANDS };
