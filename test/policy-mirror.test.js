import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyAction, createGame, legalFor, startHand } from '../engine/hand.js';
import { snapshotDecision } from '../engine/decision.js';
import { positionsOf } from '../engine/positions.js';
import { newDeck } from '../engine/cards.js';
import { scanModule } from './helpers/module-scan.mjs';
import { mulberry32 } from './helpers/fixtures.js';
import { simulateTable } from './helpers/policy-table-sim.js';
import { sizingFixture } from './helpers/sizing-fixture.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { configDigestOf } from '../training/policies/contracts.js';
import { raiseToFor, roundToUnit } from '../training/policies/sizing.js';
import { estimatePublicStrength } from '../training/policies/hand-strength.js';
import {
  DERIVED_POLICY_FAMILIES,
  POLICIES,
  VERSION_V2,
  buildMirrorConfig,
  isStrategyMirror,
  resolveStoredPolicy,
  sanitizePlayersForReview,
} from '../training/policies/catalog.js';
import * as strategyV2 from '../training/policies/strategy-v2.js';
import {
  checkedToDistribution,
  distributionV2,
  facingDistribution,
  unopenedDistribution,
  unopenedPreflop,
} from '../training/policies/strategy-v2.js';
import {
  PREFLOP_STRENGTH_QUANTILES,
  distributionMirror,
  mirrorRaiseTo,
  quantileStrength,
} from '../training/policies/strategy-mirror.js';
import { toOpponentModel } from '../training/exploit/policy-model.js';
import {
  ENGINE_POSITION_LABELS,
  HAND_CLASSES,
  POSITIONAL_SEATS,
  TENDENCY_MIN_HANDS,
  TENDENCY_MIN_N,
  emptyTendency,
  medianOf,
  normalizePosition,
  rateOf,
} from '../training/tendency/contracts.js';
import { tendencyFromRecords } from '../training/tendency/extract.js';
import { traitsFromTendency } from '../training/tendency/traits.js';
import { decide, distributionFor } from '../tools/policy-player.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools/tendency-cli.js');
const REASON_RE = /^(mirror-(?:open|limp|3bet|call|fold|check|bet)|mirror-v2-(?:open|facing|bet|check))(?::(?:observed|rule))?$/;
const ARCHETYPES = Object.freeze([
  'nit-v2', 'tag-v2', 'lag-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2',
]);
const CALIBRATION_HANDS = 300;

function comboWeight(handClass) {
  if (handClass.length === 2) return 6;
  if (handClass[2] === 's') return 4;
  return 12;
}

function holeCardsFromClass(handClass) {
  if (handClass.length === 2) return [`${handClass[0]}h`, `${handClass[1]}d`];
  if (handClass[2] === 's') return [`${handClass[0]}h`, `${handClass[1]}h`];
  return [`${handClass[0]}h`, `${handClass[1]}d`];
}

function liveSeats(n) {
  return Array.from({ length: n }, (_, index) => ({ playerId: index === 0 ? 'user' : `p${index}`, out: false }));
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    actorId: 'user',
    street: 'preflop',
    holeCards: ['Ah', 'Kd'],
    board: [],
    blinds: [50, 100],
    position: 'BTN',
    potBefore: 150,
    actorBet: 0,
    currentBet: 100,
    toCall: 100,
    effectiveStack: 10_000,
    priorActions: [
      { playerId: 'p3', action: 'fold' },
      { playerId: 'p4', action: 'fold' },
      { playerId: 'p5', action: 'fold' },
    ],
    publicSeats: liveSeats(6),
    ...overrides,
  };
}

const openLegal = {
  canCheck: false, canRaise: true, callAmount: 100, minRaiseTo: 200, maxRaiseTo: 10_000,
};
const defenseLegal = {
  canCheck: false, canRaise: true, callAmount: 200, minRaiseTo: 400, maxRaiseTo: 10_000,
};
const facingLegal = {
  canCheck: false, canRaise: true, callAmount: 500, minRaiseTo: 1_000, maxRaiseTo: 10_000,
};
const checkLegal = {
  canCheck: true, canRaise: true, callAmount: 0, minRaiseTo: 50, maxRaiseTo: 10_000,
};

function facingOpen(holeCards, overrides = {}) {
  return snapshot({
    actorId: 'p1',
    position: 'SB',
    holeCards,
    potBefore: 400,
    actorBet: 50,
    currentBet: 250,
    toCall: 200,
    priorActions: [
      { playerId: 'p3', action: 'fold' },
      { playerId: 'p4', action: 'fold' },
      { playerId: 'p5', action: 'fold' },
      { playerId: 'user', action: 'raise', amount: 250 },
    ],
    ...overrides,
  });
}

