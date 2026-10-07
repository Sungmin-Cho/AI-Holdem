import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeck } from '../engine/cards.js';
import { snapshotDecision } from '../engine/decision.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { validatePolicyOutput } from '../training/policies/contracts.js';
import { distributionV3, scaleWidth } from '../training/policies/strategy-v3.js';
import { PERSONA_ARCHETYPES_V3, personaConfigV3 } from '../training/policies/personas-v3.js';
import { HAND_CLASSES, comboCount } from '../shared/poker-eval.js';

function deckFor(state, cardsById) {
  const n = state.seats.length;
  const sb = ((state.button + 1) % n + 1) % n;
  const order = Array.from({ length: n }, (_, i) => state.seats[(sb + i) % n].playerId);
  const fixed = Object.values(cardsById).flat();
  const rest = newDeck().filter((card) => !fixed.includes(card));
  const deck = [];
  for (let i = 0; i < 2 * n; i += 1) {
    const pid = order[i % n];
    deck.push(cardsById[pid] ? cardsById[pid][i < n ? 0 : 1] : rest.shift());
  }
  return [...deck, ...rest];
}
function table({ stacks = null, button = 5, cards = {}, board = null, mode = 'cash-training' } = {}) {
  const game = mode === 'cash-training' ? createGame({ aiCount: 5, mode, startStackBb: 100, handLimit: 10, levelEvery: null })
    : createGame({ aiCount: 5, levelEvery: 50 });
  game.button = button;
  if (stacks) game.seats.forEach((seat, i) => { seat.stack = stacks[i]; });
  let deck = deckFor(game, cards);
  if (board) {
    const used = new Set([...Object.values(cards).flat(), ...board]);
    const holes = deck.slice(0, 12);
    deck = [...holes, ...board, ...newDeck().filter((c) => !used.has(c) && !holes.includes(c))];
  }
  return startHand(game, { deck }).state;
}
const snap = (state) => {
  const legal = legalFor(state);
  return { legal, snapshot: snapshotDecision(state, legal.toAct, null, { blinds: state.config.blinds0, legal }) };
};
const mass = (freq) => freq.reduce((sum, f, i) => sum + f * comboCount(HAND_CLASSES[i]), 0);

test('every persona returns a legal, normalized, deterministic distribution across a played hand', () => {
  for (const persona of PERSONA_ARCHETYPES_V3) {
    const config = personaConfigV3(persona);
    let state = table();
    let steps = 0;
    while (!legalFor(state).handOver && steps < 40) {
      const { legal, snapshot } = snap(state);
      const items = distributionV3(snapshot, legal, config);
      assert.deepEqual(distributionV3(snapshot, legal, config), items, `${persona} deterministic`);
      assert.ok(Math.abs(items.reduce((s, r) => s + r.frequency, 0) - 1) < 1e-9);
      for (const item of items) validatePolicyOutput({ action: item.action, amount: item.amount }, legal);
      const pick = items.find((r) => r.action === 'call') ?? items.find((r) => r.action === 'check') ?? items[0];
      state = applyAction(state, legal.toAct, pick.action, pick.action === 'raise' ? pick.amount : undefined).state;
      steps += 1;
    }
  }
});

test('opening width orders the personas: Nit < TAG < LAG < Maniac', () => {
  // The button is folded to; open frequency summed over all 169 classes.
  const openMass = (persona) => {
    const config = personaConfigV3(persona);
    let total = 0;
    for (const cls of ['AA', 'KQo', 'A5s', 'T9s', '98s', 'K9o', 'Q8o', '76s', 'J7o', '54s', 'T6o', '93s']) {
      const a = cls[0], b = cls[1], s = cls[2] === 's';
      let state = table({ cards: { user: [`${a}s`, `${b}${s ? 's' : 'h'}`] } });
      while (legalFor(state).toAct !== 'user') state = applyAction(state, legalFor(state).toAct, 'fold').state;
      const { legal, snapshot } = snap(state);
      total += distributionV3(snapshot, legal, config).filter((r) => r.action === 'raise').reduce((sum, r) => sum + r.frequency, 0);
    }
    return total;
  };
  const widths = ['Nit', 'TAG', 'LAG', 'Maniac'].map(openMass);
  for (let i = 1; i < widths.length; i += 1) assert.ok(widths[i] >= widths[i - 1], JSON.stringify(widths));
  assert.ok(widths[3] > widths[0]);
});

