import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gtoEvalNotice } from '../tools/game-loop.js';
import { stampPlayerPolicies } from '../tools/policy-player.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';

test('gtoEvalNotice uses humanCount + aiCount', () => {
  assert.equal(gtoEvalNotice({
    humanCount: 3, aiCount: 3, mode: 'cash-training', startStackBb: 100,
  }), null);
  assert.equal(gtoEvalNotice({ aiCount: 5, mode: 'cash-training', startStackBb: 100 }), null);
  const unsupported = gtoEvalNotice({ humanCount: 2, aiCount: 1, mode: 'cash-training', startStackBb: 100 });
  assert.match(unsupported, /3인/);
});

test('stampPlayerPolicies skips human participant rows', () => {
  const dir = createOwnedTempDir('holdem-policy-human');
  writeJsonAtomic(path.join(dir, 'players.json'), [
    { playerId: 'user', kind: 'human' },
    { playerId: 'h1', kind: 'human', name: '민준' },
    { playerId: 'p1', kind: 'ai', name: 'AI', archetype: 'TAG' },
  ]);
  stampPlayerPolicies(dir, { seed: 'ab'.repeat(32) });
  const players = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  assert.equal(players.find((row) => row.playerId === 'h1').policy, undefined);
  assert.ok(players.find((row) => row.playerId === 'p1').policy);
});
