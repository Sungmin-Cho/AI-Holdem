import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectPrivateLiterals } from '../publish-contract.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { skipOnWin32 } from './helpers/platform.js';
import { evaluationIdOf } from '../training/contracts.js';
import { assertNoFakeEv } from '../training/exploit/contracts.js';
import { evaluateExploit } from '../training/exploit/evaluator.js';
import { modelsFromPlayers, toOpponentModel } from '../training/exploit/policy-model.js';
import { configDigestOf } from '../training/policies/contracts.js';
import {
  assignmentFor,
  DERIVED_POLICY_FAMILIES,
  isStrategyMirror,
  POLICIES,
  resolveExactPolicy,
  resolveStoredPolicy,
  sanitizePlayersForReview,
  SELF_ARCHETYPES,
  VERSION_V2,
} from '../training/policies/catalog.js';
import { distributionV2 } from '../training/policies/strategy-v2.js';
import { createTrainingControl } from '../tools/training-control.js';
import { sealExploitAnnotations } from '../tools/training-pipeline.js';
import {
  decide,
  readDerivedPolicyConfigs,
  stampPlayerPolicies,
  writeDerivedPolicyConfigs,
} from '../tools/policy-player.js';

const EPOCH = 'ab'.repeat(32);
const OWNER = 'owner-1';
const V2_IDS = Object.freeze([
  'baseline-v2', 'tag-v2', 'lag-v2', 'nit-v2',
  'calling-station-v2', 'maniac-v2', 'trickster-v2',
]);

function tmp(prefix = 'holdem-derived') {
  return createOwnedTempDir(prefix);
}

function exploiterConfig({
  traits = { tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12 },
  params = {
    strategyVersion: VERSION_V2,
    source: { hands: 115, decisions: 400, sessions: 1, extractedAt: '2026-09-07T00:00:00.000Z' },
    evidence: 'derived-from-user-observed-action-frequencies-heuristic',
  },
  extra = {},
} = {}) {
  const config = {
    policyId: 'self-exploiter-v1',
    policyVersion: '1.0.0',
    base: 'strategy-v2',
    traits,
    params,
    ...extra,
  };
  return { ...config, configDigest: configDigestOf(config) };
}

function triple(config, extra = {}) {
  return {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
    ...extra,
  };
}

function derivedMap(...configs) {
  return Object.fromEntries(configs.map((config) => [config.configDigest, config]));
}

function idleEngine(playerIds) {
  return {
    schemaVersion: 1,
    stateVersion: 1,
    config: { blinds0: [50, 100], levelEvery: 8 },
    sessionToken: 'tok',
    handNo: 0,
    phase: 'idle',
    seats: playerIds.map((playerId) => ({ playerId })),
    gameOver: false,
    hand: null,
    lastHand: null,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-river-0',
    street: 'river',
    holeCards: ['Th', '9d'],
    board: ['Ah', 'Kh', 'Qh', 'Jh', '2c'],
    blinds: [50, 100],
    position: 'BTN',
    potBefore: 1_000,
    actorBet: 0,
    currentBet: 500,
    toCall: 500,
    effectiveStack: 10_000,
    priorActions: [],
    publicSeats: Array.from({ length: 6 }, (_, index) => ({ playerId: `p${index}`, out: false })),
    ...overrides,
  };
}

function unopenedPreflop(holeCards, overrides = {}) {
  return snapshot({
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards,
    board: [],
    potBefore: 150,
    actorBet: 0,
    currentBet: 100,
    toCall: 100,
    minRaiseTo: 200,
    priorActions: [
      { playerId: 'p3', action: 'fold' },
      { playerId: 'p4', action: 'fold' },
      { playerId: 'p5', action: 'fold' },
    ],
    ...overrides,
  });
}

function facingOpenPreflop(holeCards, overrides = {}) {
  return snapshot({
    actorId: 'p1',
    street: 'preflop',
    position: 'SB',
    holeCards,
    board: [],
    potBefore: 400,
    actorBet: 50,
    currentBet: 250,
    toCall: 200,
    minRaiseTo: 400,
    priorActions: [
      { playerId: 'p3', action: 'fold' },
      { playerId: 'p4', action: 'fold' },
      { playerId: 'p5', action: 'fold' },
      { playerId: 'user', action: 'raise', amount: 250 },
    ],
    ...overrides,
  });
}

const facingLegal = {
  canCheck: false, canRaise: true, callAmount: 500, minRaiseTo: 1_000, maxRaiseTo: 10_000,
};
const openLegal = {
  canCheck: false, canRaise: true, callAmount: 100, minRaiseTo: 200, maxRaiseTo: 10_000,
};
const defenseLegal = {
  canCheck: false, canRaise: true, callAmount: 200, minRaiseTo: 400, maxRaiseTo: 10_000,
};

