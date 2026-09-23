// JEV decision-rule v2 live gate: pure verdicts over archived hands + private loop-state.
// These are heuristic sanity checks (no self-destruction, styles still visible), not a
// measure of poker skill, profit or GTO quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eval5, compareScore } from '../../engine/evaluator.js';
import { rankValue } from '../../engine/cards.js';
import { selectJevAction } from '../../tools/jev-player.js';

// perRun also bounds a run below the diagnostics byte cap (256 KiB ≈ 400 v2 entries); a run past
// it would drop entries and make ① unjudgeable.
export const GATE_BUDGET = Object.freeze({ total: 1200, perRun: 400, expectedRun: 200 });
export const MIN_DECISIONS = 100;
export const DEEP_BB = 40;
export const PREMIUM_CALL_SHARE = 0.2;
export const EARLY_HANDS = 5;
export const MIN_OPPORTUNITIES = 30;
export const PREMIUMS = Object.freeze(['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo']);
export const VPIP_BANDS = Object.freeze({ Nit: [8, 25], TAG: [18, 35], LAG: [30, 60], Maniac: [40, 75],
  CallingStation: [35, 70], Trickster: [20, 45] });
export const PFR_MAX = Object.freeze({ CallingStation: 15 });

// Per-run request cap never lets the approved total be exceeded.
export function runCap(spent, budget = GATE_BUDGET) {
  return Math.max(0, Math.min(budget.perRun, budget.total - spent));
}
// An invalid run is repeated only when the remainder still covers a typical run.
export function mayRerun(spent, budget = GATE_BUDGET) {
  return budget.total - spent > budget.expectedRun;
}

// Chen formula, rounded up (x.5 -> next integer).
export function chen(hole) {
  const [hi, lo] = hole.map(rankValue).sort((a, b) => b - a);
  const high = v => ({ 14: 10, 13: 8, 12: 7, 11: 6 })[v] ?? v / 2;
  if (hi === lo) return Math.max(5, high(hi) * 2);
  let score = high(hi) + (hole[0][1] === hole[1][1] ? 2 : 0);
  const gap = hi - lo - 1;
  score -= [0, 1, 2, 4][gap] ?? 5;
  if (gap <= 1 && hi < 12) score += 1;
  return Math.ceil(score);
}
export function handClass(hole) {
  const [a, b] = [...hole].sort((x, y) => rankValue(y) - rankValue(x));
  return a[0] === b[0] ? a[0] + b[0] : `${a[0]}${b[0]}${a[1] === b[1] ? 's' : 'o'}`;
}
export const isPremium = hole => PREMIUMS.includes(handClass(hole));

function bestFive(cards) {
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const score = eval5(chosen);
      if (!best || compareScore(score, best.score) > 0) best = { score, cards: [...chosen] };
      return;
    }
    for (let i = start; i < cards.length; i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  return best;
}
function flushDraw(hole, board) {
  return hole.some(card => [...hole, ...board].filter(c => c[1] === card[1]).length >= 4);
}
// Any single missing rank completing five in a row that uses a hole card: gutshot, open-ended or double gutshot.
function straightDraw(hole, board) {
  const low = v => (v === 14 ? [14, 1] : [v]);
  const present = new Set([...hole, ...board].flatMap(c => low(rankValue(c))));
  const holeRanks = new Set(hole.flatMap(c => low(rankValue(c))));
  for (let start = 1; start <= 10; start++) {
    const window = [0, 1, 2, 3, 4].map(i => start + i);
    const have = window.filter(v => present.has(v));
    if (have.length === 4 && have.some(v => holeRanks.has(v))) return true;
  }
  return false;
}
// Hopeless = no made hand the hole cards take part in, no draw on flop/turn, not two overcards.
export function hopeless(hole, board, street) {
  if (street === 'preflop') return chen(hole) < 6;
  const best = bestFive([...hole, ...board]);
  if (best.score[0] >= 4) return false;
  const counts = new Map();
  for (const card of best.cards) counts.set(rankValue(card), (counts.get(rankValue(card)) ?? 0) + 1);
  const holeRanks = hole.map(rankValue);
  for (const [rank, many] of counts) {
    if (many >= 2 && holeRanks.includes(rank) && board.filter(c => rankValue(c) === rank).length < many) return false;
  }
  if (street !== 'river' && (flushDraw(hole, board) || straightDraw(hole, board))) return false;
  const top = Math.max(...board.map(rankValue));
  return !holeRanks.every(rank => rank > top);
}

