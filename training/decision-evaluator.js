import { evaluationIdOf } from './contracts.js';
import { handClassOf } from './cards.js';
import { normalizePreflopSpot } from './preflop-spot.js';

function gradeFrequency(chosenFreq, actions) {
  const f = chosenFreq ?? 0;
  if (f === 0) return 'off-policy';
  const max = Math.max(...actions.map((action) => action.frequency));
  if (f === max || f >= 0.50) return 'preferred';
  if (f >= 0.10) return 'mixed';
  return 'low-frequency';
}

function matchChosen(strategyActions, snapshot) {
  const chosen = snapshot.chosenAction?.action;
  if (!chosen) return { frequency: 0, action: null, sizeBb: null };
  const size = snapshot.chosenAction?.action === 'raise'
    ? (snapshot.blinds?.[1] ? snapshot.chosenAction.amount / snapshot.blinds[1] : null)
    : null;
  const hit = strategyActions.find((action) => {
    if (action.action !== chosen) return false;
    if (chosen === 'raise' && action.sizeBb != null && size != null) {
      return Math.abs(action.sizeBb - size) <= 0.05;
    }
    return true;
  });
  return {
    frequency: hit?.frequency ?? 0,
    action: chosen,
    sizeBb: size,
  };
}

export function evaluateDecision(snapshot, strategy, { gameEpoch } = {}) {
  const handClass = handClassOf(snapshot.holeCards);
  const source = strategy?.source ?? null;
  const providerId = source?.id ?? 'unknown';
  const providerVersion = source?.version ?? '0.0.0';
  const evaluationId = evaluationIdOf({
    gameEpoch: gameEpoch ?? 'unknown-epoch',
    decisionId: snapshot.decisionId,
    providerId,
    providerVersion,
  });

  const spot = normalizePreflopSpot(snapshot);
  if (!spot.ok) {
    return {
      schemaVersion: 1,
      evaluationId,
      decisionId: snapshot.decisionId,
      status: 'unsupported',
      street: snapshot.street,
      spotKey: null,
      handClass,
      recommended: [],
      chosen: { action: snapshot.chosenAction?.action ?? null, frequency: null, evBb: null },
      bestEvBb: null,
      evLossBb: null,
      grade: null,
      forced: Boolean(snapshot.forced),
      code: spot.code,
      reason: spot.reason,
      source,
    };
  }

  if (strategy?.status !== 'supported') {
    return {
      schemaVersion: 1,
      evaluationId,
      decisionId: snapshot.decisionId,
      status: 'unsupported',
      street: snapshot.street,
      spotKey: spot.spotKey,
      handClass,
      recommended: [],
      chosen: { action: snapshot.chosenAction?.action ?? null, frequency: null, evBb: null },
      bestEvBb: null,
      evLossBb: null,
      grade: null,
      forced: Boolean(snapshot.forced),
      reason: strategy?.reason ?? 'unsupported',
      source,
    };
  }

  const matched = matchChosen(strategy.actions, snapshot);
  const recommended = strategy.actions.map((action) => ({
    action: action.action,
    ...(action.sizeBb != null ? { sizeBb: action.sizeBb } : {}),
    frequency: action.frequency,
    evBb: null,
  }));
  recommended.sort((a, b) => b.frequency - a.frequency || a.action.localeCompare(b.action));

  return {
    schemaVersion: 1,
    evaluationId,
    decisionId: snapshot.decisionId,
    status: 'supported',
    street: snapshot.street,
    spotKey: spot.spotKey,
    handClass,
    recommended,
    chosen: {
      action: matched.action,
      ...(matched.sizeBb != null ? { sizeBb: matched.sizeBb } : {}),
      frequency: matched.frequency,
      evBb: null,
    },
    bestEvBb: null,
    evLossBb: null,
    grade: gradeFrequency(matched.frequency, strategy.actions),
    forced: Boolean(snapshot.forced),
    source,
  };
}
