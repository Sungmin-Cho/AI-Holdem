import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, stampPlayerPolicies } from '../tools/policy-player.js';
import { assignmentFor, sanitizePlayersForReview } from '../training/policies/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine/cli.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-policy-'));
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8' }).trim());
}

test('decision-peek is stable; view hides policySeed; redacted hand strips policy meta', () => {
  const dir = tmp();
  run(['init', '--ai', '1', '--game-dir', dir, '--opponent-runtime', 'policy']);
  stampPlayerPolicies(dir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.match(state.policySeed, /^[0-9a-f]{64}$/);
  const view = run(['view', '--for', 'user', '--game-dir', dir]);
  assert.equal(JSON.stringify(view).includes('policySeed'), false);
  assert.equal(JSON.stringify(view).includes('sampledProbability'), false);
  run(['new-hand', '--game-dir', dir]);
  const peek1 = run(['decision-peek', '--for', run(['legal', '--game-dir', dir]).toAct, '--game-dir', dir]);
  const peek2 = run(['decision-peek', '--for', peek1.legal.toAct, '--game-dir', dir]);
  assert.deepEqual(peek1.snapshot, peek2.snapshot);
  assert.equal('chosenAction' in peek1.snapshot, false);

  let guard = 0;
  while (guard < 40) {
    const legal = run(['legal', '--game-dir', dir]);
    if (legal.handOver) break;
    if (legal.toAct === 'user') {
      run(['apply', 'user', legal.canCheck ? 'check' : 'fold', '--game-dir', dir]);
    } else {
      const peek = run(['decision-peek', '--for', legal.toAct, '--game-dir', dir]);
      const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
      const seat = players.find((player) => player.playerId === legal.toAct);
      const choice = decide({
        snapshot: peek.snapshot,
        legal: peek.legal,
        policy: seat.policy,
        policySeed: JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).policySeed,
        gameEpoch: 'ab'.repeat(32),
      });
      const args = ['apply', legal.toAct, choice.action];
      if (choice.action === 'raise') args.push(String(choice.amount));
      args.push('--game-dir', dir, '--policy-meta', JSON.stringify({
        policyId: choice.policyId,
        sampledProbability: choice.sampledProbability,
        reasonCode: choice.reasonCode,
      }));
      run(args);
    }
    guard += 1;
  }
  const redacted = run(['hand', '1', '--redacted', '--game-dir', dir]);
  const raw = JSON.stringify(redacted);
  assert.equal(raw.includes('sampledProbability'), false);
  assert.equal(raw.includes('policyId'), false);
  assert.equal(raw.includes(state.policySeed), false);
});

test('open 정책 게임의 hand --redacted에도 policyId·reasonCode가 없다', () => {
  const dir = tmp();
  run(['init', '--ai', '1', '--game-dir', dir, '--opponent-runtime', 'policy', '--showdown-policy', 'open']);
  stampPlayerPolicies(dir);
  run(['new-hand', '--game-dir', dir]);
  let guard = 0;
  while (guard < 40) {
    const legal = run(['legal', '--game-dir', dir]);
    if (legal.handOver) break;
    if (legal.toAct === 'user') {
      run(['apply', 'user', legal.canCheck ? 'check' : 'fold', '--game-dir', dir]);
    } else {
      const peek = run(['decision-peek', '--for', legal.toAct, '--game-dir', dir]);
      const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
      const seat = players.find((player) => player.playerId === legal.toAct);
      const choice = decide({
        snapshot: peek.snapshot,
        legal: peek.legal,
        policy: seat.policy,
        policySeed: JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).policySeed,
        gameEpoch: 'ab'.repeat(32),
      });
      const args = ['apply', legal.toAct, choice.action];
      if (choice.action === 'raise') args.push(String(choice.amount));
      args.push('--game-dir', dir, '--policy-meta', JSON.stringify({
        policyId: choice.policyId,
        sampledProbability: choice.sampledProbability,
        reasonCode: choice.reasonCode,
      }));
      run(args);
    }
    guard += 1;
  }
  const redacted = JSON.stringify(run(['hand', '1', '--redacted', '--game-dir', dir]));
  assert.equal(redacted.includes('policyId'), false);
  assert.equal(redacted.includes('reasonCode'), false);
});

