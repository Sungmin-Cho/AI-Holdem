import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentFor } from '../training/policies/catalog.js';

test('REQ-005: new sessions use separately versioned Nit policy', () => {
  assert.strictEqual(
    assignmentFor('Nit').policyId,
    'nit-v2',
    'new sessions must select the v2 Nit policy',
  );
});

import './helpers/owned-fixtures.mjs';

test('all six personas and fallback receive separate v2 identities', async () => {
  const { assignmentFor: assign } = await import('../training/policies/catalog.js');
  assert.deepEqual(
    ['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster', 'unknown'].map(
      (persona) => assign(persona).policyId,
    ),
    ['tag-v2', 'lag-v2', 'nit-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2', 'baseline-v2'],
  );
});

test('all legacy v1 serialized configs and digests remain byte-equivalent', async () => {
  const { POLICIES } = await import('../training/policies/catalog.js');
  assert.deepEqual(
    Object.fromEntries(Object.entries(POLICIES).filter(([id]) => id.endsWith('-v1'))),
    {
      'baseline-v1': {
        policyId: 'baseline-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.75, foldVsBet: 0.55, callVsBet: 0.35, raiseVsBet: 0.10 }, deviations: [],
        configDigest: 'a04885fd57ef3b7d34fdf6c9182297572e2e72aae4915f4b0468667d44300137',
      },
      'tag-v1': {
        policyId: 'tag-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.78, foldVsBet: 0.58, callVsBet: 0.30, raiseVsBet: 0.12 }, deviations: [],
        configDigest: '7cdcf608918474799483412ce79bff830271a5adf37774baf18de7533d480a92',
      },
      'lag-v1': {
        policyId: 'lag-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.55, foldVsBet: 0.28, callVsBet: 0.32, raiseVsBet: 0.40 }, deviations: [],
        configDigest: '7d2dda4499b7e602a5006bade1fd04fdf57fbcee1eec466fbe28eb3e9b1bf8c3',
      },
      'nit-v1': {
        policyId: 'nit-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.90, foldVsBet: 0.82, callVsBet: 0.14, raiseVsBet: 0.04 }, deviations: [],
        configDigest: '62c52f37372ae00ac1fa35d7d739f4b88054d249b02f7de2f2337e78e087b401',
      },
      'calling-station-v1': {
        policyId: 'calling-station-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.70, foldVsBet: 0.18, callVsBet: 0.74, raiseVsBet: 0.08 },
        deviations: [{ selector: { street: 'river', facingBet: true }, operation: 'shift', from: 'fold', to: 'call', probability: 0.20 }],
        configDigest: '2dc9bb196b9b6f7f0eafb006157b96a32d6d6f331a3d162ed4f27aba7b4bf150',
      },
      'maniac-v1': {
        policyId: 'maniac-v1', policyVersion: '1.0.0', base: 'baseline-v1', fallback: 'rule-based-v1',
        frequencies: { checkFreq: 0.28, foldVsBet: 0.12, callVsBet: 0.20, raiseVsBet: 0.68 }, deviations: [],
        configDigest: '0a135917266da119fbc3348282d9ba1425ffc479f5307932aeb64903e3ce030b',
      },
    },
  );
});

test('resolveExactPolicy accepts exact v1 and v2 stored tuples', async () => {
  const catalog = await import('../training/policies/catalog.js');
  assert.strictEqual(typeof catalog.resolveExactPolicy, 'function');
  for (const id of ['tag-v1', 'tag-v2']) {
    const stored = catalog.POLICIES[id];
    assert.strictEqual(catalog.resolveExactPolicy(stored), stored);
    assert.strictEqual(catalog.resolveExactPolicy({
      policyId: stored.policyId,
      policyVersion: stored.policyVersion,
      configDigest: stored.configDigest,
    }), stored);
  }
});

