import { JEV_CONFIG } from '../shared/opponent-runtime.js';
import { sampleWeighted } from '../training/policies/rng.js';

// Decision-rule constants. Changing any value is a descriptor version change.
export const PRUNE_FLOOR = 0.05;
export const SHORT_STACK_BB = 20;
export const ALL_IN_NEAR_FACTOR = 1.5;

export function jevError(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}
const bad = () => { throw jevError('JEV_INPUT_INVALID'); };
const integer = n => { if (!Number.isSafeInteger(n) || n < 0) bad(); return n; };
const enumeration = (v, values) => { if (!values.includes(v)) bad(); return v; };
const streets = ['preflop', 'flop', 'turn', 'river'];
const positions = [null, 'BTN/SB', 'BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4', 'UTG+5', 'CO'];
// Approved style text: frequency tendencies only; hand ranking and stack depth stay sound.
export const JEV_STYLES = Object.freeze({
  TAG: 'Tight-aggressive: enters pots with a selective range of strong hands and plays them aggressively with standard sizes; folds marginal hands to pressure.',
  LAG: 'Loose-aggressive: opens and three-bets a wide range and applies frequent pressure, but still folds hopeless hands and does not stack off deep without a strong hand or a strong draw.',
  Nit: 'Very tight: plays few hands, but raises premium hands (big pairs, ace-king) firmly and never folds them to a single raise; with a short stack, shoves premiums rather than limping or checking.',
  CallingStation: 'Loose-passive: calls more often than ideal with draws and weak pairs and rarely raises, but folds hopeless hands to large bets and never calls off a deep stack with nothing.',
  Maniac: 'Hyper-aggressive: raises and bluffs far more often than normal, including all-in pressure when the stack is short or the pot is large, but not with hopeless hands deep.',
  Trickster: 'Deceptive: sometimes slow-plays strong hands and occasionally bluffs, varying sizes to be hard to read, while keeping fundamentally sound hand selection.',
});
const styles = JEV_STYLES;
function cards(list, min, max) {
  if (!Array.isArray(list) || list.length < min || list.length > max
    || list.some(c => typeof c !== 'string' || !/^[2-9TJQKA][shdc]$/.test(c))) bad();
  return [...list];
}
function actorSeat(snapshot) {
  if (!Array.isArray(snapshot.publicSeats)) bad();
  const seat = snapshot.publicSeats.find(s => s?.playerId === snapshot.actorId);
  if (!seat) bad();
  return seat;
}
// Chips the actor can still lose from this decision on: own stack, capped by the deepest
// live opponent's stack plus street bet (an all-in opponent keeps its bet), less own bet.
export function effectiveRemaining(snapshot) {
  const actor = actorSeat(snapshot), actorBet = integer(actor.bet);
  const covers = snapshot.publicSeats.filter(s => s.playerId !== actor.playerId && !s.folded && !s.out)
    .map(s => integer(integer(s.stack) + integer(s.bet)));
  return Math.max(0, Math.min(integer(actor.stack), (covers.length ? Math.max(...covers) : 0) - actorBet));
}
export function buildJevCandidates(snapshot, legal) {
  if (!snapshot || !legal || typeof legal.canCheck !== 'boolean' || typeof legal.canRaise !== 'boolean') bad();
  const { canCheck, canRaise } = legal;
  const call = integer(legal.callAmount), min = integer(legal.minRaiseTo), max = integer(legal.maxRaiseTo);
  if (canCheck !== (call === 0)) bad();
  const candidates = canCheck ? [{ key: 'check', action: 'check' }] : [{ key: 'fold', action: 'fold' }];
  if (!canCheck && call > 0) candidates.push({ key: 'call', action: 'call' });
  if (canRaise) {
    const street = enumeration(snapshot.street, streets);
    if (!Array.isArray(snapshot.blinds) || snapshot.blinds.length !== 2) bad();
    const bb = integer(snapshot.blinds[1]);
    if (bb === 0) bad();
    const currentBet = integer(snapshot.currentBet), actorBet = integer(snapshot.actorBet);
    const pot = integer(integer(snapshot.potBefore) + call);
    const base = integer(actorBet + call);
    let sizes;
    if (min > max) sizes = [max];
    else {
      const unit = currentBet <= bb ? bb : currentBet;
      const standard = (street === 'preflop'
        ? [min, Math.round(2.5 * unit), 3 * unit, 4 * unit]
        : [min, ...[1 / 3, 2 / 3, 1].map(f => base + Math.round(f * pot))])
        .map(n => Math.max(min, Math.min(max, integer(n))));
      // All-in is offered only when short or close to a pot-sized raise (low SPR).
      const allIn = effectiveRemaining(snapshot) <= SHORT_STACK_BB * bb || max <= ALL_IN_NEAR_FACTOR * Math.max(...standard);
      sizes = allIn ? [...standard, max] : standard;
    }
    for (const amount of [...new Set(sizes)].sort((a, b) => a - b)) {
      candidates.push({ key: `raise_to_${amount}`, action: 'raise', amount });
    }
  }
  return candidates;
}