test('sanitized review projection stays private pre-game and resolves exact post-game identity', () => {
  const players = [{
    playerId: 'p1',
    seat: 1,
    name: 'A',
    agentHandle: 'player-p1',
    speech: 'hi',
    personality: 'calm',
    archetype: 'TAG',
    policy: assignmentFor('TAG'),
  }];
  const pre = JSON.stringify(sanitizePlayersForReview(players, { gameOver: false }));
  assert.equal(pre.includes('tag-v2'), false);
  assert.equal(pre.includes('policyTraits'), false);
  const post = sanitizePlayersForReview(players, { gameOver: true });
  assert.equal(post[0].policyId, 'tag-v2');
  assert.equal(post[0].policyModelKind, 'qualitative-config-v2');
  assert.throws(() => sanitizePlayersForReview([{ ...players[0], policy: {
    ...players[0].policy,
    configDigest: 'deadbeef',
  } }], { gameOver: true }), { code: 'POLICY_CONFIG_MISMATCH' });
});

function snapshot(over = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    street: 'preflop',
    holeCards: ['Ah', 'Ad'],
    board: [],
    blinds: [50, 100],
    toCall: 0,
    position: 'UTG',
    publicSeats: Array.from({ length: 6 }, (_, i) => ({
      playerId: i === 0 ? 'user' : `p${i}`,
      out: false,
    })),
    priorActions: [],
    effectiveStack: 10000,
    ...over,
  };
}

const openLegal = {
  canCheck: false,
  canRaise: true,
  callAmount: 50,
  minRaiseTo: 200,
  maxRaiseTo: 10000,
};

test('stampPlayerPolicies is idempotent for existing seats and fail-closes on catalog mismatch', () => {
  const dir = tmp();
  run(['init', '--ai', '2', '--game-dir', dir, '--opponent-runtime', 'policy']);
  const first = stampPlayerPolicies(dir);
  const ai = first.filter((player) => player.playerId !== 'user');
  assert.equal(ai.length, 2);
  for (const player of ai) {
    assert.deepEqual(player.policy, assignmentFor(player.archetype));
  }

  const marked = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  const kept = marked.find((player) => player.playerId === 'p1');
  kept.policy = { ...kept.policy, extra: 'keep' };
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(marked));
  const restamped = stampPlayerPolicies(dir);
  const again = restamped.find((player) => player.playerId === 'p1');
  assert.equal(again.policy.extra, 'keep');
  assert.deepEqual(
    { policyId: again.policy.policyId, policyVersion: again.policy.policyVersion, configDigest: again.policy.configDigest },
    assignmentFor(again.archetype),
  );

  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).policySeed;
  const epoch = 'ab'.repeat(32);
  const choice1 = decide({
    snapshot: snapshot(),
    legal: openLegal,
    policy: again.policy,
    policySeed: seed,
    gameEpoch: epoch,
  });
  const choice2 = decide({
    snapshot: snapshot(),
    legal: openLegal,
    policy: assignmentFor(again.archetype),
    policySeed: seed,
    gameEpoch: epoch,
  });
  assert.deepEqual(choice1, choice2);

  const broken = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  broken.find((player) => player.playerId === 'p1').policy.configDigest = '00'.repeat(32);
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(broken));
  assert.throws(() => stampPlayerPolicies(dir), { code: 'POLICY_CONFIG_MISMATCH' });
});

const DIGEST_V2_2_0_0 = Object.freeze({
  'baseline-v2': '336abab921c7c8381aeb555e483df79931d6e83180ed5cf1f8ace17c474a4271',
  'tag-v2': '4dd8bfeca2becb1ab610df7a3ebd8d361835ccb0e8923ef18e71432c63525f6f',
  'lag-v2': '597de71b9b3843621a35a0ebbf2eee8bbfdfab9c35ff4d92006a6f12a84035fe',
  'nit-v2': 'efc2bd49e4c5e2ba8fc7049d0145cfdfc087be11c6d45a22b6af661ebbfa1bfe',
  'calling-station-v2': '4b2333d1fcef41fca2370f2006166c83571d7ff6c4b324faf3317d35355b9713',
  'maniac-v2': 'f0ac07cc2c08ce44ad3678585a9dfd0ca769aa10aca4fb52295f7a4adf5f1d71',
  'trickster-v2': '7dc73778b5a3dd6a309cf227c249b5b0240318f583ef147d0bd0f6cd89db03c7',
});