test('resolveExactPolicy rejects unknown and incomplete stored identities', async () => {
  const { resolveExactPolicy } = await import('../training/policies/catalog.js');
  for (const stored of [
    null,
    {},
    { policyId: 'unknown-v2', policyVersion: '2.0.0', configDigest: '00'.repeat(32) },
    { policyId: 'tag-v2' },
  ]) {
    assert.throws(() => resolveExactPolicy(stored), { code: 'POLICY_CONFIG_MISMATCH' });
  }
});

test('resolveExactPolicy rejects wrong version and digest without object fallback', async () => {
  const { POLICIES, resolveExactPolicy } = await import('../training/policies/catalog.js');
  const exact = POLICIES['tag-v2'];
  assert.throws(() => resolveExactPolicy({ ...exact, policyVersion: '9.0.0' }), { code: 'POLICY_CONFIG_MISMATCH' });
  assert.throws(() => resolveExactPolicy({ ...exact, configDigest: '00'.repeat(32) }), { code: 'POLICY_CONFIG_MISMATCH' });
  assert.throws(() => resolveExactPolicy({
    policyId: 'invented', policyVersion: '2.0.0', configDigest: '00'.repeat(32),
    frequencies: { foldVsBet: 0, callVsBet: 1, raiseVsBet: 0 },
  }), { code: 'POLICY_CONFIG_MISMATCH' });
});

test('catalog lookup and archetype fallback ignore prototype-chain keys', async () => {
  const { assignmentFor: assign, policyById: lookup } = await import('../training/policies/catalog.js');
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual(lookup(key), null, `${key} must not resolve through Object.prototype`);
    assert.strictEqual(assign(key).policyId, 'baseline-v2', `${key} must use the documented fallback`);
  }
});

test('exact resolver requires own complete tuple fields', async () => {
  const { POLICIES, resolveExactPolicy } = await import('../training/policies/catalog.js');
  const exact = POLICIES['tag-v2'];
  const inherited = Object.create({
    policyId: exact.policyId,
    policyVersion: exact.policyVersion,
    configDigest: exact.configDigest,
  });
  const partial = Object.assign(Object.create({
    policyVersion: exact.policyVersion,
    configDigest: exact.configDigest,
  }), { policyId: exact.policyId });
  for (const stored of [inherited, partial]) {
    assert.throws(() => resolveExactPolicy(stored), { code: 'POLICY_CONFIG_MISMATCH' });
  }
});

test('canonical policy configs and nested strategy inputs cannot be mutated behind their digest', async () => {
  const { POLICIES } = await import('../training/policies/catalog.js');
  const v1 = POLICIES['calling-station-v1'];
  const v2 = POLICIES['tag-v2'];
  for (const value of [v1, v1.frequencies, v1.deviations, v1.deviations[0], v2, v2.traits]) {
    assert.strictEqual(Object.isFrozen(value), true);
  }
  assert.throws(() => { v2.traits.tightness = 0; }, TypeError);
  assert.strictEqual(v2.traits.tightness, 0.62);
});

test('v2 catalog publishes only the strategy traits it actually applies', async () => {
  const { POLICIES } = await import('../training/policies/catalog.js');
  for (const config of Object.values(POLICIES).filter((row) => row.policyVersion === '2.0.0')) {
    assert.strictEqual(Object.hasOwn(config, 'frequencies'), false, config.policyId);
    assert.strictEqual(Object.hasOwn(config, 'deviations'), false, config.policyId);
    assert.deepEqual(Object.keys(config.traits).sort(), ['aggression', 'bluff', 'calling', 'tightness']);
  }
});