// Street bets and folds just before actions[index], rebuilt from posts and prior actions.
function tableAt(hand, index) {
  let street = 'preflop', bets = {};
  for (const post of hand.posts ?? []) bets[post.playerId] = (bets[post.playerId] ?? 0) + post.amount;
  const folded = new Set();
  for (let i = 0; i <= index; i++) {
    const a = hand.actions[i];
    if (a.street !== street) { street = a.street; bets = {}; }
    if (i === index) break;
    if (a.action === 'raise') bets[a.playerId] = a.amount;
    else if (a.action === 'call') bets[a.playerId] = (bets[a.playerId] ?? 0) + a.amount;
    else if (a.action === 'fold') folded.add(a.playerId);
  }
  return { bets, folded };
}
export function effectiveRemainingAt(hand, index) {
  const a = hand.actions[index], { bets, folded } = tableAt(hand, index);
  const actorBet = a.maxRaiseTo - a.stacks[a.playerId];
  const covers = Object.keys(hand.holes).filter(id => id !== a.playerId && !folded.has(id))
    .map(id => (a.stacks[id] ?? 0) + (bets[id] ?? 0));
  return Math.max(0, Math.min(a.stacks[a.playerId], (covers.length ? Math.max(...covers) : 0) - actorBet));
}
export function isAllIn(a) {
  return (a.action === 'raise' && a.amount === a.maxRaiseTo) || (a.action === 'call' && a.callAmount >= a.stacks[a.playerId]);
}

const candidatesOf = probabilities => Object.keys(probabilities).map(key => key.startsWith('raise_to_')
  ? { key, action: 'raise', amount: Number(key.slice('raise_to_'.length)) } : { key, action: key });
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

