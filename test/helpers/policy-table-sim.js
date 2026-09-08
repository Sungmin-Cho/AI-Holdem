import { snapshotDecision } from '../../engine/decision.js';
import { applyAction, createGame, legalFor, startHand } from '../../engine/hand.js';
import { decide } from '../../tools/policy-player.js';
import { mulberry32 } from './fixtures.js';

const GAME_EPOCH = 'ab'.repeat(32);

function asPolicy(spec) {
  if (spec == null) return { policy: 'baseline-v2', extraDerived: {} };
  if (typeof spec === 'string') return { policy: spec, extraDerived: {} };
  if (spec.base && spec.params && spec.configDigest) {
    return {
      policy: {
        policyId: spec.policyId,
        policyVersion: spec.policyVersion,
        configDigest: spec.configDigest,
      },
      extraDerived: { [spec.configDigest]: spec },
    };
  }
  return { policy: spec, extraDerived: {} };
}

export function simulateTable({
  seats = {},
  hands = 20,
  seed = 1,
  derived = {},
  aiCount = 5,
  blinds0 = [50, 100],
  startStack = 10_000,
} = {}) {
  const rng = mulberry32(seed >>> 0);
  let state = createGame({
    aiCount,
    startStack,
    blinds0,
    mode: 'cash-training',
    levelEvery: null,
    startStackBb: startStack / blinds0[1],
    handLimit: hands,
  });
  state.button = 0;

  const records = [];
  while (!state.gameOver && records.length < hands) {
    state = startHand(state, { rng }).state;
    if (state.gameOver || !state.hand) break;
    let acts = 0;
    while (!legalFor(state).handOver) {
      acts += 1;
      if (acts > 10_000) throw new Error(`sim hand ${state.handNo} did not close`);
      const legal = legalFor(state);
      const toAct = legal.toAct;
      const snapshot = snapshotDecision(state, toAct, null, {
        blinds: state.config.blinds0,
        legal,
      });
      const { policy, extraDerived } = asPolicy(seats[toAct]);
      const decided = decide({
        snapshot,
        legal,
        policy,
        policySeed: `sim-${seed}-${toAct}`,
        gameEpoch: GAME_EPOCH,
        derived: { ...derived, ...extraDerived },
      });
      state = applyAction(state, toAct, decided.action, decided.amount, {
        policyMeta: {
          policyId: decided.policyId,
          policyVersion: decided.policyVersion,
          sampledProbability: decided.sampledProbability,
          reasonCode: decided.reasonCode,
        },
      }).state;
    }
    if (state.lastHand) records.push(structuredClone(state.lastHand));
  }
  return records;
}
