import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMistakeBank } from '../training/mistake-bank.js';
import { evaluationIdOf } from '../training/contracts.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-mb-'));
}

function evaluation(overrides = {}) {
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    grade: 'off-policy',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    ...overrides,
  };
}

test('off-policy is stored once; forced and preferred are skipped; same spot accumulates evidence', async () => {
  const storeDir = tmp();
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-01T00:00:00.000Z' });
  assert.equal((await bank.collect(evaluation())).added, true);
  assert.equal((await bank.collect(evaluation())).added, false);
  assert.equal((await bank.collect(evaluation({ forced: true, evaluationId: evaluationIdOf({
    gameEpoch: 'ab'.repeat(32), decisionId: 'd-2-preflop-0', providerId: 'local-preflop-baseline', providerVersion: '1.0.0',
  }) }))).added, false);
  const second = await bank.collect(evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32), decisionId: 'd-3-preflop-0', providerId: 'local-preflop-baseline', providerVersion: '1.0.0',
    }),
    payloadSha256: 'bb'.repeat(32),
  }));
  assert.equal(second.added, false);
  assert.equal(second.item.evidence, 2);
  assert.ok(Array.isArray(second.item.evidenceIds));
  assert.equal(second.item.evidenceIds.length, 2);
  const again = await bank.collect(evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32), decisionId: 'd-3-preflop-0', providerId: 'local-preflop-baseline', providerVersion: '1.0.0',
    }),
    payloadSha256: 'bb'.repeat(32),
  }));
  assert.equal(again.added, false);
  assert.equal(again.item.evidence, 2);
  assert.deepEqual(again.item.evidenceIds, second.item.evidenceIds);
  const items = await bank.list();
  assert.equal(items.length, 1);
});

test('same evaluationId re-collect leaves evidence bytes unchanged', async () => {
  const storeDir = tmp();
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-01T00:00:00.000Z' });
  const first = evaluation();
  await bank.collect(first);
  const secondId = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId: 'd-3-preflop-0',
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  await bank.collect(evaluation({
    evaluationId: secondId,
    payloadSha256: 'bb'.repeat(32),
  }));
  const before = fs.readFileSync(bank.file);
  const again = await bank.collect(evaluation({
    evaluationId: secondId,
    payloadSha256: 'bb'.repeat(32),
  }));
  assert.equal(again.added, false);
  assert.deepEqual(fs.readFileSync(bank.file), before);
  assert.equal(again.item.evidence, 2);
  assert.deepEqual(again.item.evidenceIds, [first.evaluationId, secondId]);
});
