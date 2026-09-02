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

test('sanitized review projection drops configDigest and policySeed', () => {
  const players = [{
    playerId: 'p1',
    seat: 1,
    name: 'A',
    agentHandle: 'player-p1',
    speech: 'hi',
    personality: 'calm',
    archetype: 'TAG',
    policy: {
      policyId: 'tag-v1',
      policyVersion: '1.0.0',
      configDigest: 'deadbeef',
    },
  }];
  const pre = JSON.stringify(sanitizePlayersForReview(players, { gameOver: false }));
  assert.equal(pre.includes('tag-v1'), false);
  assert.equal(pre.includes('deadbeef'), false);
  const post = sanitizePlayersForReview(players, { gameOver: true });
  assert.equal(post[0].policyId, 'tag-v1');
  assert.equal(JSON.stringify(post).includes('deadbeef'), false);
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