test('post-game sanitization resolves exact identity and reveals qualitative v2 traits only', async () => {
  const { assignmentFor: assign, sanitizePlayersForReview } = await import('../training/policies/catalog.js');
  const player = { playerId: 'p1', archetype: 'TAG', policy: assign('TAG') };
  const pre = sanitizePlayersForReview([player], { gameOver: false })[0];
  assert.strictEqual(Object.hasOwn(pre, 'policyId'), false);
  assert.strictEqual(Object.hasOwn(pre, 'policyTraits'), false);
  const post = sanitizePlayersForReview([player], { gameOver: true })[0];
  assert.equal(post.policyId, 'tag-v2');
  assert.equal(post.policyVersion, '2.0.0');
  assert.equal(post.policyModelKind, 'qualitative-config-v2');
  assert.equal(post.policyTraitsEvidence, 'configured-not-observed-action-frequencies');
  assert.deepEqual(post.policyTraits, {
    tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12,
  });
  assert.strictEqual(Object.hasOwn(post, 'frequencies'), false);
  assert.strictEqual(Object.hasOwn(post, 'deviation'), false);
  assert.throws(() => sanitizePlayersForReview([{ ...player, policy: {
    ...player.policy, configDigest: '00'.repeat(32),
  } }], { gameOver: true }), { code: 'POLICY_CONFIG_MISMATCH' });
});

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

test('public hand strength is bounded and separates fixed river nuts from air', async () => {
  const { estimatePublicStrength } = await import('../training/policies/hand-strength.js');
  const nuts = estimatePublicStrength(snapshot());
  const air = estimatePublicStrength(snapshot({ holeCards: ['3d', '4s'] }));
  assert.ok(nuts >= 0 && nuts <= 1);
  assert.ok(air >= 0 && air <= 1);
  assert.ok(nuts - air >= 0.5, `nuts=${nuts} air=${air}`);
});

test('public hand strength stratifies strong marginal draw and air fixtures', async () => {
  const { estimatePublicStrength } = await import('../training/policies/hand-strength.js');
  const fixtures = [
    snapshot({ holeCards: ['Th', '9d'] }),
    snapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] }),
    snapshot({ street: 'turn', holeCards: ['Th', '9h'], board: ['Ah', 'Kh', '2c', '3d'] }),
    snapshot({ holeCards: ['3d', '4s'] }),
  ].map(estimatePublicStrength);
  assert.ok(fixtures[0] > fixtures[1]);
  assert.ok(fixtures[1] > fixtures[3]);
  assert.ok(fixtures[2] > fixtures[3]);
});

test('preflop strength responds to cards and position', async () => {
  const { estimatePublicStrength } = await import('../training/policies/hand-strength.js');
  const preflop = (holeCards, position) => estimatePublicStrength(unopenedPreflop(holeCards, { position }));
  assert.ok(preflop(['Ah', 'Ad'], 'UTG') > preflop(['7c', '2d'], 'BTN'));
  assert.ok(preflop(['Kh', 'Td'], 'BTN') > preflop(['Kh', 'Td'], 'UTG'));
});

test('strength sampling is deterministic and ignores hidden state and price', async () => {
  const { estimatePublicStrength } = await import('../training/policies/hand-strength.js');
  const base = snapshot({ street: 'flop', holeCards: ['Ah', 'Qh'], board: ['Jh', '7c', '2d'] });
  const a = estimatePublicStrength(base);
  const b = estimatePublicStrength({
    ...base,
    toCall: 9_999,
    deck: ['As', 'Ac'],
    opponentHoleCards: [['Ks', 'Kc']],
    hidden: { futureBoard: ['Th', 'Kh'] },
  });
  assert.strictEqual(a, b);
});

const PERSONA_IDS = ['nit-v2', 'tag-v2', 'lag-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2'];

const facingLegal = {
  canCheck: false, canRaise: true, callAmount: 500, minRaiseTo: 1_000, maxRaiseTo: 10_000,
};

const openLegal = {
  canCheck: false, canRaise: true, callAmount: 100, minRaiseTo: 200, maxRaiseTo: 10_000,
};

const defenseLegal = {
  canCheck: false, canRaise: true, callAmount: 200, minRaiseTo: 400, maxRaiseTo: 10_000,
};

function probability(items, action) {
  return items.filter((item) => item.action === action).reduce((sum, item) => sum + item.frequency, 0);
}

function participation(items) {
  return 1 - probability(items, 'fold');
}