function preparedCases() {
  return [
    { snapshot: snapshot(), legal: facingLegal },
    { snapshot: snapshot({ holeCards: ['3d', '4s'] }), legal: facingLegal },
    { snapshot: unopenedPreflop(['Ah', 'Kd']), legal: openLegal },
    { snapshot: facingOpenPreflop(['Ah', 'Qd']), legal: defenseLegal },
    {
      snapshot: snapshot({ street: 'flop', holeCards: ['Ah', 'Qh'], board: ['Jh', '7c', '2d'] }),
      legal: facingLegal,
    },
  ];
}

function writePlayers(dir, players) {
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(players));
}

function annotationFiles(dir) {
  const folder = path.join(dir, 'annotations');
  try {
    return fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('U1 registers only the exploiter family at literal 1.0.0', () => {
  assert.deepEqual(Object.keys(DERIVED_POLICY_FAMILIES), ['self-exploiter-v1']);
  assert.equal(DERIVED_POLICY_FAMILIES['self-exploiter-v1'].policyVersion, '1.0.0');
  assert.notEqual(DERIVED_POLICY_FAMILIES['self-exploiter-v1'].policyVersion, VERSION_V2);
  assert.equal(DERIVED_POLICY_FAMILIES['self-exploiter-v1'].base, 'strategy-v2');
  assert.equal(typeof DERIVED_POLICY_FAMILIES['self-exploiter-v1'].validateParams, 'function');
  assert.deepEqual([...SELF_ARCHETYPES], ['SelfMirror', 'SelfExploiter']);
  assert.equal(isStrategyMirror({ base: 'strategy-mirror-v1' }), true);
  assert.equal(isStrategyMirror({ base: 'strategy-v2' }), false);
  assert.equal(isStrategyMirror(exploiterConfig()), false);
});

test('resolveStoredPolicy and resolveExactPolicy reject derived triples without a derived map', () => {
  const config = exploiterConfig();
  const stored = triple(config);
  const mirrorTriple = {
    policyId: 'self-mirror-v1',
    policyVersion: '1.0.0',
    configDigest: '00'.repeat(32),
  };
  assert.throws(() => resolveStoredPolicy(stored), { code: 'POLICY_CONFIG_MISMATCH' });
  assert.throws(() => resolveExactPolicy(stored), { code: 'POLICY_CONFIG_MISMATCH' });
  assert.throws(() => resolveStoredPolicy(mirrorTriple), { code: 'POLICY_CONFIG_MISMATCH' });
  assert.throws(() => resolveExactPolicy(mirrorTriple), { code: 'POLICY_CONFIG_MISMATCH' });
});

test('resolveStoredPolicy returns a frozen derived config when the digest matches', () => {
  const config = exploiterConfig();
  const resolved = resolveStoredPolicy(triple(config), { derived: derivedMap(config) });
  assert.equal(resolved.config.policyId, 'self-exploiter-v1');
  assert.equal(resolved.config.policyVersion, '1.0.0');
  assert.equal(resolved.config.base, 'strategy-v2');
  assert.equal(resolved.config.configDigest, config.configDigest);
  assert.equal(resolved.rolledForwardFrom, null);
  assert.equal(Object.isFrozen(resolved.config), true);
  assert.equal(Object.isFrozen(resolved.config.traits), true);
  assert.equal(Object.isFrozen(resolved.config.params), true);
  assert.throws(() => { resolved.config.traits.tightness = 0; }, TypeError);
});

test('resolveStoredPolicy fail-closes on digest mismatch, base mismatch, invalid params, and missing digest', () => {
  const config = exploiterConfig();
  const stored = triple(config);

  const tweaked = exploiterConfig({
    params: { ...config.params, evidence: `${config.params.evidence}x` },
  });
  assert.throws(
    () => resolveStoredPolicy(stored, { derived: { [config.configDigest]: tweaked } }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );

  const wrongBase = exploiterConfig({ extra: { base: 'strategy-mirror-v1' } });
  assert.throws(
    () => resolveStoredPolicy(stored, { derived: { [config.configDigest]: { ...wrongBase, configDigest: config.configDigest } } }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );

  const invalid = exploiterConfig({
    traits: { tightness: -1, aggression: 0.5, calling: 0.5, bluff: 0.5 },
  });
  assert.throws(
    () => resolveStoredPolicy(triple(invalid), { derived: derivedMap(invalid) }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );

  assert.throws(
    () => resolveStoredPolicy(stored, { derived: {} }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );
});

test('stampPlayerPolicies preserves derived seats, extra keys, and fail-closes without the digest file', () => {
  const dir = tmp();
  const config = exploiterConfig();
  writePlayers(dir, [
    { playerId: 'user' },
    { playerId: 'p1', archetype: 'SelfExploiter', policy: triple(config, { extra: 'keep' }) },
    { playerId: 'p2', archetype: 'TAG' },
  ]);
  writeDerivedPolicyConfigs(dir, derivedMap(config));

  const notices = [];
  const stamped = stampPlayerPolicies(dir, { onNotice: (message) => notices.push(message) });
  const derivedSeat = stamped.find((player) => player.playerId === 'p1');
  assert.equal(derivedSeat.policy.extra, 'keep');
  assert.deepEqual(
    {
      policyId: derivedSeat.policy.policyId,
      policyVersion: derivedSeat.policy.policyVersion,
      configDigest: derivedSeat.policy.configDigest,
    },
    triple(config),
  );
  assert.deepEqual(
    {
      policyId: stamped.find((player) => player.playerId === 'p2').policy.policyId,
      policyVersion: stamped.find((player) => player.playerId === 'p2').policy.policyVersion,
      configDigest: stamped.find((player) => player.playerId === 'p2').policy.configDigest,
    },
    assignmentFor('TAG'),
  );
  assert.deepEqual(notices, []);

  fs.unlinkSync(path.join(dir, '.policy-configs.json'));
  assert.throws(() => stampPlayerPolicies(dir), { code: 'POLICY_CONFIG_MISMATCH' });
});

test('stampPlayerPolicies rejects a SelfMirror seat that has no policy', () => {
  const dir = tmp();
  writePlayers(dir, [
    { playerId: 'user' },
    { playerId: 'p1', archetype: 'SelfMirror' },
  ]);
  assert.throws(() => stampPlayerPolicies(dir), { code: 'SELF_OPPONENT_INCOMPLETE' });
  const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  assert.equal(players.find((player) => player.playerId === 'p1').policy, undefined);
});

test('collectPrivateLiterals accepts a derived triple and puts the triple values on the deny list', () => {
  const config = exploiterConfig();
  const stored = triple(config);
  const literals = collectPrivateLiterals({
    players: [
      { playerId: 'user' },
      { playerId: 'p1', archetype: 'SelfExploiter', policy: stored },
    ],
    engineState: idleEngine(['user', 'p1']),
    records: [],
  });
  assert.ok(literals.includes(stored.policyId));
  assert.ok(literals.includes(stored.policyVersion));
  assert.ok(literals.includes(stored.configDigest));
  assert.ok(literals.includes(JSON.stringify(stored)));
});

test('static v2 decide JSON is byte-identical with a derived map present, 40 seeds × prepared snapshots', () => {
  const dummyDerived = derivedMap(exploiterConfig());
  for (const id of V2_IDS) {
    const policy = POLICIES[id];
    for (const prepared of preparedCases()) {
      for (let seed = 0; seed < 40; seed += 1) {
        const input = {
          snapshot: prepared.snapshot,
          legal: prepared.legal,
          policy,
          policySeed: `${id}-${seed}`,
          gameEpoch: 'ef'.repeat(32),
        };
        const expected = JSON.stringify(decide(input));
        assert.equal(JSON.stringify(decide({ ...input, derived: dummyDerived })), expected);
        assert.equal(JSON.stringify(decide(input)), expected);
      }
    }
  }
});

test('derived extra keep survives stamp and frozen 2.0.0 strategyVersion rolls forward without restamp', () => {
  const dir = tmp();
  const config = exploiterConfig({
    params: {
      strategyVersion: '2.0.0',
      source: { hands: 115, decisions: 400, sessions: 1, extractedAt: '2026-09-07T00:00:00.000Z' },
      evidence: 'derived-from-user-observed-action-frequencies-heuristic',
    },
  });
  writePlayers(dir, [
    { playerId: 'user' },
    { playerId: 'p1', archetype: 'SelfExploiter', policy: triple(config, { extra: 'keep' }) },
  ]);
  writeDerivedPolicyConfigs(dir, derivedMap(config));

  const resolved = resolveStoredPolicy(triple(config), { derived: derivedMap(config) });
  assert.equal(resolved.rolledForwardFrom, '2.0.0');
  assert.equal(resolved.config.params.strategyVersion, '2.0.0');

  const before = fs.readFileSync(path.join(dir, 'players.json'));
  const notices = [];
  stampPlayerPolicies(dir, { onNotice: (message) => notices.push(message) });
  assert.deepEqual(notices, [`self-opponent strategy roll-forward 2.0.0→${VERSION_V2}: p1`]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'players.json')), before);
  const after = JSON.parse(before);
  assert.equal(after[1].policy.extra, 'keep');
  assert.equal(after[1].policy.policyVersion, '1.0.0');
  assert.equal(after[1].policy.configDigest, config.configDigest);

  const second = [];
  stampPlayerPolicies(dir, { onNotice: (message) => second.push(message) });
  assert.deepEqual(second, [`self-opponent strategy roll-forward 2.0.0→${VERSION_V2}: p1`]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'players.json')), before);

  const accepted = {
    policyId: 'self-exploiter-v1',
    policyVersion: '1.0.0',
    base: 'strategy-v2',
    traits: { tightness: 0.5, aggression: 0.5, calling: 0.5, bluff: 0.5 },
  };
  assert.doesNotThrow(() => distributionV2(snapshot(), facingLegal, accepted));
  assert.throws(
    () => distributionV2(snapshot(), facingLegal, { ...accepted, base: 'x' }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );
});

test('readDerivedPolicyConfigs returns {} when missing and fail-closes on corrupt JSON', () => {
  const dir = tmp();
  assert.deepEqual(readDerivedPolicyConfigs(dir), {});

  fs.writeFileSync(path.join(dir, '.policy-configs.json'), '{');
  assert.throws(() => readDerivedPolicyConfigs(dir), { code: 'POLICY_CONFIGS_CORRUPT' });

  fs.writeFileSync(path.join(dir, '.policy-configs.json'), JSON.stringify({ schemaVersion: 2, configs: {} }));
  assert.throws(() => readDerivedPolicyConfigs(dir), { code: 'POLICY_CONFIGS_CORRUPT' });

  fs.writeFileSync(path.join(dir, '.policy-configs.json'), JSON.stringify({ schemaVersion: 1, configs: [] }));
  assert.throws(() => readDerivedPolicyConfigs(dir), { code: 'POLICY_CONFIGS_CORRUPT' });
});

test('readDerivedPolicyConfigs rejects a symlink at the digest file', (t) => {
  if (skipOnWin32(t, 'symlink fixtures require POSIX privilege semantics')) return;
  const dir = tmp();
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, JSON.stringify({ schemaVersion: 1, configs: {} }));
  fs.symlinkSync(real, path.join(dir, '.policy-configs.json'));
  assert.throws(() => readDerivedPolicyConfigs(dir), { code: 'UNSAFE_PATH' });
});

test('writeDerivedPolicyConfigs is create-only 0600 and a second call is EXISTS', () => {
  const dir = tmp();
  const config = exploiterConfig();
  writeDerivedPolicyConfigs(dir, derivedMap(config));
  const file = path.join(dir, '.policy-configs.json');
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(body.schemaVersion, 1);
  assert.equal(typeof body.configs, 'object');
  assert.equal(Array.isArray(body.configs), false);
  assert.deepEqual(readDerivedPolicyConfigs(dir), derivedMap(config));
  assert.throws(() => writeDerivedPolicyConfigs(dir, derivedMap(config)), { code: 'EXISTS' });
});

test('sanitizePlayersForReview stays private pre-game and publishes derived evidence after gameOver', () => {
  const config = exploiterConfig();
  const v2 = assignmentFor('TAG');
  const players = [
    {
      playerId: 'p1',
      seat: 1,
      name: 'A',
      agentHandle: 'player-p1',
      speech: 'hi',
      personality: 'calm',
      archetype: 'SelfExploiter',
      policy: triple(config),
    },
    {
      playerId: 'p2',
      seat: 2,
      name: 'B',
      agentHandle: 'player-p2',
      speech: 'hi',
      personality: 'calm',
      archetype: 'TAG',
      policy: v2,
    },
  ];
  const pre = sanitizePlayersForReview(players, { gameOver: false, derived: derivedMap(config) });
  assert.deepEqual(Object.keys(pre[0]).sort(), [
    'agentHandle', 'archetype', 'name', 'personality', 'playerId', 'seat', 'speech',
  ]);
  assert.equal(Object.hasOwn(pre[0], 'policyId'), false);
  assert.equal(Object.hasOwn(pre[0], 'selfOpponent'), false);

  const post = sanitizePlayersForReview(players, { gameOver: true, derived: derivedMap(config) });
  const exploiter = post[0];
  assert.equal(exploiter.policyId, 'self-exploiter-v1');
  assert.equal(exploiter.policyVersion, '1.0.0');
  assert.equal(exploiter.policyModelKind, 'observed-tendency-exploiter-v1');
  assert.equal(exploiter.policyTraitsEvidence, 'derived-from-user-observed-action-frequencies-heuristic');
  assert.deepEqual(exploiter.policyTraits, config.traits);
  assert.equal(exploiter.selfOpponent.role, 'exploiter');
  assert.deepEqual(exploiter.selfOpponent.source, config.params.source);
  const exploiterJson = JSON.stringify(exploiter);
  assert.equal(exploiterJson.includes('qualitative-config-v2'), false);
  assert.equal(exploiterJson.includes('configured-not-observed-action-frequencies'), false);
  assert.equal(exploiterJson.includes('"kind"'), false);
  assert.equal(post[1].policyModelKind, 'qualitative-config-v2');

  assert.throws(
    () => sanitizePlayersForReview(players, { gameOver: true }),
    { code: 'POLICY_CONFIG_MISMATCH' },
  );
});

test('toOpponentModel and evaluateExploit mark derived models unsupported without fake EV', () => {
  const config = exploiterConfig();
  const stored = triple(config);
  const derived = derivedMap(config);
  const model = toOpponentModel(stored, { derived });
  assert.equal(model.opponentModelId, 'self-exploiter-v1');
  assert.equal(model.policyVersion, '1.0.0');
  assert.equal(model.modelKind, 'observed-tendency-exploiter-v1');
  assert.equal(model.modelKnowledge, 'derived-from-user-observed-action-frequencies-heuristic');
  assert.deepEqual(model.traits, config.traits);
  assert.strictEqual(Object.hasOwn(model, 'frequencies'), false);
  assert.deepEqual(Object.keys(modelsFromPlayers([
    { playerId: 'user' },
    { playerId: 'p1', policy: stored },
  ], { derived })), ['p1']);

  const out = evaluateExploit({
    gto: { decisionId: 'd-derived', status: 'supported', grade: 'preferred' },
    policy: stored,
    snapshot: { street: 'river', toCall: 100, decisionId: 'd-derived' },
    chosen: { action: 'call' },
    derived,
  });
  assert.equal(out.exploit.status, 'unsupported');
  assert.equal(out.exploit.reason, 'observed-tendency-exploiter-v1-unavailable');
  assert.equal(out.exploit.opponentModelId, 'self-exploiter-v1');
  assert.equal(out.exploit.modelKind, 'observed-tendency-exploiter-v1');
  assert.equal(out.exploit.modelKnowledge, 'derived-from-user-observed-action-frequencies-heuristic');
  assert.deepEqual(out.exploit.traits, config.traits);
  assert.equal(out.exploit.chosenEvBb, null);
  assert.equal(out.exploit.bestEvBb, null);
  assert.equal(out.exploit.evLossBb, null);
  assert.deepEqual(out.comparison, {
    status: 'unavailable',
    summaryCode: 'EXPLOIT_UNAVAILABLE',
    reason: 'observed-tendency-exploiter-v1-unavailable',
  });
  assertNoFakeEv(out.exploit);
  assertNoFakeEv(out.gto);
});

test('sealExploitAnnotations skips a mixed derived+v2 table and writes no annotation files', async () => {
  const dir = tmp('holdem-derived-seal');
  const config = exploiterConfig();
  const snapshotRow = {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    board: [],
    blinds: [50, 100],
    potBefore: 150,
    currentBet: 100,
    actorBet: 0,
    toCall: 100,
    minRaiseTo: 200,
    maxRaiseTo: 10_000,
    effectiveStack: 10_000,
    forced: false,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId, index) => ({
      playerId,
      out: false,
      folded: false,
      allIn: false,
      stack: 10_000,
      bet: 0,
      contribution: 100 * (index + 1),
    })),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: 'tok',
    lastHand: { handNo: 1, decisions: [snapshotRow] },
  }));
  writeDerivedPolicyConfigs(dir, derivedMap(config));
  const evaluation = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: EPOCH,
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-1-preflop-0',
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
  await createTrainingControl().acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [evaluation],
  });
  const result = await sealExploitAnnotations({
    sessionDir: dir,
    players: [
      { playerId: 'user' },
      { playerId: 'p1', policy: triple(config) },
      { playerId: 'p2', policy: POLICIES['tag-v2'] },
      { playerId: 'p3', policy: POLICIES['lag-v2'] },
      { playerId: 'p4', policy: POLICIES['nit-v2'] },
      { playerId: 'p5', policy: POLICIES['baseline-v2'] },
    ],
  });
  assert.deepEqual(result, { sealed: 0, skipped: 1 });
  const auth = createTrainingControl().loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations?.exploit, undefined);
  assert.deepEqual(annotationFiles(dir), []);
});
