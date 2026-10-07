#!/usr/bin/env node
// Self-play measurements for policy v3 (design gates G5/G6):
//   --tendencies [--hands N]   persona VPIP/PFR, TAG c-bet and nut-raise rates
//   --exploit-sim [--hands N]  degenerate hero strategies against lobby tables:
//                              bb/100 with a 95% confidence interval
// Deterministic for a given --seed. Cash tables, 100bb, blinds 50/100.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newDeck } from '../engine/cards.js';
import { snapshotDecision } from '../engine/decision.js';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { preflopRates } from '../engine/views.js';
import { scoreCards, seedFrom, toCardInts, xorshift32 } from '../shared/poker-eval.js';
import { handClassOf } from '../training/cards.js';
import { distributionV3 } from '../training/policies/strategy-v3.js';
import { PERSONA_ARCHETYPES_V3, personaConfigV3 } from '../training/policies/personas-v3.js';

const BB = 100;
const PREMIUMS = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

function shuffled(items, next) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sample(items, unit) {
  let acc = 0;
  for (const item of items) {
    acc += item.frequency;
    if (unit < acc) return item;
  }
  return items.at(-1);
}

export function personaAgent(name) {
  const config = personaConfigV3(name);
  return (snapshot, legal) => distributionV3(snapshot, legal, config);
}

const fold = (legal) => (legal.canCheck ? { action: 'check', amount: 0 } : { action: 'fold', amount: 0 });
export const DEGENERATE = Object.freeze({
  'premium-allin': (snapshot, legal) => {
    if (snapshot.street === 'preflop' && legal.canRaise && PREMIUMS.has(handClassOf(snapshot.holeCards))) {
      return [{ action: 'raise', amount: legal.maxRaiseTo, frequency: 1 }];
    }
    if (snapshot.street === 'preflop' && PREMIUMS.has(handClassOf(snapshot.holeCards))) return [{ action: 'call', amount: legal.callAmount, frequency: 1 }];
    return [{ ...fold(legal), frequency: 1 }];
  },
  'bet-when-checked': (snapshot, legal) => {
    if (snapshot.street === 'preflop') return personaAgent('TAG')(snapshot, legal);
    if (legal.canCheck && legal.canRaise) {
      const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round((snapshot.actorBet ?? 0) + 0.66 * snapshot.potBefore)));
      return [{ action: 'raise', amount: to, frequency: 1 }];
    }
    return [{ ...fold(legal), frequency: 1 }];
  },
  'always-min-raise': (snapshot, legal) => {
    if (legal.canRaise) return [{ action: 'raise', amount: Math.min(legal.minRaiseTo, legal.maxRaiseTo), frequency: 1 }];
    return [legal.canCheck ? { action: 'check', amount: 0, frequency: 1 } : { action: 'call', amount: legal.callAmount, frequency: 1 }];
  },
  'always-call': (snapshot, legal) => [legal.canCheck ? { action: 'check', amount: 0, frequency: 1 } : { action: 'call', amount: legal.callAmount, frequency: 1 }],
});

// Plays `hands` hands; `agents` maps engine player ids (user, p1..) to agents.
// `observe(event)` sees every decision with its sampled action.
export function playTable({ hands, agents, seed, observe }) {
  const ids = Object.keys(agents);
  let state = createGame({ aiCount: ids.length - 1, startStack: 100 * BB, blinds0: [BB / 2, BB], mode: 'cash-training',
    levelEvery: null, startStackBb: 100, handLimit: hands + 1 });
  const next = xorshift32(seedFrom(`table:${seed}`));
  const nets = Object.fromEntries(ids.map((id) => [id, []]));
  for (let hand = 0; hand < hands; hand += 1) {
    state = startHand(state, { deck: shuffled(newDeck(), next) }).state;
    while (!legalFor(state).handOver) {
      const legal = legalFor(state);
      const pid = legal.toAct;
      const snapshot = snapshotDecision(state, pid, null, { blinds: state.config.blinds0, legal });
      const items = agents[pid](snapshot, legal);
      const picked = sample(items, next() / 4294967296);
      observe?.({ pid, snapshot, legal, picked, state });
      state = applyAction(state, pid, picked.action, picked.action === 'raise' ? picked.amount : undefined).state;
    }
    const record = state.lastHand;
    for (const id of ids) nets[id].push((record.endStacks[id] - record.startStacks[id]) / BB);
  }
  return { state, nets };
}

function interval(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = 1.96 * sd / Math.sqrt(n);
  return { hands: n, bbPer100: 100 * mean, low: 100 * (mean - half), high: 100 * (mean + half) };
}