function fatTendency(overrides = {}) {
  const t = emptyTendency('user');
  t.hands = 80;
  t.decisions = 200;
  t.preflop.vpip = { n: 80, k: 32 };
  t.preflop.pfr = { n: 80, k: 20 };
  t.preflop.limp = { n: 80, k: 8 };
  t.preflop.vsRaise = { n: 40, fold: 20, call: 12, raise: 8 };
  t.preflop.vs3Bet = { n: 16, fold: 10, call: 4, raise: 2 };
  t.preflop.openSizeBb = { n: 20, buckets: { '2.5': 10, '4.0': 10 } };
  t.preflop.threeBetMultiple = { n: 12, buckets: { '3.0': 12 } };
  for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']) {
    t.preflop.byPosition[pos].dealt = 12;
    t.preflop.byPosition[pos].vpip = { n: 12, k: 5 };
    t.preflop.byPosition[pos].rfi = { n: 20, k: 6 };
    t.preflop.byPosition[pos].limp = { n: 20, k: 2 };
    t.preflop.byPosition[pos].vsRaise = { n: 16, fold: 8, call: 5, raise: 3 };
  }
  t.preflop.byPosition.BTN.rfi = { n: 40, k: 12 };
  t.preflop.byPosition.BTN.limp = { n: 40, k: 4 };
  t.preflop.byPosition.SB.rfi = { n: 40, k: 12 };
  t.preflop.byPosition.SB.limp = { n: 40, k: 4 };
  t.postflop.byStreet.flop.facingBet = { n: 20, fold: 8, call: 8, raise: 4 };
  t.postflop.byStreet.flop.checkedTo = { n: 16, check: 10, bet: 6 };
  t.postflop.byStreet.flop.betSizePot = { n: 12, buckets: { '0.5': 12 } };
  t.postflop.af = { bets: 12, raises: 8, calls: 10 };
  t.postflop.bluff = { n: 10, k: 2 };
  t.postflop.cbet = { n: 12, k: 7 };
  t.postflop.wtsd = { n: 20, k: 8 };
  Object.assign(t, overrides);
  return t;
}

function mirrorConfig(tendency = fatTendency(), source = {
  hands: tendency.hands,
  decisions: tendency.decisions,
  sessions: 1,
  extractedAt: '2026-09-08T00:00:00.000Z',
}) {
  return buildMirrorConfig(tendency, { source, strategyVersion: VERSION_V2 });
}

function triple(config) {
  return {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
  };
}

function probability(items, action) {
  return items.filter((item) => item.action === action).reduce((sum, item) => sum + item.frequency, 0);
}

function assertReasonCodes(items) {
  for (const item of items) {
    assert.match(item.reasonCode, REASON_RE, item.reasonCode);
    if (item.action === 'raise') {
      assert.match(item.reasonCode, /:(?:observed|rule)$/, item.reasonCode);
    } else {
      assert.equal(/:(?:observed|rule)$/.test(item.reasonCode), false, item.reasonCode);
    }
  }
}

function preflopSubvector(t) {
  const rows = [
    ['vpip', t.preflop.vpip.n, rateOf(t.preflop.vpip)],
    ['pfr', t.preflop.pfr.n, rateOf(t.preflop.pfr)],
    ['limp', t.preflop.limp.n, rateOf(t.preflop.limp)],
    ['threeBet', t.preflop.vsRaise.n, t.preflop.vsRaise.n ? t.preflop.vsRaise.raise / t.preflop.vsRaise.n : null],
  ];
  for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
    rows.push([`rfi_${pos}`, t.preflop.byPosition[pos].rfi.n, rateOf(t.preflop.byPosition[pos].rfi)]);
  }
  return rows.filter(([, n]) => n >= TENDENCY_MIN_N).map(([name, n, value]) => ({ name, n, value }));
}

function distanceOn(left, right) {
  const names = new Set(left.map((row) => row.name));
  const shared = right.filter((row) => names.has(row.name));
  if (shared.length === 0) return Infinity;
  const rightBy = Object.fromEntries(right.map((row) => [row.name, row.value]));
  let sum = 0;
  let count = 0;
  for (const row of left) {
    if (!Object.hasOwn(rightBy, row.name) || row.value == null || rightBy[row.name] == null) continue;
    const delta = row.value - rightBy[row.name];
    sum += delta * delta;
    count += 1;
  }
  return count === 0 ? Infinity : Math.sqrt(sum / count);
}

function fullVector(t) {
  const facingN = ['flop', 'turn', 'river'].reduce((sum, street) => sum + t.postflop.byStreet[street].facingBet.n, 0);
  const facingCall = ['flop', 'turn', 'river'].reduce((sum, street) => sum + t.postflop.byStreet[street].facingBet.call, 0);
  const facingFold = ['flop', 'turn', 'river'].reduce((sum, street) => sum + t.postflop.byStreet[street].facingBet.fold, 0);
  const facingRaise = ['flop', 'turn', 'river'].reduce((sum, street) => sum + t.postflop.byStreet[street].facingBet.raise, 0);
  const afN = t.postflop.af.bets + t.postflop.af.raises + t.postflop.af.calls;
  const af = afN ? (t.postflop.af.bets + t.postflop.af.raises) / Math.max(1, t.postflop.af.calls) : null;
  const betN = ['flop', 'turn', 'river'].reduce((sum, street) => sum + t.postflop.byStreet[street].betSizePot.n, 0);
  const betBuckets = {};
  for (const street of ['flop', 'turn', 'river']) {
    for (const [key, count] of Object.entries(t.postflop.byStreet[street].betSizePot.buckets)) {
      betBuckets[key] = (betBuckets[key] ?? 0) + count;
    }
  }
  return {
    vpip: rateOf(t.preflop.vpip),
    pfr: rateOf(t.preflop.pfr),
    limp: rateOf(t.preflop.limp),
    threeBet: t.preflop.vsRaise.n ? t.preflop.vsRaise.raise / t.preflop.vsRaise.n : null,
    foldVsBet: facingN ? facingFold / facingN : null,
    callVsBet: facingN ? facingCall / facingN : null,
    raiseVsBet: facingN ? facingRaise / facingN : null,
    cbet: rateOf(t.postflop.cbet),
    wtsd: rateOf(t.postflop.wtsd),
    afCap: af == null ? null : Math.min(1, af / 3),
    openSize: medianOf(t.preflop.openSizeBb.buckets) == null ? null : medianOf(t.preflop.openSizeBb.buckets) / 5,
    betSize: betN ? medianOf(betBuckets) : null,
  };
}

