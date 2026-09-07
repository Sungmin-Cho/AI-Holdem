import { applyAction, createGame, legalFor, startHand } from '../../engine/hand.js';
import { newDeck } from '../../engine/cards.js';
import { snapshotDecision } from '../../engine/decision.js';

export function sizingFixture({ ai = 5, blinds = [25, 50], stack = 5000, actions = [] } = {}) {
  let state = createGame({
    aiCount: ai, startStack: stack, blinds0: blinds, mode: 'cash-training',
    levelEvery: null, startStackBb: stack / blinds[1], handLimit: 20,
  });
  state.button = ai;
  state = startHand(state, { deck: newDeck() }).state;
  for (const step of actions) {
    const legal = legalFor(state);
    const [action, amount] = Array.isArray(step) ? step : [step];
    state = applyAction(state, legal.toAct, action, amount).state;
  }
  const legal = legalFor(state);
  const snapshot = snapshotDecision(state, legal.toAct, null, { blinds: state.config.blinds0, legal });
  return { state, legal, snapshot };
}