test('all six personas protect river nuts and separate them from air', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  for (const id of PERSONA_IDS) {
    const nuts = distributionV2(snapshot(), facingLegal, policyById(id));
    const air = distributionV2(snapshot({ holeCards: ['3d', '4s'] }), facingLegal, policyById(id));
    const nutsFold = probability(nuts, 'fold');
    const airFold = probability(air, 'fold');
    assert.ok(nutsFold <= 0.05, `${id} nutsFold=${nutsFold}`);
    assert.ok(airFold - nutsFold >= 0.5, `${id} nutsFold=${nutsFold} airFold=${airFold}`);
  }
});

test('all six personas respond directionally to strong marginal draw and air', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const fixtures = {
    strong: snapshot({ holeCards: ['Th', '9d'] }),
    marginal: snapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] }),
    draw: snapshot({ street: 'turn', holeCards: ['Th', '9h'], board: ['Ah', 'Kh', '2c', '3d'] }),
    air: snapshot({ holeCards: ['3d', '4s'] }),
  };
  for (const id of PERSONA_IDS) {
    const scores = Object.fromEntries(Object.entries(fixtures).map(([name, input]) => [
      name, participation(distributionV2(input, facingLegal, policyById(id))),
    ]));
    assert.ok(scores.strong > scores.marginal, `${id} ${JSON.stringify(scores)}`);
    assert.ok(scores.marginal > scores.air, `${id} ${JSON.stringify(scores)}`);
    assert.ok(scores.draw > scores.air, `${id} ${JSON.stringify(scores)}`);
  }
});

test('higher call price never increases marginal participation for any persona', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const marginal = snapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] });
  for (const id of PERSONA_IDS) {
    const cheap = participation(distributionV2(
      { ...marginal, potBefore: 1_000, toCall: 100 },
      { ...facingLegal, callAmount: 100 },
      policyById(id),
    ));
    const expensive = participation(distributionV2(
      { ...marginal, potBefore: 500, toCall: 1_000 },
      { ...facingLegal, callAmount: 1_000 },
      policyById(id),
    ));
    assert.ok(expensive <= cheap, `${id} cheap=${cheap} expensive=${expensive}`);
  }
});

test('v2 unopened pots have no limp and use a 2.5BB raise-to', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  for (const id of PERSONA_IDS) {
    const items = distributionV2(unopenedPreflop(['Ah', 'Kd']), openLegal, policyById(id));
    assert.equal(probability(items, 'call'), 0, id);
    assert.deepEqual([...new Set(items.filter((item) => item.action === 'raise').map((item) => item.amount))], [250]);
  }
});

test('v2 single-open responses use an 8.5BB standard 3bet', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const input = facingOpenPreflop(['Ah', 'Ad']);
  const legal = defenseLegal;
  for (const id of PERSONA_IDS) {
    const raises = distributionV2(input, legal, policyById(id)).filter((item) => item.action === 'raise');
    assert.ok(raises.length > 0, id);
    assert.ok(raises.every((item) => item.amount === 850), id);
  }
});

test('v2 keeps the only legal short all-in raise available', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const legal = { ...facingLegal, minRaiseTo: 850, maxRaiseTo: 620 };
  const items = distributionV2(snapshot(), legal, policyById('tag-v2'));
  assert.ok(items.some((item) => item.action === 'raise' && item.amount === 620));
});

test('v2 distributions normalize and contain only legal actions', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const cases = [
    [snapshot(), facingLegal],
    [snapshot({ street: 'flop', board: ['Ah', '7c', '2d'] }), { canCheck: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }],
  ];
  for (const id of PERSONA_IDS) {
    for (const [input, legal] of cases) {
      const items = distributionV2(input, legal, policyById(id));
      assert.ok(Math.abs(items.reduce((sum, item) => sum + item.frequency, 0) - 1) < 1e-12);
      assert.ok(items.every((item) => ['fold', 'check', 'call', 'raise'].includes(item.action)));
      if (legal.canCheck) assert.ok(items.every((item) => item.action !== 'fold' && item.action !== 'call'));
      if (!legal.canRaise) assert.ok(items.every((item) => item.action !== 'raise'));
    }
  }
});