function randomLegal(la, rng) {
  const options = [
    { weight: 0.2, pick: () => ['fold'] },
    { weight: 0.5, pick: () => [la.canCheck ? 'check' : 'call'] },
  ];
  if (la.canRaise) {
    options.push({
      weight: 0.3,
      pick: () => {
        const amount = la.minRaiseTo > la.maxRaiseTo
          ? la.maxRaiseTo
          : la.minRaiseTo + Math.floor(rng() * (la.maxRaiseTo - la.minRaiseTo + 1));
        return ['raise', amount];
      },
    });
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.pick();
  }
  return options.at(-1).pick();
}

test('self-mirror family is registered with literal 1.0.0 and strategy-mirror-v1 base', () => {
  const family = DERIVED_POLICY_FAMILIES['self-mirror-v1'];
  assert.equal(family.policyVersion, '1.0.0');
  assert.equal(family.base, 'strategy-mirror-v1');
  assert.equal(typeof family.validateParams, 'function');
  assert.equal(isStrategyMirror({ base: 'strategy-mirror-v1' }), true);
  assert.equal(isStrategyMirror(POLICIES['tag-v2']), false);
});

test('buildMirrorConfig rejects short samples and binds digest to tendency cells', () => {
  const short = fatTendency();
  short.hands = 59;
  const shortConfig = buildMirrorConfig(short, {
    source: { hands: 59, decisions: 10, sessions: 1, extractedAt: '2026-09-08T00:00:00.000Z' },
    strategyVersion: VERSION_V2,
  });
  assert.equal(DERIVED_POLICY_FAMILIES['self-mirror-v1'].validateParams(shortConfig), false);
  assert.throws(
    () => resolveStoredPolicy(triple(shortConfig), { derived: { [shortConfig.configDigest]: shortConfig } }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );

  const a = fatTendency();
  const b = fatTendency();
  b.preflop.vpip = { n: 80, k: 33 };
  const left = mirrorConfig(a);
  const right = mirrorConfig(b);
  assert.notEqual(left.configDigest, right.configDigest);
  assert.equal(left.params.strategyVersion, VERSION_V2);
  assert.equal(left.params.evidence, 'derived-from-user-observed-action-frequencies-heuristic');
  assert.equal(left.policyId, 'self-mirror-v1');
  assert.equal(left.base, 'strategy-mirror-v1');
  assert.equal(configDigestOf(left), left.configDigest);
  assert.equal(DERIVED_POLICY_FAMILIES['self-mirror-v1'].validateParams(left), true);
  const resolved = resolveStoredPolicy(triple(left), { derived: { [left.configDigest]: left } });
  assert.equal(resolved.config.policyId, 'self-mirror-v1');
  assert.equal(resolved.rolledForwardFrom, null);
});

test('quantile table keys match positionsOf over 2-9 seats, are monotone, and weigh 1326 combos', () => {
  const induced = new Set();
  for (let n = 2; n <= 9; n += 1) {
    const seats = Array.from({ length: n }, (_, i) => ({ playerId: `p${i}`, out: false }));
    for (let button = 0; button < n; button += 1) {
      for (const label of Object.values(positionsOf({ seats, button }))) induced.add(label);
    }
  }
  assert.equal(induced.has('HJ'), false);
  assert.deepEqual([...induced].sort(), [...ENGINE_POSITION_LABELS].sort());
  assert.deepEqual(Object.keys(PREFLOP_STRENGTH_QUANTILES).sort(), [...induced].sort());

  for (const label of ENGINE_POSITION_LABELS) {
    const rows = PREFLOP_STRENGTH_QUANTILES[label];
    const weight = rows.reduce((sum, row) => sum + row.weight, 0);
    assert.equal(weight, 1326, label);
    const points = [0, 0.1, 0.3, 0.5, 0.7, 1];
    const values = points.map((p) => quantileStrength(label, p));
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i] <= values[i - 1] + 1e-12, `${label} Q(${points[i]}) > Q(${points[i - 1]})`);
    }
    assert.ok(quantileStrength(label, 0) >= quantileStrength(label, 1));
  }
  assert.equal(quantileStrength('HJ', 0.3), null);
  assert.equal(quantileStrength('unknown', 0.2), null);
  assert.ok(quantileStrength('BTN', 0.3) > quantileStrength('UTG', 0.3));
  assert.equal(quantileStrength('UTG+2', 0.4), quantileStrength('UTG', 0.4));
  assert.equal(HAND_CLASSES.length, 169);
});