// G5: six personas at one table, seats rotated per block.
export function measureTendencies({ hands = 3000, seed = 'g5', block = 250 } = {}) {
  const totals = Object.fromEntries(PERSONA_ARCHETYPES_V3.map((name) => [name, { vpip: 0, pfr: 0, sample: 0 }]));
  const cbet = { opportunities: 0, bets: 0 };
  const nuts = { opportunities: 0, raises: 0 };
  const lastRaiser = { hand: null, pid: null };
  for (let done = 0, round = 0; done < hands; done += block, round += 1) {
    const seats = shuffled(PERSONA_ARCHETYPES_V3, xorshift32(seedFrom(`${seed}:seats:${round}`)));
    const ids = ['user', 'p1', 'p2', 'p3', 'p4', 'p5'];
    const agents = Object.fromEntries(ids.map((id, i) => [id, personaAgent(seats[i])]));
    const nameOf = Object.fromEntries(ids.map((id, i) => [id, seats[i]]));
    const { state } = playTable({ hands: Math.min(block, hands - done), agents, seed: `${seed}:${round}`, observe: ({ pid, snapshot, legal, picked, state: s }) => {
      if (snapshot.street === 'preflop' && picked.action === 'raise') { lastRaiser.hand = s.handNo; lastRaiser.pid = pid; }
      const live = (snapshot.publicSeats ?? []).filter((seat) => !seat.out && !seat.folded);
      if (snapshot.street === 'flop' && nameOf[pid] === 'TAG' && live.length === 2 && lastRaiser.hand === s.handNo && lastRaiser.pid === pid
        && legal.canCheck && !(snapshot.priorActions ?? []).some((a) => a.street === 'flop' && a.action === 'raise')) {
        const firstOwn = !(snapshot.priorActions ?? []).some((a) => a.street === 'flop' && a.playerId === pid);
        if (firstOwn) { cbet.opportunities += 1; if (picked.action === 'raise') cbet.bets += 1; }
      }
      if (snapshot.street === 'river' && !legal.canCheck && legal.canRaise) {
        const hole = toCardInts(snapshot.holeCards); const board = toCardInts(snapshot.board);
        const mine = scoreCards([...hole, ...board]);
        const used = new Set([...hole, ...board]);
        let best = true;
        for (let a = 0; a < 52 && best; a += 1) for (let b = a + 1; b < 52; b += 1) {
          if (used.has(a) || used.has(b)) continue;
          if (scoreCards([a, b, ...board]) > mine) { best = false; break; }
        }
        if (best) { nuts.opportunities += 1; if (picked.action === 'raise') nuts.raises += 1; }
      }
    } });
    for (const id of ids) {
      const raw = state.stats?.[id] ?? {};
      const rates = preflopRates(raw);
      const row = totals[nameOf[id]];
      row.vpip += (raw.vpip ?? 0); row.pfr += (raw.pfr ?? 0); row.sample += rates.sample;
    }
  }
  const personas = Object.fromEntries(Object.entries(totals).map(([name, row]) => [name, {
    vpip: row.sample ? 100 * row.vpip / row.sample : 0, pfr: row.sample ? 100 * row.pfr / row.sample : 0, sample: row.sample,
  }]));
  return { personas, tagCbet: { ...cbet, rate: cbet.opportunities ? 100 * cbet.bets / cbet.opportunities : null },
    nutRaise: { ...nuts, rate: nuts.opportunities ? 100 * nuts.raises / nuts.opportunities : null } };
}

// G6: the hero plays a degenerate strategy against five lobby personas (each
// block drops one of the six archetypes, as the lobby's shuffled bag does).
export function measureExploits({ hands = 20000, seed = 'g6', block = 500, strategies = Object.keys(DEGENERATE) } = {}) {
  const out = {};
  for (const name of strategies) {
    const values = [];
    for (let done = 0, round = 0; done < hands; done += block, round += 1) {
      const table = shuffled(PERSONA_ARCHETYPES_V3, xorshift32(seedFrom(`${seed}:${name}:${round}`))).slice(0, 5);
      const agents = { user: DEGENERATE[name] };
      table.forEach((persona, i) => { agents[`p${i + 1}`] = personaAgent(persona); });
      const { nets } = playTable({ hands: Math.min(block, hands - done), agents, seed: `${seed}:${name}:${round}` });
      values.push(...nets.user);
    }
    out[name] = interval(values);
  }
  return out;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[arg.slice(2)] = next; i += 1; } else flags[arg.slice(2)] = true;
  }
  return flags;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const flags = parseArgs(process.argv.slice(2));
  const hands = flags.hands ? Number(flags.hands) : undefined;
  const result = {};
  if (flags.tendencies) result.tendencies = measureTendencies({ ...(hands ? { hands } : {}), seed: flags.seed ?? 'g5' });
  if (flags['exploit-sim']) {
    result.exploits = measureExploits({ ...(hands ? { hands } : {}), seed: flags.seed ?? 'g6',
      ...(flags.strategy ? { strategies: String(flags.strategy).split(',') } : {}) });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
