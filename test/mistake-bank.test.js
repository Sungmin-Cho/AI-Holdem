import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMistakeBank } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function waitForFile(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', resolve));
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

test('same mistakeId persists a missing legacy evidenceIds backfill', async () => {
  const storeDir = tmp();
  const first = evaluation();
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-01T00:00:00.000Z' });
  await bank.collect(first);
  const legacy = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
  delete legacy.items[0].evidenceIds;
  fs.writeFileSync(bank.file, JSON.stringify(legacy));

  const result = await bank.collect(first);
  const reloaded = await createMistakeBank(storeDir).list();

  assert.equal(result.added, false);
  assert.deepEqual(reloaded[0].evidenceIds, [first.evaluationId]);
});

test('digest migration shares mistakes.lock.d with collect-style rewrites and skips unchanged bytes', { timeout: 10_000 }, async () => {
  const storeDir = tmp();
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-01T00:00:00.000Z' });
  const first = evaluation();
  await bank.collect(first);
  const stableBefore = fs.readFileSync(bank.file);
  assert.deepEqual(await bank.migrateDigests(), { changed: false });
  assert.deepEqual(fs.readFileSync(bank.file), stableBefore);

  const ready = path.join(storeDir, 'holder-ready');
  const go = path.join(storeDir, 'holder-go');
  const stateModule = pathToFileURL(path.join(ROOT, 'engine', 'state.js')).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
import path from 'node:path';
import { withNamedLock } from ${JSON.stringify(stateModule)};
const [storeDir, file, ready, go] = process.argv.slice(1);
await withNamedLock(path.join(storeDir, '.training'), 'mistakes.lock.d', async () => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(ready, 'ready');
  while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 200));
  data.items.push({ ...data.items[0], mistakeId: 'concurrent-id' });
  fs.writeFileSync(file, JSON.stringify(data));
});
`, storeDir, bank.file, ready, go], { stdio: ['ignore', 'ignore', 'pipe'] });
  let holderStderr = '';
  holder.stderr.on('data', (chunk) => { holderStderr += chunk; });
  await waitForFile(ready);
  fs.writeFileSync(go, 'go');

  const migrated = await bank.migrateDigests({
    oldToNew: { [first.payloadSha256]: 'bb'.repeat(32) },
  });
  assert.equal(await waitForExit(holder), 0, holderStderr);
  assert.deepEqual(migrated, { changed: true });
  const items = JSON.parse(fs.readFileSync(bank.file, 'utf8')).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].evaluation.payloadSha256, 'bb'.repeat(32));
  assert.equal(items[1].mistakeId, 'concurrent-id');
});