test('unopened rfi 0.30 limp 0.10 combo-weighted participation is 0.40 ± 0.03 at BTN and SB', () => {
  const t = fatTendency();
  t.preflop.byPosition.BTN.rfi = { n: 100, k: 30 };
  t.preflop.byPosition.BTN.limp = { n: 100, k: 10 };
  t.preflop.byPosition.SB.rfi = { n: 100, k: 30 };
  t.preflop.byPosition.SB.limp = { n: 100, k: 10 };
  const config = mirrorConfig(t);
  const sbLegal = { canCheck: false, canRaise: true, callAmount: 50, minRaiseTo: 150, maxRaiseTo: 10_000 };
  for (const [position, legal, extra] of [
    ['BTN', openLegal, { actorBet: 0, toCall: 100, currentBet: 100, potBefore: 150 }],
    ['SB', sbLegal, {
      actorBet: 50,
      toCall: 50,
      currentBet: 100,
      potBefore: 150,
      priorActions: [
        { playerId: 'p3', action: 'fold' },
        { playerId: 'p4', action: 'fold' },
        { playerId: 'p5', action: 'fold' },
        { playerId: 'p6', action: 'fold' },
      ],
    }],
  ]) {
    let weighted = 0;
    let weight = 0;
    for (const handClass of HAND_CLASSES) {
      const w = comboWeight(handClass);
      const items = distributionMirror(snapshot({
        position,
        holeCards: holeCardsFromClass(handClass),
        ...extra,
      }), legal, config);
      weighted += w * (1 - probability(items, 'fold'));
      weight += w;
    }
    const participation = weighted / weight;
    assert.ok(Math.abs(participation - 0.40) <= 0.03, `${position} participation=${participation}`);
  }
});

test('n < MIN_N uses mirror-v2- reasonCode prefix', () => {
  const t = emptyTendency('user');
  t.hands = 80;
  const config = mirrorConfig(t);
  const items = distributionMirror(snapshot(), openLegal, config);
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.reasonCode.startsWith('mirror-v2-')));
  assertReasonCodes(items);
});

test('distributionMirror is deterministic, ignores hidden state, and stays legal', () => {
  const config = mirrorConfig();
  const prepared = [
    { snapshot: snapshot(), legal: openLegal },
    { snapshot: facingOpen(['Ah', 'Qd']), legal: defenseLegal },
    { snapshot: snapshot({ street: 'river', holeCards: ['Th', '9d'], board: ['Ah', 'Kh', 'Qh', 'Jh', '2c'], potBefore: 1000, currentBet: 500, toCall: 500, actorBet: 0, priorActions: [] }), legal: facingLegal },
    { snapshot: snapshot({ street: 'flop', holeCards: ['Ah', 'Qh'], board: ['Jh', '7c', '2d'], potBefore: 300, currentBet: 0, toCall: 0, actorBet: 0, priorActions: [{ action: 'raise', amount: 250 }] }), legal: checkLegal },
  ];
  for (const { snapshot: input, legal } of prepared) {
    for (let seed = 0; seed < 40; seed += 1) {
      const items = distributionMirror(input, legal, config);
      assert.equal(JSON.stringify(distributionMirror(input, legal, config)), JSON.stringify(items));
      const hidden = distributionMirror({
        ...input,
        deck: ['As', 'Ac'],
        opponentHoleCards: [['Ks', 'Kc']],
        hidden: { futureBoard: ['Th', 'Kh'] },
      }, legal, config);
      assert.equal(JSON.stringify(hidden), JSON.stringify(items));
      const total = items.reduce((sum, item) => sum + item.frequency, 0);
      assert.ok(Math.abs(total - 1) < 1e-12);
      for (const item of items) {
        if (item.action === 'check') assert.equal(legal.canCheck, true);
        if (item.action === 'fold') assert.equal(legal.canCheck, false);
        if (item.action === 'call') {
          assert.equal(legal.canCheck, false);
          assert.ok(legal.callAmount > 0);
          assert.equal(item.amount, legal.callAmount);
        }
        if (item.action === 'raise') {
          assert.equal(legal.canRaise, true);
          if (legal.minRaiseTo > legal.maxRaiseTo) assert.equal(item.amount, legal.maxRaiseTo);
          else {
            assert.ok(item.amount >= legal.minRaiseTo);
            assert.ok(item.amount <= legal.maxRaiseTo);
          }
        }
      }
      assertReasonCodes(items);
      const decided = decide({
        snapshot: { ...input, decisionId: `${input.decisionId}-${seed}` },
        legal,
        policy: triple(config),
        policySeed: `mirror-seed-${seed}`,
        gameEpoch: 'cd'.repeat(32),
        derived: { [config.configDigest]: config },
      });
      const again = decide({
        snapshot: {
          ...input,
          decisionId: `${input.decisionId}-${seed}`,
          deck: ['As', 'Ac'],
          opponentHoleCards: [['Ks', 'Kc']],
          hidden: { futureBoard: ['Th', 'Kh'] },
        },
        legal,
        policy: triple(config),
        policySeed: `mirror-seed-${seed}`,
        gameEpoch: 'cd'.repeat(32),
        derived: { [config.configDigest]: config },
      });
      assert.equal(JSON.stringify(decided), JSON.stringify(again));
    }
  }
});