function judgeRun(run) {
  const ai = new Map((run.players ?? []).filter(p => p.archetype).map(p => [p.playerId, p.archetype]));
  const hands = [...run.hands].sort((a, b) => a.handNo - b.handNo);
  const archived = new Map();
  hands.forEach(hand => hand.actions.forEach((action, index) => {
    if (ai.has(action.playerId)) archived.set(action.decisionId, { hand, index, action });
  }));
  const diagnostics = run.loopState?.jevDiagnostics ?? { entries: [], dropped: 0 };
  const entries = diagnostics.entries ?? [];
  const v1Entries = entries.filter(e => !e.selection).length;
  // Only the hand after the last archived one may be unfinished (End keeps it out of the archive).
  const handOf = id => Number(String(id).split('-')[1]);
  const lastArchived = Math.max(0, ...hands.map(h => h.handNo));
  const unarchived = entries.filter(e => !archived.has(e.decisionId));
  const incomplete = new Set(unarchived.filter(e => handOf(e.decisionId) > lastArchived).map(e => e.decisionId));
  const missingArchive = new Set(unarchived.filter(e => !incomplete.has(e.decisionId)).map(e => e.decisionId));
  const top = new Map();
  for (const e of entries) {
    if (!e.selection || !archived.has(e.decisionId)) continue;
    const prev = top.get(e.decisionId);
    if (!prev || e.generation > prev.generation) top.set(e.decisionId, e);
  }
  const metrics = (run.loopState?.metrics ?? []).filter(m => m.runtime === 'jev');
  const failures = metrics.filter(m => !['jev_accepted', 'jev_single_legal'].includes(m.outcome));
  const accepted = new Set(metrics.filter(m => m.outcome === 'jev_accepted' && archived.has(m.decisionId)).map(m => m.decisionId));
  const withEntry = [...archived.keys()].filter(id => top.has(id));
  // Every archived AI decision is either a recorded selection or an explicit single-legal skip.
  const singleLegal = new Set(metrics.filter(m => m.outcome === 'jev_single_legal').map(m => m.decisionId));
  const unexplained = [...archived.keys()].filter(id => !top.has(id) && !singleLegal.has(id)
    && !entries.some(e => e.decisionId === id && !e.selection));
  const recomputed = [...top.values()].filter(e => {
    const again = selectJevAction({ probabilities: e.probabilities, candidates: candidatesOf(e.probabilities),
      unit: e.selection.unit, apiChoice: e.apiChoice });
    const applied = archived.get(e.decisionId).action;
    return again.selection.selectedKey === e.selection.selectedKey && applied.action === again.action.action
      && (again.action.action !== 'raise' || applied.amount === again.action.amount);
  }).length;
  const pending = run.loopState?.pendingDecision;
  const reasons = [];
  if (v1Entries) reasons.push('v1 — ① 미적용');
  if (top.size < MIN_DECISIONS) reasons.push(`결정 ${top.size} < ${MIN_DECISIONS}`);
  if (failures.length) reasons.push(`실패 ${failures.length}`);
  if (pending && pending.status !== 'running') reasons.push(`pending ${pending.status}`);
  if (diagnostics.dropped !== 0 || diagnostics.historyIncomplete) reasons.push('진단 절단/손상');
  if (!(accepted.size === top.size && top.size === withEntry.length && withEntry.every(id => accepted.has(id))))
    reasons.push(`개수 불일치 accepted ${accepted.size} / entry ${top.size} / archive ${withEntry.length}`);
  if (recomputed !== top.size) reasons.push(`재계산 ${recomputed}/${top.size}`);
  if (missingArchive.size) reasons.push(`아카이브 없는 완료 핸드 entry ${missingArchive.size}`);
  if (unexplained.length) reasons.push(`entry·single-legal 없는 아카이브 AI 결정 ${unexplained.length}`);
  const one = { pass: reasons.length === 0, reasons, decisions: top.size, incomplete: incomplete.size, v1Entries,
    failures: failures.length, recomputed };

  const deep = [], premium = [], vpip = new Map();
  for (const { hand, index, action } of archived.values()) {
    const hole = hand.holes[action.playerId], bb = hand.blinds[1];
    if (effectiveRemainingAt(hand, index) > DEEP_BB * bb && hopeless(hole, action.board, action.street)) {
      deep.push({ decisionId: action.decisionId, allIn: isAllIn(action) });
    }
    if (action.street === 'preflop' && isPremium(hole) && action.callAmount > 0
      && action.callAmount <= PREMIUM_CALL_SHARE * action.stacks[action.playerId]) {
      premium.push({ decisionId: action.decisionId, folded: action.action === 'fold' });
    }
  }
  for (const hand of hands) {
    for (const id of Object.keys(hand.holes)) {
      if (!ai.has(id)) continue;
      const pre = hand.actions.filter(a => a.playerId === id && a.street === 'preflop');
      vpip.set(`${run.name}|${id}|${hand.handNo}`, { archetype: ai.get(id),
        vpip: pre.some(a => a.action === 'call' || a.action === 'raise'), pfr: pre.some(a => a.action === 'raise') });
    }
  }
  const two = { pass: deep.every(d => !d.allIn), opportunities: deep.length, violations: deep.filter(d => d.allIn).map(d => d.decisionId) };
  const four = { pass: premium.every(p => !p.folded), opportunities: premium.length, violations: premium.filter(p => p.folded).map(p => p.decisionId) };
  const busted = (limit = Infinity) => hands.filter(h => h.handNo <= limit)
    .flatMap(h => Object.entries(h.endStacks ?? {}).filter(([id, stack]) => ai.has(id) && stack === 0 && Object.hasOwn(h.holes, id)).map(([id]) => id));
  const three = run.mode === 'tournament'
    ? { applies: true, pass: new Set(busted(EARLY_HANDS)).size <= 1, bustedEarly: [...new Set(busted(EARLY_HANDS))].length }
    : { applies: false, zeroStackFirst5: busted(EARLY_HANDS).length, zeroStackAll: busted().length };
  const sampled = [...top.values()];
  const offTop = sampled.filter(e => {
    const mass = e.selection.classMass;
    return mass[e.selection.sampled] < Math.max(...Object.values(mass));
  }).length;
  const allInExposed = [...top.keys()].filter(id => Object.hasOwn(top.get(id).probabilities, `raise_to_${archived.get(id).action.maxRaiseTo}`)).length;
  const model = metrics.filter(m => m.outcome === 'jev_accepted').map(m => m.modelMs).filter(Number.isFinite);
  const report = { offTopClassRate: sampled.length ? offTop / sampled.length : null,
    allInExposureRate: sampled.length ? allInExposed / sampled.length : null,
    modelMsP50: percentile(model, 0.5), modelMsP90: percentile(model, 0.9),
    tokens: entries.reduce((sum, e) => ({ input: sum.input + (e.usage?.input_tokens ?? 0), output: sum.output + (e.usage?.output_tokens ?? 0) }), { input: 0, output: 0 }),
    entryBytes: Buffer.byteLength(JSON.stringify(entries), 'utf8'), requests: run.requests ?? null, stoppedBy: run.stoppedBy ?? null };
  const pass = one.pass && two.pass && four.pass && (!three.applies || three.pass);
  return { run: { name: run.name, mode: run.mode, hands: hands.length, pass, one, two, three, four, report }, vpip };
}