test('combo-weighted unopened participation orders Nit TAG LAG Maniac', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const grid = [
    { cards: ['Ah', 'Ad'], weight: 6 }, { cards: ['Ah', 'Kh'], weight: 4 },
    { cards: ['Ah', 'Kd'], weight: 12 }, { cards: ['Kh', 'Qh'], weight: 4 },
    { cards: ['Jh', 'Td'], weight: 12 }, { cards: ['9h', '8h'], weight: 4 },
    { cards: ['7c', '2d'], weight: 12 }, { cards: ['5c', '4c'], weight: 4 },
  ];
  const rate = (id) => grid.reduce((sum, row) => sum + row.weight * participation(distributionV2(
    unopenedPreflop(row.cards), openLegal, policyById(id),
  )), 0) / grid.reduce((sum, row) => sum + row.weight, 0);
  const rates = ['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2'].map(rate);
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2] && rates[2] < rates[3], JSON.stringify(rates));
});

test('Calling Station calls more than TAG on a fixed defense grid', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const hands = [['Ah', 'Qd'], ['Jh', 'Th'], ['8c', '8d'], ['7h', '6h'], ['4c', '3d']];
  const callRate = (id) => hands.reduce((sum, cards) => sum + probability(distributionV2(
    facingOpenPreflop(cards), defenseLegal, policyById(id),
  ), 'call'), 0) / hands.length;
  assert.ok(callRate('calling-station-v2') > callRate('tag-v2'));
});

test('Trickster differs materially from baseline-v2 on a fixed grid', async () => {
  const { distributionV2 } = await import('../training/policies/strategy-v2.js');
  const { policyById } = await import('../training/policies/catalog.js');
  const hands = [['Ah', 'Ad'], ['Ah', 'Qd'], ['Jh', 'Th'], ['7h', '6h'], ['4c', '3d']];
  const tvs = hands.map((cards) => {
    const input = facingOpenPreflop(cards);
    const legal = defenseLegal;
    const left = distributionV2(input, legal, policyById('trickster-v2'));
    const right = distributionV2(input, legal, policyById('baseline-v2'));
    return 0.5 * ['fold', 'call', 'raise'].reduce((sum, action) => sum + Math.abs(probability(left, action) - probability(right, action)), 0);
  });
  assert.ok(tvs.reduce((sum, value) => sum + value, 0) / tvs.length >= 0.05, JSON.stringify(tvs));
});

test('gameplay dispatches exact v2 tuples deterministically and ignores hidden state', async () => {
  const { decide, distributionFor } = await import('../tools/policy-player.js');
  const { assignmentFor } = await import('../training/policies/catalog.js');
  const policy = assignmentFor('TAG');
  const input = {
    snapshot: snapshot({ street: 'flop', holeCards: ['Ah', 'Qh'], board: ['Jh', '7c', '2d'] }),
    legal: facingLegal,
    policy,
    policySeed: 'ab'.repeat(32),
    gameEpoch: 'cd'.repeat(32),
  };
  const expected = decide(input);
  assert.deepEqual(decide(input), expected);
  assert.deepEqual(decide({
    ...input,
    snapshot: {
      ...input.snapshot,
      deck: ['As', 'Ac'],
      opponentHoleCards: [['Ks', 'Kc']],
      hidden: { futureBoard: ['Th', 'Kh'] },
    },
  }), expected);
  assert.deepEqual(distributionFor(input.snapshot, input.legal, policy), distributionFor(input.snapshot, input.legal, policy));
});

test('gameplay rejects unknown wrong-version wrong-digest and arbitrary stored policies', async () => {
  const { decide } = await import('../tools/policy-player.js');
  const { assignmentFor } = await import('../training/policies/catalog.js');
  const base = {
    snapshot: snapshot(), legal: facingLegal, policySeed: 'ab'.repeat(32), gameEpoch: 'cd'.repeat(32),
  };
  const exact = assignmentFor('TAG');
  for (const policy of [
    { ...exact, policyId: 'unknown-v2' },
    { ...exact, policyVersion: '9.0.0' },
    { ...exact, configDigest: '00'.repeat(32) },
    { policyId: 'invented', policyVersion: '2.0.0', configDigest: '00'.repeat(32), frequencies: { foldVsBet: 0 } },
  ]) {
    assert.throws(() => decide({ ...base, policy }), { code: 'POLICY_CONFIG_MISMATCH' });
  }
  for (const policy of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => decide({ ...base, policy }), { code: 'UNKNOWN_POLICY' });
  }
});

