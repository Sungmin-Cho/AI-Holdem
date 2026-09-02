import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestHand, unpublishedEnvelope } from '../tools/training-pipeline.js';
import { gameEpochOf } from '../publish-contract.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tpipe-'));
}

test('ingestHand evaluates a user decision and builds a training envelope', async () => {
  const dir = tmp();
  const snapshot = {
    schemaVersion: 1,
    decisionId: 'd-1-preflop-0',
    actorId: 'user',
    street: 'preflop',
    position: 'BTN',
    holeCards: ['Ah', 'Ad'],
    blinds: [50, 100],
    effectiveStack: 10000,
    publicSeats: ['user', 'p1', 'p2', 'p3', 'p4', 'p5'].map((playerId) => ({
      playerId, out: false, folded: false, allIn: false, stack: 10000, bet: 0, contribution: 0,
    })),
    priorActions: [],
    chosenAction: { action: 'raise', amount: 250 },
    forced: false,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: 'tok',
    lastHand: { handNo: 1, decisions: [snapshot] },
  }));
  const result = await ingestHand({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf('tok'),
    owner: 'owner-1',
  });
  assert.equal(result.ok, true);
  const envelope = unpublishedEnvelope(dir, { gameEpoch: gameEpochOf('tok') });
  assert.equal(envelope.training.length, 1);
  assert.equal(envelope.training[0].handClass, 'AA');
  assert.equal(envelope.training[0].grade, 'preferred');
  assert.equal(envelope.training[0].explanation, undefined);
  assert.ok(Array.isArray(envelope.trainingAuthority.items));
  assert.equal(envelope.trainingAuthority.items.length, 1);
  assert.equal(envelope.trainingAuthority.items[0].evaluationId, envelope.training[0].evaluationId);
  assert.equal(JSON.stringify(envelope).includes('Ah'), false);
  assert.equal(JSON.stringify(envelope).includes('path'), false);
  assert.equal(envelope.view, undefined);
});

test('ingestHand fail-open when the hand is missing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionToken: 'tok' }));
  const result = await ingestHand({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf('tok'),
    owner: 'owner-1',
  });
  assert.equal(result.ok, false);
});