test('strategy-v2 import pin stays #143 and distributionV2 body is unmodified besides exports', () => {
  const source = fs.readFileSync(path.join(ROOT, 'training/policies/strategy-v2.js'), 'utf8');
  const scan = scanModule(source);
  assert.deepEqual(scan.imports.map((entry) => entry.specifier).sort(), [
    './contracts.js', './hand-strength.js', './sizing.js',
  ]);
  assert.equal(typeof unopenedPreflop, 'function');
  assert.equal(typeof facingDistribution, 'function');
  assert.equal(typeof unopenedDistribution, 'function');
  assert.equal(typeof checkedToDistribution, 'function');
  assert.equal('singleOpenPreflop' in strategyV2, false);
  assert.equal(source.includes('function regimeOf'), false);
  assert.match(source, /export function unopenedPreflop/);
  assert.match(source, /export function facingDistribution/);
  assert.match(source, /export function unopenedDistribution/);
  assert.match(source, /export function checkedToDistribution/);
  const body = source.slice(source.indexOf('export function distributionV2'));
  assert.match(body, /if \(unopenedPreflop\(snapshot\)\)/);
  assert.match(body, /else if \(!legal\?\.canCheck && legal\?\.callAmount > 0\)/);
  assert.match(body, /proposed = checkedToDistribution\(traits, strength, sized\)/);
  assert.equal(body.includes('distributionMirror'), false);
  assert.equal(body.includes('traitsFromTendency'), false);
});

test('observed sizing uses user medians, rounds by SB, clamps, and falls back to raiseToFor', () => {
  const t = fatTendency();
  t.preflop.openSizeBb = { n: 10, buckets: { '4.0': 10 } };
  t.preflop.threeBetMultiple = { n: 10, buckets: { '3.0': 10 } };
  t.postflop.byStreet.flop.betSizePot = { n: 10, buckets: { '0.5': 10 } };
  const config = mirrorConfig(t);

  const open = sizingFixture({ blinds: [25, 50], actions: [] });
  const openSized = mirrorRaiseTo(open.snapshot, open.legal, t);
  assert.equal(openSized.raiseTo, 200);
  assert.equal(openSized.observed, true);
  const openItems = distributionMirror({ ...open.snapshot, holeCards: ['Ah', 'Kd'] }, open.legal, config);
  const openRaise = openItems.find((item) => item.action === 'raise');
  assert.equal(openRaise.amount, 200);
  assert.match(openRaise.reasonCode, /:observed$/);

  const three = sizingFixture({ blinds: [25, 50], actions: [['raise', 125]] });
  const threeSized = mirrorRaiseTo(three.snapshot, three.legal, t);
  assert.equal(threeSized.raiseTo, 375);
  const threeItems = distributionMirror({ ...three.snapshot, holeCards: ['Ah', 'Ad'] }, three.legal, config);
  assert.equal(threeItems.find((item) => item.action === 'raise').amount, 375);

  const flopSnap = snapshot({
    street: 'flop',
    holeCards: ['Ah', 'Qh'],
    board: ['Jh', '7c', '2d'],
    blinds: [25, 50],
    potBefore: 300,
    currentBet: 0,
    toCall: 0,
    actorBet: 0,
    priorActions: [{ playerId: 'p3', action: 'raise', amount: 125 }],
  });
  const flopLegal = { canCheck: true, canRaise: true, callAmount: 0, minRaiseTo: 50, maxRaiseTo: 5000 };
  const flopSized = mirrorRaiseTo(flopSnap, flopLegal, t);
  assert.equal(flopSized.raiseTo, 150);
  const flopItems = distributionMirror(flopSnap, flopLegal, config);
  assert.equal(flopItems.find((item) => item.action === 'raise').amount, 150);

  const roundedTarget = 4.3 * 50;
  const rounded = fatTendency();
  rounded.preflop.openSizeBb = { n: 10, buckets: { '4.3': 10 } };
  const roundSnap = { ...open.snapshot, blinds: [25, 50] };
  const roundSized = mirrorRaiseTo(roundSnap, open.legal, rounded);
  assert.equal(roundSized.raiseTo, roundToUnit(roundedTarget, 25));

  const short = emptyTendency('user');
  short.hands = 80;
  const fallback = raiseToFor(open.snapshot, open.legal);
  const shortSized = mirrorRaiseTo(open.snapshot, open.legal, short);
  assert.equal(shortSized.raiseTo, fallback.raiseTo);
  assert.equal(shortSized.target, fallback.target);
  assert.equal(shortSized.rule, fallback.rule);
  assert.equal(shortSized.observed, false);
});