test('fixed sampling seed preserves marginal price monotonicity', async () => {
  const { decide } = await import('../tools/policy-player.js');
  const { assignmentFor } = await import('../training/policies/catalog.js');
  const marginal = snapshot({ holeCards: ['Ad', '9s'], board: ['Ah', 'Kh', '7c', '4d', '2c'] });
  for (const persona of ['Nit', 'TAG', 'LAG', 'CallingStation', 'Maniac', 'Trickster']) {
    for (let index = 0; index < 40; index += 1) {
      const common = {
        snapshot: marginal,
        policy: assignmentFor(persona),
        policySeed: `${persona}-${index}`,
        gameEpoch: 'ef'.repeat(32),
      };
      const cheap = decide({ ...common, legal: { ...facingLegal, callAmount: 100 } });
      const expensive = decide({ ...common, legal: { ...facingLegal, callAmount: 1_000 } });
      if (expensive.action !== 'fold') assert.notEqual(cheap.action, 'fold', `${persona}-${index}`);
    }
  }
});

test('v1 gameplay distribution remains unchanged while exact tuples resume', async () => {
  const { distributionFor } = await import('../tools/policy-player.js');
  const { POLICIES } = await import('../training/policies/catalog.js');
  const items = distributionFor(
    snapshot({ street: 'flop', board: ['Ah', '7c', '2d'] }),
    facingLegal,
    POLICIES['tag-v1'],
  );
  assert.deepEqual(items.map(({ action, amount, reasonCode }) => ({ action, amount, reasonCode })), [
    { action: 'fold', amount: 0, reasonCode: 'rule-fold' },
    { action: 'call', amount: 500, reasonCode: 'rule-call' },
    { action: 'raise', amount: 1_000, reasonCode: 'rule-raise' },
  ]);
  assert.ok(Math.abs(items[0].frequency - 0.58) < 1e-12);
  assert.ok(Math.abs(items[1].frequency - 0.30) < 1e-12);
  assert.ok(Math.abs(items[2].frequency - 0.12) < 1e-12);
});

test('exploit and final-review model consumers accept exact v1 and v2 tuples', async () => {
  const { modelsFromPlayers, toOpponentModel } = await import('../training/exploit/policy-model.js');
  const { POLICIES, assignmentFor } = await import('../training/policies/catalog.js');
  assert.equal(toOpponentModel(POLICIES['tag-v1']).opponentModelId, 'tag-v1');
  const v2 = toOpponentModel(assignmentFor('TAG'));
  assert.equal(v2.opponentModelId, 'tag-v2');
  assert.equal(v2.modelKind, 'qualitative-config-v2');
  assert.equal(v2.modelKnowledge, 'configured-traits-not-observed-action-frequencies');
  assert.deepEqual(v2.traits, {
    tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12,
  });
  assert.strictEqual(Object.hasOwn(v2, 'frequencies'), false);
  assert.strictEqual(Object.hasOwn(v2, 'deviations'), false);
  assert.deepEqual(Object.keys(modelsFromPlayers([
    { playerId: 'user' },
    { playerId: 'p1', policy: assignmentFor('Nit') },
  ])), ['p1']);
});

test('exploit and final-review model consumers reject inexact stored tuples', async () => {
  const { modelsFromPlayers, toOpponentModel } = await import('../training/exploit/policy-model.js');
  const { assignmentFor } = await import('../training/policies/catalog.js');
  const exact = assignmentFor('TAG');
  for (const policy of [
    { ...exact, policyVersion: '1.0.0' },
    { ...exact, configDigest: '00'.repeat(32) },
    { policyId: 'made-up', frequencies: { foldVsBet: 0 } },
  ]) {
    assert.throws(() => toOpponentModel(policy), { code: 'POLICY_CONFIG_MISMATCH' });
    assert.throws(() => modelsFromPlayers([{ playerId: 'p1', policy }]), { code: 'POLICY_CONFIG_MISMATCH' });
  }
  for (const policy of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => toOpponentModel(policy), { code: 'UNKNOWN_POLICY' });
    assert.throws(() => modelsFromPlayers([{ playerId: 'p1', policy }]), { code: 'UNKNOWN_POLICY' });
  }
});