test('stampPlayerPolicies rolls exact 2.0.0 seats forward once and preserves extra keys', () => {
  const dir = tmp();
  run(['init', '--ai', '2', '--game-dir', dir, '--opponent-runtime', 'policy']);
  stampPlayerPolicies(dir);
  const playersPath = path.join(dir, 'players.json');
  const marked = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  for (const player of marked) {
    if (player.playerId === 'user' || !player.policy) continue;
    const digest = DIGEST_V2_2_0_0[player.policy.policyId];
    assert.ok(digest, player.policy.policyId);
    player.policy = {
      ...player.policy,
      policyVersion: '2.0.0',
      configDigest: digest,
      extra: 'keep',
    };
  }
  fs.writeFileSync(playersPath, JSON.stringify(marked));

  const notices = [];
  const first = stampPlayerPolicies(dir, { onNotice: (message) => notices.push(message) });
  const ai = first.filter((player) => player.playerId !== 'user');
  assert.equal(ai.length, 2);
  for (const player of ai) {
    assert.equal(player.policy.policyVersion, '2.2.0');
    assert.equal(player.policy.extra, 'keep');
    assert.deepEqual(
      {
        policyId: player.policy.policyId,
        policyVersion: player.policy.policyVersion,
        configDigest: player.policy.configDigest,
      },
      assignmentFor(player.archetype),
    );
  }
  assert.equal(notices.length, 1);
  assert.equal(notices[0], `policy roll-forward 2.0.0→2.2.0: ${ai.map((player) => player.playerId).join(',')}`);

  const afterFirst = fs.readFileSync(playersPath);
  const secondNotices = [];
  stampPlayerPolicies(dir, { onNotice: (message) => secondNotices.push(message) });
  assert.deepEqual(secondNotices, []);
  assert.deepEqual(fs.readFileSync(playersPath), afterFirst);
});

test('stampPlayerPolicies preserves derived seats and extra keys from the session digest file', async () => {
  const { writeDerivedPolicyConfigs } = await import('../tools/policy-player.js');
  const { configDigestOf } = await import('../training/policies/contracts.js');
  const { VERSION_V2 } = await import('../training/policies/catalog.js');
  assert.equal(typeof writeDerivedPolicyConfigs, 'function');
  const dir = tmp();
  run(['init', '--ai', '2', '--game-dir', dir, '--opponent-runtime', 'policy']);
  stampPlayerPolicies(dir);
  const config = {
    policyId: 'self-exploiter-v1',
    policyVersion: '1.0.0',
    base: 'strategy-v2',
    traits: { tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12 },
    params: {
      strategyVersion: VERSION_V2,
      source: { hands: 80, decisions: 200, sessions: 2, extractedAt: '2026-09-07T00:00:00.000Z' },
      evidence: 'derived-from-user-observed-action-frequencies-heuristic',
    },
  };
  config.configDigest = configDigestOf(config);
  const playersPath = path.join(dir, 'players.json');
  const players = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  const derivedSeat = players.find((player) => player.playerId === 'p1');
  derivedSeat.archetype = 'SelfExploiter';
  derivedSeat.policy = {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
    extra: 'keep',
  };
  fs.writeFileSync(playersPath, JSON.stringify(players));
  writeDerivedPolicyConfigs(dir, { [config.configDigest]: config });

  const notices = [];
  const stamped = stampPlayerPolicies(dir, { onNotice: (message) => notices.push(message) });
  const again = stamped.find((player) => player.playerId === 'p1');
  assert.equal(again.policy.extra, 'keep');
  assert.equal(again.policy.policyId, 'self-exploiter-v1');
  assert.equal(again.policy.policyVersion, '1.0.0');
  assert.equal(again.policy.configDigest, config.configDigest);
  assert.deepEqual(notices, []);
});

