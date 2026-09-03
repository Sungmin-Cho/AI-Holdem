import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOpponentNote, readOpponentNotes, rewriteOpponentNotesForbidden, readAccuracy } from '../tools/training-stores.js';
import { labelsForDeviation } from '../training/exploit/adjustments.js';
import { policyById } from '../training/policies/catalog.js';

test('notes freeze at write time and cannot be rewritten', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-notes-'));
  const first = await writeOpponentNote(store, {
    playerId: 'p1',
    atHandNo: 3,
    observations: ['calls-too-wide'],
    confidence: 0.6,
    writtenAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(first.atHandNo, 3);
  const again = readOpponentNotes(store);
  assert.equal(again.length, 1);
  assert.deepEqual(again[0].observations, ['calls-too-wide']);
  await assert.rejects(() => rewriteOpponentNotesForbidden(store), { code: 'NOTE_IMMUTABLE' });
  assert.equal(readOpponentNotes(store)[0].writtenAt, '2026-09-01T00:00:00.000Z');
});

test('read accuracy splits hit/miss/wrong against actual deviations', () => {
  const labels = policyById('calling-station-v1').deviations.flatMap(labelsForDeviation);
  const report = readAccuracy([
    { observations: ['calls-too-wide', 'underbluffs-river'] },
  ], labels);
  assert.deepEqual(report.hit, ['calls-too-wide']);
  assert.ok(report.wrong.includes('underbluffs-river'));
});