export function gateSessions(runs) {
  const perRun = [], pooledRows = new Map();
  for (const run of runs) {
    const judged = judgeRun(run);
    perRun.push(judged.run);
    for (const [key, row] of judged.vpip) pooledRows.set(key, row);
  }
  const vpip = {};
  for (const archetype of Object.keys(VPIP_BANDS)) {
    const rows = [...pooledRows.values()].filter(r => r.archetype === archetype);
    const opportunities = rows.length;
    const rate = n => (opportunities ? Math.round(n / opportunities * 1000) / 10 : null);
    const v = rate(rows.filter(r => r.vpip).length), p = rate(rows.filter(r => r.pfr).length);
    const judged = opportunities >= MIN_OPPORTUNITIES;
    const [lo, hi] = VPIP_BANDS[archetype];
    const pass = !judged || (v >= lo && v <= hi && (PFR_MAX[archetype] === undefined || p <= PFR_MAX[archetype]));
    vpip[archetype] = { opportunities, vpip: v, pfr: p, judged, pass, band: [lo, hi], ...(judged ? {} : { note: '표본 부족 — 보류' }) };
  }
  const pooled = { vpip, pass: Object.values(vpip).every(r => r.pass) };
  return { perRun, pooled, verdict: perRun.every(r => r.pass) && pooled.pass ? 'PASS' : 'FAIL' };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// A journey output dir holds result.json and a kept session/ copy; a bare session dir also works.
export function loadGateRun(dir) {
  const session = fs.existsSync(path.join(dir, 'session', 'state.json')) ? path.join(dir, 'session') : dir;
  const result = fs.existsSync(path.join(dir, 'result.json')) ? readJson(path.join(dir, 'result.json')) : {};
  const engine = readJson(path.join(session, 'state.json'));
  const handsDir = path.join(session, 'hands');
  const hands = fs.existsSync(handsDir) ? fs.readdirSync(handsDir).filter(n => /^hand-.*\.json$/.test(n)).map(n => readJson(path.join(handsDir, n))) : [];
  return { name: path.basename(dir), mode: engine.config?.mode ?? 'tournament', hands,
    loopState: readJson(path.join(session, 'loop-state.json')), players: readJson(path.join(session, 'players.json')),
    requests: Array.isArray(result.requests) ? result.requests.length : null, stoppedBy: result.stoppedBy ?? null };
}

// `node --test` also loads this file from test/; only a direct invocation runs the CLI.
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: node test/helpers/jev-gate.mjs <run-dir>...'); process.exit(2); }
  const result = gateSessions(dirs.map(loadGateRun));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}