test('raise amount equals minRaiseTo only when the rounded target is at or below minRaiseTo', () => {
  const config = mirrorConfig();
  const rng = mulberry32(99);
  let seen = 0;
  let state = createGame({
    aiCount: 5, startStack: 5000, blinds0: [25, 50],
    mode: 'cash-training', levelEvery: null, startStackBb: 100, handLimit: 80,
  });
  state.button = 5;
  while (seen < 300 && !state.gameOver) {
    state = startHand(state, { rng }).state;
    if (!state.hand) break;
    while (!legalFor(state).handOver && seen < 300) {
      const legal = legalFor(state);
      const snap = snapshotDecision(state, legal.toAct, null, { blinds: state.config.blinds0, legal });
      if (legal.canRaise) {
        const items = distributionMirror(snap, legal, config);
        const sized = mirrorRaiseTo(snap, legal, config.params.tendency);
        const rounded = roundToUnit(sized.target, snap.blinds[0]);
        for (const item of items.filter((row) => row.action === 'raise')) {
          if (item.amount === legal.minRaiseTo) {
            assert.ok(rounded <= legal.minRaiseTo || legal.minRaiseTo > legal.maxRaiseTo);
          }
        }
        seen += 1;
      }
      const [action, amount] = randomLegal(legal, rng);
      state = applyAction(state, legal.toAct, action, amount).state;
    }
  }
  assert.ok(seen >= 300, `only ${seen} raise spots`);
});

test('6-max UTG+1 and 7-max UTG+2 share table-build strength and take the observed path', () => {
  const t = fatTendency();
  t.preflop.byPosition.HJ.rfi = { n: 40, k: 12 };
  t.preflop.byPosition.HJ.limp = { n: 40, k: 4 };
  t.preflop.byPosition.UTG.rfi = { n: 40, k: 10 };
  t.preflop.byPosition.UTG.limp = { n: 40, k: 2 };
  const config = mirrorConfig(t);
  const handClass = 'AKo';
  const holeCards = holeCardsFromClass(handClass);

  function unopenedAt(aiCount, actorFromButton) {
    let state = createGame({
      aiCount, startStack: 5000, blinds0: [25, 50],
      mode: 'cash-training', levelEvery: null, startStackBb: 100, handLimit: 20,
    });
    state.button = aiCount;
    state = startHand(state, { deck: newDeck() }).state;
    const pos = positionsOf(state);
    const order = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'UTG+3', 'UTG+4', 'CO'];
    const wanted = Object.entries(pos).find(([, label]) => order.indexOf(label) === actorFromButton)?.[0];
    const actor = wanted;
    while (legalFor(state).toAct !== actor) {
      const legal = legalFor(state);
      if (legal.handOver) throw new Error('hand over before actor');
      state = applyAction(state, legal.toAct, 'fold').state;
    }
    const legal = legalFor(state);
    const snap = snapshotDecision(state, actor, null, { blinds: state.config.blinds0, legal });
    snap.holeCards = holeCards;
    return { snapshot: snap, legal };
  }

  const six = unopenedAt(5, 4);
  const seven = unopenedAt(6, 5);
  assert.equal(six.snapshot.position, 'UTG+1');
  assert.equal(seven.snapshot.position, 'UTG+2');
  assert.equal(
    estimatePublicStrength({ street: 'preflop', holeCards, position: 'UTG+1' }),
    estimatePublicStrength(six.snapshot),
  );
  assert.equal(
    estimatePublicStrength({ street: 'preflop', holeCards, position: 'UTG+2' }),
    estimatePublicStrength(seven.snapshot),
  );
  const sixItems = distributionMirror(six.snapshot, six.legal, config);
  const sevenItems = distributionMirror(seven.snapshot, seven.legal, config);
  assert.ok(sixItems.every((item) => !item.reasonCode.startsWith('mirror-v2-')));
  assert.ok(sevenItems.every((item) => !item.reasonCode.startsWith('mirror-v2-')));
  assert.ok(sixItems.some((item) => item.action === 'raise' && /:observed$/.test(item.reasonCode)));
  assert.ok(sevenItems.some((item) => item.action === 'raise' && /:observed$/.test(item.reasonCode)));
});

test('SB unopened limp is call, synthetic canCheck limp is check, and renormalize does not inflate raise', () => {
  const t = fatTendency();
  t.preflop.byPosition.SB.rfi = { n: 80, k: 8 };
  t.preflop.byPosition.SB.limp = { n: 80, k: 40 };
  const config = mirrorConfig(t);
  const sbSnap = snapshot({
    position: 'SB',
    actorBet: 50,
    toCall: 50,
    currentBet: 100,
    potBefore: 150,
    holeCards: ['7h', '6h'],
    priorActions: [
      { playerId: 'p3', action: 'fold' },
      { playerId: 'p4', action: 'fold' },
      { playerId: 'p5', action: 'fold' },
      { playerId: 'p6', action: 'fold' },
    ],
  });
  const sbLegal = { canCheck: false, canRaise: true, callAmount: 50, minRaiseTo: 150, maxRaiseTo: 10_000 };
  const sbItems = distributionMirror(sbSnap, sbLegal, config);
  assert.ok(sbItems.some((item) => item.action === 'call' && item.reasonCode === 'mirror-limp'));
  assert.equal(sbItems.some((item) => item.action === 'check'), false);
  const raiseFreq = probability(sbItems, 'raise');

  const checkItems = distributionMirror(sbSnap, { ...sbLegal, canCheck: true, callAmount: 0 }, config);
  assert.ok(checkItems.some((item) => item.action === 'check' && item.reasonCode === 'mirror-limp'));
  assert.equal(checkItems.some((item) => item.action === 'call'), false);
  assert.ok(probability(checkItems, 'raise') <= raiseFreq + 1e-12);
});