export function projectJevState(snapshot, legal, archetype) {
  if (!snapshot || !legal || typeof legal !== 'object' || !Object.hasOwn(styles, archetype) || !Array.isArray(snapshot.publicSeats)
    || snapshot.publicSeats.length < 2 || snapshot.publicSeats.length > 9) bad();
  const aliases = new Map(snapshot.publicSeats.map((s, i) => [s.playerId, `seat_${i}`]));
  if (aliases.size !== snapshot.publicSeats.length) bad();
  const alias = id => { if (!aliases.has(id)) bad(); return aliases.get(id); };
  const boolean = v => { if (typeof v !== 'boolean') bad(); return v; };
  if (legal.toAct !== snapshot.actorId || legal.decisionId !== snapshot.decisionId) bad();
  if (!Array.isArray(snapshot.blinds) || snapshot.blinds.length !== 2 || !Array.isArray(snapshot.priorActions)) bad();
  const bb = integer(snapshot.blinds[1]);
  if (bb === 0) bad();
  const inBB = chips => Math.round(integer(chips) / bb * 10) / 10;
  const actor = actorSeat(snapshot), toCall = integer(legal.callAmount);
  // Only the part of each opponent's contribution the actor can win back counts.
  const matched = integer(integer(actor.contribution) + toCall);
  const winnable = snapshot.publicSeats.reduce((sum, s) => s.playerId === actor.playerId ? sum
    : sum + Math.min(integer(s.contribution), matched), matched);
  const potOdds = toCall > 0 ? Math.round(toCall / winnable * 100) / 100 : 0;
  const state = {
    game: 'No-limit Texas Holdem', gameMode: enumeration(snapshot.gameMode, ['cash-training', 'tournament']),
    actor: alias(snapshot.actorId), style: styles[archetype], street: enumeration(snapshot.street, streets),
    position: enumeration(snapshot.position, positions), handNo: integer(snapshot.handNo),
    holeCards: cards(snapshot.holeCards, 2, 2), board: cards(snapshot.board, 0, 5),
    blinds: snapshot.blinds.map(integer),
    potBefore: integer(snapshot.potBefore), currentBet: integer(snapshot.currentBet), actorBet: integer(snapshot.actorBet),
    toCall: integer(legal.callAmount), effectiveStack: integer(snapshot.effectiveStack),
    bigBlind: bb, actorStackBB: inBB(actor.stack), effectiveRemainingBB: inBB(effectiveRemaining(snapshot)), potOdds,
    seats: snapshot.publicSeats.map(s => ({ player: alias(s.playerId), position: enumeration(s.position, positions),
      stack: integer(s.stack), stackBB: inBB(s.stack), bet: integer(s.bet), contribution: integer(s.contribution),
      folded: boolean(s.folded), allIn: boolean(s.allIn), out: boolean(s.out) })),
    priorActionCount: snapshot.priorActions.length, historyTruncated: snapshot.priorActions.length > 64,
    priorActions: snapshot.priorActions.slice(-64).map(a => ({ player: alias(a.playerId),
      action: enumeration(a.action, ['fold', 'check', 'call', 'raise']), amount: integer(a.amount ?? 0),
      street: enumeration(a.street, streets) })),
  };
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 24 * 1024) bad();
  return state;
}

