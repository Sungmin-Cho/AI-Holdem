import { JEV_CONFIG } from '../shared/opponent-runtime.js';

export function jevError(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}
const bad = () => { throw jevError('JEV_INPUT_INVALID'); };
const integer = n => { if (!Number.isSafeInteger(n) || n < 0) bad(); return n; };
const enumeration = (v, values) => { if (!values.includes(v)) bad(); return v; };
const streets = ['preflop', 'flop', 'turn', 'river'];
const positions = [null, 'BTN/SB', 'BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4', 'UTG+5', 'CO'];
const styles = Object.freeze({ TAG: 'Tight aggressive', LAG: 'Loose aggressive', Nit: 'Very tight and cautious',
  CallingStation: 'Loose passive, inclined to call', Maniac: 'Very loose aggressive', Trickster: 'Deceptive and varied' });
function cards(list, min, max) {
  if (!Array.isArray(list) || list.length < min || list.length > max
    || list.some(c => typeof c !== 'string' || !/^[2-9TJQKA][shdc]$/.test(c))) bad();
  return [...list];
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
    const sizes = min > max ? [max] : street === 'preflop'
      ? [min, integer(Math.round(Math.max(2.5 * bb, 3 * currentBet))), integer(Math.max(4 * bb, 4 * currentBet)), max]
      : [min, ...[1 / 3, 2 / 3, 1].map(f => integer(base + Math.round(f * pot))), max];
    for (const amount of [...new Set(sizes.map(n => min > max ? max : Math.max(min, Math.min(max, n))))].sort((a, b) => a - b)) {
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
  const state = {
    game: 'No-limit Texas Holdem', gameMode: enumeration(snapshot.gameMode, ['cash-training', 'tournament']),
    actor: alias(snapshot.actorId), style: styles[archetype], street: enumeration(snapshot.street, streets),
    position: enumeration(snapshot.position, positions), handNo: integer(snapshot.handNo),
    holeCards: cards(snapshot.holeCards, 2, 2), board: cards(snapshot.board, 0, 5),
    blinds: snapshot.blinds.map(integer),
    potBefore: integer(snapshot.potBefore), currentBet: integer(snapshot.currentBet), actorBet: integer(snapshot.actorBet),
    toCall: integer(legal.callAmount), effectiveStack: integer(snapshot.effectiveStack),
    seats: snapshot.publicSeats.map(s => ({ player: alias(s.playerId), position: enumeration(s.position, positions),
      stack: integer(s.stack), bet: integer(s.bet), contribution: integer(s.contribution),
      folded: boolean(s.folded), allIn: boolean(s.allIn), out: boolean(s.out) })),
    priorActionCount: snapshot.priorActions.length, historyTruncated: snapshot.priorActions.length > 64,
    priorActions: snapshot.priorActions.slice(-64).map(a => ({ player: alias(a.playerId),
      action: enumeration(a.action, ['fold', 'check', 'call', 'raise']), amount: integer(a.amount ?? 0),
      street: enumeration(a.street, streets) })),
  };
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 24 * 1024) bad();
  return state;
}

export const JEV_INSTRUCTIONS = 'Choose one legal poker action for the acting player using only this public situation, their own hole cards, and their play style. Raise amounts are total bets on this street, not extra chips. Choose the most appropriate candidate.';
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
  if (Math.abs(probabilitySum - 1) > sumTolerance
    || Math.max(...values) - answer.probabilities[answer.choice] > 1e-6) invalid();
  let usage = null;
  if (response.usage !== undefined) {
    if (!response.usage || ['input_tokens', 'output_tokens'].some(k => !Number.isSafeInteger(response.usage[k]) || response.usage[k] < 0)) invalid();
    usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  }
  const chosen = candidates.find(c => c.key === answer.choice);
  return { action: { action: chosen.action, ...(chosen.amount === undefined ? {} : { amount: chosen.amount }) },
    diagnostics: { model: JEV_CONFIG.model, confidence: answer.confidence, probabilitySum,
      probabilities: Object.fromEntries(keys.map(k => [k, answer.probabilities[k]])), usage } };
}