test('regime choice matches v2 observation of check vs fold on 300 non-unopened engine states', () => {
  const config = mirrorConfig();
  const v2 = POLICIES['baseline-v2'];
  const rng = mulberry32(7);
  const collected = [];
  let state = createGame({
    aiCount: 5, startStack: 5000, blinds0: [25, 50],
    mode: 'cash-training', levelEvery: null, startStackBb: 100, handLimit: 120,
  });
  state.button = 2;
  while (collected.length < 300 && !state.gameOver) {
    state = startHand(state, { rng }).state;
    if (!state.hand) break;
    while (!legalFor(state).handOver && collected.length < 300) {
      const legal = legalFor(state);
      const snap = snapshotDecision(state, legal.toAct, null, { blinds: state.config.blinds0, legal });
      if (!unopenedPreflop(snap)) collected.push({ snapshot: snap, legal });
      const [action, amount] = randomLegal(legal, rng);
      state = applyAction(state, legal.toAct, action, amount).state;
    }
  }
  assert.equal(collected.length, 300);
  for (const { snapshot: snap, legal } of collected) {
    const v2Items = distributionV2(snap, legal, v2);
    const mirrorItems = distributionMirror(snap, legal, config);
    const v2HasCheck = v2Items.some((item) => item.action === 'check');
    const v2HasFold = v2Items.some((item) => item.action === 'fold');
    if (v2HasCheck) {
      assert.ok(
        mirrorItems.some((item) => item.action === 'check')
          || mirrorItems.some((item) => /^mirror-v2-(?:check|bet)/.test(item.reasonCode)),
        JSON.stringify(mirrorItems.map((item) => item.reasonCode)),
      );
    }
    if (v2HasFold) {
      assert.ok(
        mirrorItems.some((item) => item.action === 'fold')
          || mirrorItems.some((item) => item.reasonCode.startsWith('mirror-v2-facing') || /^mirror-(?:fold|call|3bet)/.test(item.reasonCode)),
        JSON.stringify(mirrorItems.map((item) => item.reasonCode)),
      );
    }
  }
});

test('heads-up 4-max 8-max skip positional unopened; 5/6/7-max normalize to UTG/CO chains', () => {
  const pooled = fatTendency();
  const config = mirrorConfig(pooled);
  const unopened = snapshot({ publicSeats: liveSeats(2), position: 'BTN/SB' });
  const unopenedItems = distributionMirror(unopened, openLegal, config);
  assert.ok(unopenedItems.every((item) => item.reasonCode.startsWith('mirror-v2-open')));

  for (const n of [4, 8]) {
    const items = distributionMirror(snapshot({ publicSeats: liveSeats(n), position: n === 4 ? 'CO' : 'UTG+3' }), openLegal, config);
    assert.ok(items.every((item) => item.reasonCode.startsWith('mirror-v2-open')), `${n}-max`);
  }

  const single = facingOpen(['Ah', 'Qd'], { publicSeats: liveSeats(2), position: 'BB' });
  const pooledItems = distributionMirror(single, defenseLegal, config);
  assert.ok(pooledItems.every((item) => !item.reasonCode.startsWith('mirror-v2-')), JSON.stringify(pooledItems.map((i) => i.reasonCode)));

  const thin = emptyTendency('user');
  thin.hands = 80;
  const thinConfig = mirrorConfig(thin);
  const thinItems = distributionMirror(single, defenseLegal, thinConfig);
  assert.ok(thinItems.every((item) => item.reasonCode.startsWith('mirror-v2-facing')));

  const five = ['BTN', 'SB', 'BB', 'UTG', 'CO'].map((label) => normalizePosition(label, 5));
  const six = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'CO'].map((label) => normalizePosition(label, 6));
  const seven = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'CO'].map((label) => normalizePosition(label, 7));
  assert.deepEqual(five.filter((label) => label === 'UTG' || label === 'CO' || label === 'HJ'), ['UTG', 'CO']);
  assert.deepEqual(six.filter((label) => label === 'UTG' || label === 'CO' || label === 'HJ'), ['UTG', 'HJ', 'CO']);
  assert.deepEqual(seven.filter((label) => label === 'UTG' || label === 'CO' || label === 'HJ'), ['UTG', 'UTG', 'HJ', 'CO']);
  assert.deepEqual(POSITIONAL_SEATS, [5, 6, 7]);
});

test('distributionMirror does not call traitsOf; mismatched base still fails distributionV2', () => {
  const config = mirrorConfig();
  assert.doesNotThrow(() => distributionMirror(snapshot(), openLegal, config));
  assert.throws(
    () => distributionV2(snapshot(), openLegal, config),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );
  const items = distributionFor(snapshot(), openLegal, triple(config), { derived: { [config.configDigest]: config } });
  assert.ok(items.every((item) => item.reasonCode.startsWith('mirror-')));
});

