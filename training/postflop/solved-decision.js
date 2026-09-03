import { evaluationIdOf, coded } from '../contracts.js';
import { handClassOf } from '../cards.js';
import { assertSolverResult } from './contracts.js';

const STREETS = new Set(['flop', 'turn', 'river']);
const SIZED = new Set(['bet', 'raise']);
const PROVIDER_ID = /^[a-z0-9-]{1,64}$/;
const PROVIDER_VERSION = /^\d+\.\d+\.\d+$/;

function gradeFrequency(chosenFreq, actions) {
  const frequency = chosenFreq ?? 0;
  if (frequency === 0) return 'off-policy';
  const max = Math.max(...actions.map((action) => action.frequency ?? 0));
  if (frequency === max || frequency >= 0.50) return 'preferred';
  if (frequency >= 0.10) return 'mixed';
  return 'low-frequency';
}

function chosenSizeBb(snapshot) {
  const chosen = snapshot?.chosenAction;
  if (!chosen || !SIZED.has(chosen.action)) return null;
  const bb = snapshot?.blinds?.[1];
  if (!bb) return null;
  return chosen.amount / bb;
}

function matchChosen(actions, snapshot) {
  const chosen = snapshot?.chosenAction?.action ?? null;
  if (!chosen) return { action: null, frequency: 0, sizeBb: null };
  const sizeBb = chosenSizeBb(snapshot);
  const hit = actions.find((action) => {
    if (action.action !== chosen) return false;
    if (SIZED.has(chosen) && action.sizeBb != null && sizeBb != null) {
      return Math.abs(action.sizeBb - sizeBb) <= 0.05;
    }
    return true;
  });
  return { action: chosen, frequency: hit?.frequency ?? 0, sizeBb };
}

/**
 * Projects a solver result onto the same evaluation shape the preflop baseline
 * produces, so a solved postflop decision becomes an ordinary authority item
 * (`pending` map → `evaluated` → `published`) with no "solved" state of its own.
 * Heuristic solvers never carry EV, so every EV field stays null.
 */
export function evaluateSolvedDecision(snapshot, solverResult, { gameEpoch } = {}) {
  if (!snapshot || typeof snapshot.decisionId !== 'string') {
    throw coded('SNAPSHOT_INVALID', 'decision snapshot이 올바르지 않습니다.');
  }
  if (!STREETS.has(snapshot.street)) {
    throw coded('SOLVE_STREET_INVALID', 'solver는 postflop 결정만 다룹니다.');
  }
  const result = assertSolverResult(solverResult);
  const providerId = result.providerId;
  const providerVersion = result.providerVersion;
  if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) {
    throw coded('SOLVER_INVALID', 'solver providerId가 계약 문법을 벗어났습니다.');
  }
  if (typeof providerVersion !== 'string' || !PROVIDER_VERSION.test(providerVersion)) {
    throw coded('SOLVER_INVALID', 'solver providerVersion이 계약 문법을 벗어났습니다.');
  }
  const actions = Array.isArray(result.actions) ? result.actions : [];
  if (actions.length === 0) {
    throw coded('SOLVER_INVALID', 'solver 결과에 action이 없습니다.');
  }
  for (const action of actions) {
    if (typeof action?.action !== 'string' || !Number.isFinite(action.frequency)) {
      throw coded('SOLVER_INVALID', 'solver action에 action·frequency가 필요합니다.');
    }
  }

  const evaluationId = evaluationIdOf({
    gameEpoch: gameEpoch ?? 'unknown-epoch',
    decisionId: snapshot.decisionId,
    providerId,
    providerVersion,
  });
  const matched = matchChosen(actions, snapshot);
  const recommended = actions
    .map((action) => ({
      action: action.action,
      ...(action.sizeBb != null ? { sizeBb: action.sizeBb } : {}),
      frequency: action.frequency,
      evBb: null,
    }))
    .sort((left, right) => right.frequency - left.frequency
      || left.action.localeCompare(right.action));

  return {
    schemaVersion: 1,
    evaluationId,
    decisionId: snapshot.decisionId,
    status: 'supported',
    street: snapshot.street,
    spotKey: `postflop-${snapshot.street}`,
    handClass: handClassOf(snapshot.holeCards),
    recommended,
    chosen: {
      action: matched.action,
      ...(matched.sizeBb != null ? { sizeBb: matched.sizeBb } : {}),
      frequency: matched.frequency,
      evBb: null,
    },
    bestEvBb: null,
    evLossBb: null,
    grade: gradeFrequency(matched.frequency, actions),
    forced: Boolean(snapshot.forced),
    source: { id: providerId, version: providerVersion },
  };
}