test('stampPlayerPolicies fail-closes when a derived seat has no digest file', async () => {
  const { configDigestOf } = await import('../training/policies/contracts.js');
  const { VERSION_V2 } = await import('../training/policies/catalog.js');
  const dir = tmp();
  run(['init', '--ai', '1', '--game-dir', dir, '--opponent-runtime', 'policy']);
  stampPlayerPolicies(dir);
  const config = {
    policyId: 'self-exploiter-v1',
    policyVersion: '1.0.0',
    base: 'strategy-v2',
    traits: { tightness: 0.5, aggression: 0.5, calling: 0.5, bluff: 0.5 },
    params: { strategyVersion: VERSION_V2 },
  };
  config.configDigest = configDigestOf(config);
  const playersPath = path.join(dir, 'players.json');
  const players = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  const seat = players.find((player) => player.playerId === 'p1');
  seat.archetype = 'SelfExploiter';
  seat.policy = {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
  };
  fs.writeFileSync(playersPath, JSON.stringify(players));
  assert.throws(() => stampPlayerPolicies(dir), { code: 'POLICY_CONFIG_MISMATCH' });
});

test('stampPlayerPolicies rejects SelfMirror without a policy and does not assign a catalog fallback', () => {
  const dir = tmp();
  run(['init', '--ai', '1', '--game-dir', dir, '--opponent-runtime', 'policy']);
  const playersPath = path.join(dir, 'players.json');
  const players = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  const seat = players.find((player) => player.playerId === 'p1');
  seat.archetype = 'SelfMirror';
  delete seat.policy;
  fs.writeFileSync(playersPath, JSON.stringify(players));
  assert.throws(() => stampPlayerPolicies(dir), { code: 'SELF_OPPONENT_INCOMPLETE' });
  const after = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  assert.equal(after.find((player) => player.playerId === 'p1').policy, undefined);
});

test('stampPlayerPolicies emits catalog and derived roll-forward notices together without restamping derived', async () => {
  const { writeDerivedPolicyConfigs } = await import('../tools/policy-player.js');
  const { configDigestOf } = await import('../training/policies/contracts.js');
  const { VERSION_V2 } = await import('../training/policies/catalog.js');
  const dir = tmp();
  run(['init', '--ai', '2', '--game-dir', dir, '--opponent-runtime', 'policy']);
  stampPlayerPolicies(dir);
  const config = {
    policyId: 'self-exploiter-v1',
    policyVersion: '1.0.0',
    base: 'strategy-v2',
    traits: { tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12 },
    params: {
      strategyVersion: '2.0.0',
      source: { hands: 80, decisions: 200, sessions: 2, extractedAt: '2026-09-07T00:00:00.000Z' },
      evidence: 'derived-from-user-observed-action-frequencies-heuristic',
    },
  };
  config.configDigest = configDigestOf(config);
  const playersPath = path.join(dir, 'players.json');
  const marked = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  const derivedSeat = marked.find((player) => player.playerId === 'p1');
  derivedSeat.archetype = 'SelfExploiter';
  derivedSeat.policy = {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
    extra: 'keep',
  };
  const catalogSeat = marked.find((player) => player.playerId === 'p2');
  const predecessor = DIGEST_V2_2_0_0[catalogSeat.policy.policyId];
  assert.ok(predecessor, catalogSeat.policy.policyId);
  catalogSeat.policy = {
    ...catalogSeat.policy,
    policyVersion: '2.0.0',
    configDigest: predecessor,
    extra: 'keep',
  };
  fs.writeFileSync(playersPath, JSON.stringify(marked));
  writeDerivedPolicyConfigs(dir, { [config.configDigest]: config });

  const notices = [];
  const stamped = stampPlayerPolicies(dir, { onNotice: (message) => notices.push(message) });
  const derived = stamped.find((player) => player.playerId === 'p1');
  const catalog = stamped.find((player) => player.playerId === 'p2');
  assert.equal(derived.policy.extra, 'keep');
  assert.equal(derived.policy.policyVersion, '1.0.0');
  assert.equal(derived.policy.configDigest, config.configDigest);
  assert.equal(catalog.policy.policyVersion, '2.2.0');
  assert.equal(catalog.policy.extra, 'keep');
  assert.deepEqual(
    {
      policyId: catalog.policy.policyId,
      policyVersion: catalog.policy.policyVersion,
      configDigest: catalog.policy.configDigest,
    },
    assignmentFor(catalog.archetype),
  );
  assert.equal(notices.length, 2);
  assert.equal(notices[0], `policy roll-forward 2.0.0→2.2.0: p2`);
  assert.equal(notices[1], `self-opponent strategy roll-forward 2.0.0→${VERSION_V2}: p1`);
});