test('sanitize and toOpponentModel branch mirror vs exploiter modelKind', () => {
  const config = mirrorConfig();
  const players = [{
    playerId: 'p1', seat: 1, name: 'A', agentHandle: 'player-p1',
    speech: 'hi', personality: 'calm', archetype: 'SelfMirror', policy: triple(config),
  }];
  const post = sanitizePlayersForReview(players, { gameOver: true, derived: { [config.configDigest]: config } });
  assert.equal(post[0].policyModelKind, 'observed-tendency-mirror-v1');
  assert.equal(post[0].selfOpponent.role, 'mirror');
  assert.equal(post[0].policyTraitsEvidence, 'derived-from-user-observed-action-frequencies-heuristic');
  const model = toOpponentModel(triple(config), { derived: { [config.configDigest]: config } });
  assert.equal(model.modelKind, 'observed-tendency-mirror-v1');
  assert.equal(model.modelKnowledge, 'derived-from-user-observed-action-frequencies-heuristic');
});

test('tendency-cli show reports projected traits and whether a replica can be built', () => {
  const storeDir = createOwnedTempDir('holdem-mirror-cli');
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(sessionDir, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    gameOver: true,
    seats: Array.from({ length: 6 }, (_, i) => ({ playerId: i === 0 ? 'user' : `p${i}`, stack: 5000, out: false })),
    config: { mode: 'cash-training', aiCount: 5 },
    policySeed: 'ab'.repeat(32),
  }));
  const records = simulateTable({ seats: { user: 'tag-v2' }, hands: 8, seed: 3 });
  records.forEach((record, index) => {
    fs.writeFileSync(
      path.join(sessionDir, 'hands', `hand-${String(index + 1).padStart(4, '0')}.json`),
      `${JSON.stringify(record)}\n`,
    );
  });
  const text = spawnSync(process.execPath, [CLI, 'show', '--store-dir', storeDir], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /복제 가능 여부/);
  assert.match(text.stdout, /tightness|타이트니스|트레이트/);
  const json = spawnSync(process.execPath, [CLI, 'show', '--store-dir', storeDir, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal('traits' in payload, false);
  assert.equal(typeof payload.traitProjection, 'object');
  assert.equal(typeof payload.mirrorEligible, 'boolean');
});

test('catalog v2 tightness order round-trips through 6-max sims', (t) => {
  const started = Date.now();
  const subjects = {
    'nit-v2': POLICIES['nit-v2'].traits.tightness,
    'tag-v2': POLICIES['tag-v2'].traits.tightness,
    'baseline-v2': POLICIES['baseline-v2'].traits.tightness,
    'lag-v2': POLICIES['lag-v2'].traits.tightness,
    'maniac-v2': POLICIES['maniac-v2'].traits.tightness,
    'calling-station-v2': POLICIES['calling-station-v2'].traits.tightness,
    'trickster-v2': POLICIES['trickster-v2'].traits.tightness,
  };
  const projected = {};
  const sources = {};
  for (const [id, configured] of Object.entries(subjects)) {
    const records = simulateTable({ seats: { p1: id }, hands: CALIBRATION_HANDS, seed: 17 });
    const tendency = tendencyFromRecords(records, 'p1');
    const traits = traitsFromTendency(tendency);
    projected[id] = traits.tightness;
    sources[id] = tendency;
    const tol = id === 'calling-station-v2' || id === 'trickster-v2' ? 0.15 : 0.12;
    assert.ok(
      Math.abs(traits.tightness - configured) <= tol,
      `${id} tightness ${traits.tightness} vs ${configured} (vpip=${rateOf(tendency.preflop.vpip)})`,
    );
  }
  const order = ['nit-v2', 'tag-v2', 'baseline-v2', 'lag-v2', 'maniac-v2'];
  // 0.10 catalog spacing is not present in 6-max-vs-baseline VPIP (tag/baseline ΔVPIP≈0.02).
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      projected[order[i - 1]] > projected[order[i]],
      `${order[i - 1]} ${projected[order[i - 1]]} vs ${order[i]} ${projected[order[i]]}`,
    );
  }
  t.diagnostic(`tightness ${JSON.stringify(projected)} in ${Date.now() - started}ms`);

  const vectors = Object.fromEntries(ARCHETYPES.map((id) => [id, preflopSubvector(sources[id])]));
  const full = Object.fromEntries(ARCHETYPES.map((id) => [id, fullVector(sources[id])]));
  const nnLog = {};
  for (const id of ARCHETYPES) {
    const config = mirrorConfig(sources[id]);
    const replay = simulateTable({
      seats: { p1: config },
      hands: CALIBRATION_HANDS,
      seed: 40 + id.length,
      derived: { [config.configDigest]: config },
    });
    const mirrored = tendencyFromRecords(replay, 'p1');
    const vector = preflopSubvector(mirrored);
    let best = null;
    let bestDistance = Infinity;
    const distances = {};
    for (const other of ARCHETYPES) {
      const d = distanceOn(vector, vectors[other]);
      distances[other] = d;
      if (d < bestDistance) {
        bestDistance = d;
        best = other;
      }
    }
    nnLog[id] = { best, distances, full: fullVector(mirrored), sourceFull: full[id] };
    assert.equal(best, id, `${id} nearest ${best} distances=${JSON.stringify(distances)}`);
  }
  t.diagnostic(`nearest-neighbor ${JSON.stringify(nnLog)}`);
  t.diagnostic(`calibration wall ${Date.now() - started}ms hands=${CALIBRATION_HANDS}`);
});