export const JEV_INSTRUCTIONS = "Choose the single best legal action for the acting player from the candidates, using only this public situation, the player's own hole cards, and their play style. Play fundamentally sound no-limit hold'em: the style changes how often the player enters pots, bluffs, calls and raises, but never the ranking of hands. Never fold a premium hand to a small bet, never commit a deep stack (effectiveRemainingBB above 40) with a hopeless hand, and prefer a standard raise size over all-in unless the stack is short or the hand is very strong. Raise candidates are total bets on this street, not extra chips. In priorActions a raise amount is that player's total bet on the street and a call amount is the chips added. potOdds is the fraction of the pot the player can win that the call would cost.";
export function jevCriteria(candidates) {
  return Object.fromEntries(candidates.map(c => [c.key, c.action === 'raise' ? `Raise to a total of ${c.amount} chips on this street` : c.action]));
}
export function validateJevAnswer(response, candidates) {
  const invalid = () => { throw jevError('JEV_INVALID_RESPONSE', true); };
  if (!response || response.model !== JEV_CONFIG.model) throw jevError('JEV_MODEL_MISMATCH', true);
  const answers = response.answers;
  if (!answers || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'action')) invalid();
  const answer = answers.action, keys = candidates.map(c => c.key);
  const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!answer || answer.type !== 'choice' || !keys.includes(answer.choice) || !unit(answer.confidence)
    || !answer.probabilities || Array.isArray(answer.probabilities)
    || Object.keys(answer.probabilities).length !== keys.length
    || keys.some(k => !Object.hasOwn(answer.probabilities, k) || !unit(answer.probabilities[k]))) invalid();
  const values = keys.map(k => answer.probabilities[k]);
  const probabilitySum = values.reduce((a, b) => a + b, 0);
  // Observed API quantization: each probability is rounded to hundredths.
  // Allow only its mathematical rounding envelope; do not normalize or resample.
  const hundredths = values.every(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8);
  const sumTolerance = hundredths ? values.length * 0.005 + 1e-6 : 1e-6;
  // Rounded values may reorder the true maximum by one hundredth (observed 0.27 choice vs 0.28).
  const choiceTolerance = hundredths ? 0.01 + 1e-6 : 1e-6;
  if (Math.abs(probabilitySum - 1) > sumTolerance
    || Math.max(...values) - answer.probabilities[answer.choice] > choiceTolerance) invalid();
  let usage = null;
  if (response.usage !== undefined) {
    if (!response.usage || ['input_tokens', 'output_tokens'].some(k => !Number.isSafeInteger(response.usage[k]) || response.usage[k] < 0)) invalid();
    usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  }
  const chosen = candidates.find(c => c.key === answer.choice);
  return { action: { action: chosen.action, ...(chosen.amount === undefined ? {} : { amount: chosen.amount }) },
    diagnostics: { model: JEV_CONFIG.model, confidence: answer.confidence, probabilitySum,
      probabilities: Object.fromEntries(keys.map(k => [k, answer.probabilities[k]])), usage, apiChoice: answer.choice } };
}

const CLASS_ORDER = ['fold', 'check', 'call', 'raise'];
// Sums of hundredths carry float noise; class masses are compared at 1e-9.
const clean = n => Math.round(n * 1e9) / 1e9;
// Executes validated probabilities: sample a class, then take the weighted-median raise size.
export function selectJevAction({ probabilities, candidates, unit, apiChoice }) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !probabilities || typeof probabilities !== 'object'
    || Array.isArray(probabilities) || Object.keys(probabilities).length !== candidates.length
    || candidates.some(c => !c || !Object.hasOwn(probabilities, c.key) || !CLASS_ORDER.includes(c.action)
      || typeof probabilities[c.key] !== 'number' || !Number.isFinite(probabilities[c.key])
      || probabilities[c.key] < 0 || probabilities[c.key] > 1)
    || typeof unit !== 'number' || !Number.isFinite(unit) || unit < 0 || unit >= 1
    || typeof apiChoice !== 'string' || !candidates.some(c => c.key === apiChoice)) bad();
  const classMass = {};
  for (const cls of CLASS_ORDER) {
    const members = candidates.filter(c => c.action === cls);
    if (members.length) classMass[cls] = clean(members.reduce((sum, c) => sum + probabilities[c.key], 0));
  }
  const present = CLASS_ORDER.filter(cls => Object.hasOwn(classMass, cls));
  const pruned = present.filter(cls => classMass[cls] < PRUNE_FLOOR);
  const kept = present.filter(cls => classMass[cls] >= PRUNE_FLOOR);
  const total = kept.reduce((sum, cls) => sum + classMass[cls], 0);
  if (!kept.length || !(total > 0)) bad();
  const sampled = sampleWeighted(kept.map(cls => ({ cls, frequency: classMass[cls] / total })), unit).cls;
  let chosen;
  if (sampled === 'raise') {
    const raises = candidates.filter(c => c.action === 'raise').sort((a, b) => a.amount - b.amount);
    const half = classMass.raise / 2;
    let acc = 0;
    chosen = raises.find(c => clean(acc += probabilities[c.key]) >= half) ?? raises.at(-1);
  } else chosen = candidates.find(c => c.action === sampled);
  return { action: { action: chosen.action, ...(chosen.amount === undefined ? {} : { amount: chosen.amount }) },
    selection: { rule: 'class-sample-v1', unit, classMass, pruned, sampled, sizeRule: 'weighted-median',
      selectedKey: chosen.key, apiChoice } };
}
