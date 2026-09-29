import { JEV_CONFIG } from '../shared/opponent-runtime.js';
import { sampleWeighted } from '../training/policies/rng.js';

// Decision-rule constants. Changing any value is a descriptor version change.
export const PRUNE_FLOOR = 0.05;
export const SHORT_STACK_BB = 20;
export const ALL_IN_NEAR_FACTOR = 1.5;
// v3 (class-sample-v2, legal-menu-v3): deep-stack commit guard and near-all-in merge.
export const DEEP_BB = 40;
export const COMMIT_NEAR = 0.95;
export const COMMIT_MASS_FLOOR = 0.6;
export const GUARD_PREMIUMS = Object.freeze(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

export function jevError(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}
const bad = () => { throw jevError('JEV_INPUT_INVALID'); };
const integer = n => { if (!Number.isSafeInteger(n) || n < 0) bad(); return n; };
const enumeration = (v, values) => { if (!values.includes(v)) bad(); return v; };
const streets = ['preflop', 'flop', 'turn', 'river'];
const positions = [null, 'BTN/SB', 'BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4', 'UTG+5', 'CO'];
// Approved style text: frequency tendencies only; hand ranking and stack depth stay sound.
// poker-choice-v3: TAG, Nit, CallingStation and Trickster were entering and raising far
// above their frequency bands in the v2 gate; LAG and Maniac are unchanged.
export const JEV_STYLES = Object.freeze({
  TAG: 'Tight-aggressive: folds most hands before the flop and enters only with strong hands, opening and three-betting them with standard sizes; four-bets only premium hands; folds marginal hands to pressure.',
  LAG: 'Loose-aggressive: opens and three-bets a wide range and applies frequent pressure, but still folds hopeless hands and does not stack off deep without a strong hand or a strong draw.',
  Nit: 'Very tight: plays few hands and raises only premium hands (big pairs, ace-king), never folding them to a single raise; with other playable hands prefers calling or folding; with a short stack, shoves premiums rather than limping or checking.',
  CallingStation: 'Loose-passive: calls often with draws and weak pairs but almost never raises, even with good hands; never bluffs, folds hopeless hands to large bets, and never calls off or moves all-in with a deep stack without a strong made hand.',
  Maniac: 'Hyper-aggressive: raises and bluffs far more often than normal, including all-in pressure when the stack is short or the pot is large, but not with hopeless hands deep.',
  Trickster: "Deceptive but disciplined: hand selection is as tight and sound as a solid regular's; the deception comes from how strong hands are played (occasional slow-plays, varied sizes), not from playing more hands.",
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
// Full raises on the current street before this decision (blinds are posts, not actions).
// A raise reopens the ladder only when its increment reaches the last full raise, the same
// rule the engine uses for a full raise; a short all-in raise does not.
export function fullRaisesThisStreet(snapshot, bb) {
  if (!Array.isArray(snapshot.priorActions)) bad();
  let current = snapshot.street === 'preflop' ? bb : 0, lastFull = bb, raises = 0;
  for (const a of snapshot.priorActions) {
    if (a?.street !== snapshot.street || a.action !== 'raise') continue;
    const amount = integer(a.amount);
    if (amount - current >= lastFull) { raises += 1; lastFull = amount - current; }
    current = Math.max(current, amount);
  }
  return raises;
}

export function handCategory(hole) {
  const order = '23456789TJQKA';
  const [a, b] = [...cards(hole, 2, 2)].sort((x, y) => order.indexOf(y[0]) - order.indexOf(x[0]));
  return a[0] === b[0] ? a[0] + b[0] : `${a[0]}${b[0]}${a[1] === b[1] ? 's' : 'o'}`;
}

// class-sample-v2 guard inputs, derived from the same public state the menu uses: deep
// (effective remaining > 40bb), the commit candidates (a raise within 5% of all-in, or a
// call of at least 95% of the stack) and the preflop premium exception.
export function jevGuardContext(snapshot, legal, candidates) {
  const bb = integer(snapshot.blinds?.[1]);
  const max = integer(legal.maxRaiseTo), call = integer(legal.callAmount);
  const stack = integer(actorSeat(snapshot).stack);
  const commitKeys = candidates.filter(c => (c.action === 'raise' && c.amount >= COMMIT_NEAR * max)
    || (c.action === 'call' && call >= COMMIT_NEAR * stack)).map(c => c.key);
  return {
    deep: effectiveRemaining(snapshot) > DEEP_BB * bb,
    commitKeys,
    premium: snapshot.street === 'preflop' && GUARD_PREMIUMS.includes(handCategory(snapshot.holeCards)),
  };
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
    const raises = street === 'preflop' ? fullRaisesThisStreet(snapshot, bb) : 0;
    if (min > max || raises >= 3) sizes = [max]; // engine-forced all-in, or a five-bet is all-in
    else {
      // legal-menu-v3: the preflop ladder follows the number of full raises (a short all-in
      // raise does not reopen it), aligned with training/policies/sizing.js.
      // Multiples in exact tenths (23 * 425 / 10 = 977.5 -> 978, not 977.4999… -> 977).
      const tenths = (ks, of) => ks.map(k => Math.round((k * of) / 10));
      const multiples = street !== 'preflop' ? null
        : raises === 0 ? tenths([25, 30, 40], bb)
          : raises === 1 ? tenths([30, 34, 40], currentBet)
            : tenths([22, 23, 25], currentBet);
      const standard = (street === 'preflop'
        ? [min, ...multiples]
        : [min, ...[1 / 3, 2 / 3, 1].map(f => base + Math.round(f * pot))])
        .map(n => Math.max(min, Math.min(max, integer(n))))
        // A size within 5% of all-in is all-in: a separate 8-chip-short slot would dodge the guard.
        .map(n => (n >= COMMIT_NEAR * max ? max : n));
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

export const JEV_INSTRUCTIONS = "Choose the single best legal action for the acting player from the candidates, using only this public situation, the player's own hole cards, and their play style. Play fundamentally sound no-limit hold'em: the style changes how often the player enters pots, bluffs, calls and raises, but never the ranking of hands. Never fold a premium hand to a small bet, never commit a deep stack (effectiveRemainingBB above 40) with a hopeless hand, and prefer a standard raise size over all-in unless the stack is short or the hand is very strong. Facing a raise or an all-in that would commit most of a deep stack, continue only with premium or very strong hands; weak aces and weak offsuit hands fold. Raise candidates are total bets on this street, not extra chips. In priorActions a raise amount is that player's total bet on the street and a call amount is the chips added. potOdds is the fraction of the pot the player can win that the call would cost.";
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
export const SELECTION_RULES = Object.freeze(['class-sample-v1', 'class-sample-v2']);
// Executes validated probabilities: sample a class, then take the weighted-median raise size.
// class-sample-v2 first removes deep-stack commit candidates whose summed probability is
// below COMMIT_MASS_FLOOR (never for a preflop premium). The removal is a deterministic
// transform before the single draw — the same unit, never a redraw.
export function selectJevAction({ probabilities, candidates, unit, apiChoice, rule = 'class-sample-v1', guard }) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !probabilities || typeof probabilities !== 'object'
    || Array.isArray(probabilities) || Object.keys(probabilities).length !== candidates.length
    || candidates.some(c => !c || !Object.hasOwn(probabilities, c.key) || !CLASS_ORDER.includes(c.action)
      || typeof probabilities[c.key] !== 'number' || !Number.isFinite(probabilities[c.key])
      || probabilities[c.key] < 0 || probabilities[c.key] > 1)
    || typeof unit !== 'number' || !Number.isFinite(unit) || unit < 0 || unit >= 1
    || typeof apiChoice !== 'string' || !candidates.some(c => c.key === apiChoice)
    || !SELECTION_RULES.includes(rule)) bad();
  let eligible = candidates, guardRecord = null;
  if (rule === 'class-sample-v2') {
    if (!guard || typeof guard.deep !== 'boolean' || typeof guard.premium !== 'boolean' || !Array.isArray(guard.commitKeys)
      || guard.commitKeys.some(key => !candidates.some(c => c.key === key && (c.action === 'raise' || c.action === 'call')))) bad();
    if (guard.deep && !guard.premium && guard.commitKeys.length) {
      const mass = clean(guard.commitKeys.reduce((sum, key) => sum + probabilities[key], 0));
      if (mass < COMMIT_MASS_FLOOR) {
        eligible = candidates.filter(c => !guard.commitKeys.includes(c.key));
        guardRecord = { commit: [...guard.commitKeys], mass };
      }
    }
  } else if (guard !== undefined) bad();
  const classMass = {};
  for (const cls of CLASS_ORDER) {
    const members = eligible.filter(c => c.action === cls);
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
    const raises = eligible.filter(c => c.action === 'raise').sort((a, b) => a.amount - b.amount);
    const half = classMass.raise / 2;
    let acc = 0;
    chosen = raises.find(c => clean(acc += probabilities[c.key]) >= half) ?? raises.at(-1);
  } else chosen = eligible.find(c => c.action === sampled);
  return { action: { action: chosen.action, ...(chosen.amount === undefined ? {} : { amount: chosen.amount }) },
    selection: { rule, unit, classMass, pruned, sampled, sizeRule: 'weighted-median',
      selectedKey: chosen.key, apiChoice, ...(guardRecord ? { guard: guardRecord } : {}) } };
}