test('policy benchmark asserts the published heuristic thresholds', async () => {
  const { benchmarkPolicies, assertBenchmark } = await import('../tools/benchmark-policies.js');
  const result = benchmarkPolicies();
  assert.equal(assertBenchmark(result), result);
  assert.equal(result.evidenceKind, 'deterministic-heuristic-policy-behavior');
  assert.equal(result.claims.humanSkill, false);
  assert.equal(result.claims.gto, false);
  assert.ok(result.thresholds.nutsFoldMax <= 0.05);
  assert.ok(result.thresholds.nutsAirDifferenceMin >= 0.5);
  assert.equal(result.thresholds.marginalPriceViolationCount, 0);
  assert.deepEqual(result.thresholds.comboParticipationOrder, ['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2']);
  assert.ok(result.thresholds.stationCallMinusTag > 0);
  assert.ok(result.thresholds.tricksterBaselineMeanTv >= 0.05);
  assert.equal(result.thresholds.illegalOutputCount, 0);
  assert.equal(result.thresholds.determinismViolationCount, 0);
  assert.equal(result.thresholds.hiddenStateViolationCount, 0);
  assert.ok(Number.isFinite(result.measurements.wallClockMs.total));
  assert.ok(result.measurements.wallClockMs.total >= 0);
});

test('benchmark preflop scenarios match engine-derived BTN-open and SB-defense state', async () => {
  const { assertBenchmark, benchmarkPolicies } = await import('../tools/benchmark-policies.js');
  const result = benchmarkPolicies();
  assert.deepEqual(result.scenarios.preflop.unopened, {
    actorId: 'user', position: 'BTN', potBefore: 150, actorBet: 0,
    currentBet: 100, toCall: 100, callAmount: 100, minRaiseTo: 200,
  });
  assert.deepEqual(result.scenarios.preflop.facingOpen, {
    actorId: 'p1', position: 'SB', potBefore: 400, actorBet: 50,
    currentBet: 250, toCall: 200, callAmount: 200, minRaiseTo: 400,
  });
  assert.equal(result.methodology.preflopScenarios, 'derived-once-from-engine-state-transitions');
  assert.equal(result.measurements.kind, 'non-deterministic-wall-clock');
  assert.ok(Number.isFinite(result.measurements.wallClockMs.total));
  assert.strictEqual(Object.hasOwn(result, 'timings'), false);
  const again = benchmarkPolicies();
  const { measurements: leftMeasurements, ...leftBehavior } = result;
  const { measurements: rightMeasurements, ...rightBehavior } = again;
  assert.deepEqual(leftBehavior, rightBehavior);
  assert.ok(leftMeasurements.wallClockMs.total >= 0 && rightMeasurements.wallClockMs.total >= 0);
  assert.throws(() => assertBenchmark({
    ...result,
    scenarios: { preflop: { ...result.scenarios.preflop, unopened: {
      ...result.scenarios.preflop.unopened, callAmount: 50,
    } } },
  }), { code: 'POLICY_BENCHMARK_FAILED' });
});

test('policy benchmark CLI emits asserted JSON without stronger claims', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [
    'tools/benchmark-policies.js', '--assert', '--json',
  ], { cwd: root, encoding: 'utf8' }));
  assert.equal(result.evidenceKind, 'deterministic-heuristic-policy-behavior');
  assert.deepEqual(result.claims, { humanSkill: false, gto: false, solverAccuracy: false });
  assert.equal(result.preflop.classCount, 169);
  assert.equal(result.preflop.comboCount, 1_326);
});