test('scaleWidth keeps the strongest mass when narrowing and adds the next strongest when widening', () => {
  const base = new Float64Array(169);
  base[HAND_CLASSES.indexOf('AA')] = 1;
  base[HAND_CLASSES.indexOf('KK')] = 1;
  base[HAND_CLASSES.indexOf('72o')] = 1;
  const narrow = scaleWidth(base, 0.5);
  assert.ok(Math.abs(mass(narrow) - mass(base) / 2) < 1e-6);
  assert.equal(narrow[HAND_CLASSES.indexOf('AA')], 1);
  assert.equal(narrow[HAND_CLASSES.indexOf('72o')], 0);
  const wide = scaleWidth(base, 2);
  assert.ok(Math.abs(mass(wide) - 2 * mass(base)) < 1e-6);
  assert.equal(wide[HAND_CLASSES.indexOf('QQ')], 1);
});

test('a short stack pushes or folds from the push chart', () => {
  const stacks = [400, 400, 400, 400, 400, 400]; // 8bb at 25/50 (tournament stacks persist)
  let state = table({ stacks, cards: { user: ['As', 'Kd'] }, mode: 'tournament' });
  while (legalFor(state).toAct !== 'user') state = applyAction(state, legalFor(state).toAct, 'fold').state;
  const { legal, snapshot } = snap(state);
  const items = distributionV3(snapshot, legal, personaConfigV3('TAG'));
  assert.deepEqual(items.map((r) => [r.action, r.amount]), [['raise', legal.maxRaiseTo]]);
});

test('river raises are value only: the nuts nearly always, never a bluff raise', () => {
  // User BTN with As Ks on a board making the nut flush; p1 bets the river into the user.
  const board = ['Qs', '7s', '2s', '9d', '4h'];
  const cards = { user: ['As', 'Ks'], p1: ['Qh', 'Qd'] };
  let state = table({ cards, board });
  // Preflop: everyone folds to the user, who calls the blinds' action later; play it down passively.
  const passive = (s) => {
    const l = legalFor(s);
    if (l.toAct !== 'user' && l.toAct !== 'p1') return applyAction(s, l.toAct, l.canCheck ? 'check' : 'fold').state;
    return applyAction(s, l.toAct, l.canCheck ? 'check' : 'call').state;
  };
  while (!legalFor(state).handOver && !(state.hand.street === 'river' && legalFor(state).toAct === 'p1')) state = passive(state);
  assert.equal(legalFor(state).handOver, false, 'the hand reaches the river with p1 to act');
  assert.equal(state.hand.street, 'river');
  state = applyAction(state, 'p1', 'raise', 400).state;
  while (legalFor(state).toAct !== 'user') state = passive(state);
  const { legal, snapshot } = snap(state);
  const tag = distributionV3(snapshot, legal, personaConfigV3('TAG'));
  const raise = tag.filter((r) => r.action === 'raise').reduce((s, r) => s + r.frequency, 0);
  assert.ok(raise >= 0.8, JSON.stringify(tag));
  // A missed hand on the same river never raises.
  const missedSnapshot = { ...snapshot, holeCards: ['3c', '5d'], decisionId: `${snapshot.decisionId}-missed` };
  const missed = distributionV3(missedSnapshot, legal, personaConfigV3('Maniac'));
  assert.equal(missed.some((r) => r.action === 'raise' && r.frequency > 0), false, JSON.stringify(missed));
});
