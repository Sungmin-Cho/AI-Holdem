import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMistakeBank } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmp() {
  return createOwnedTempDir('holdem-mb');
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
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
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
  const concurrentId = data.items[0].mistakeId.replace(':d-1-preflop-0:', ':d-99-preflop-0:');
  const identity = JSON.parse(data.items[0].evidenceIdentity);
  identity[5] = 'KQo';
  data.items.push({
    ...data.items[0],
    mistakeId: concurrentId,
    evaluationId: concurrentId,
    payloadSha256: 'cc'.repeat(32),
    evidenceIds: [concurrentId],
    evidenceDigests: { [concurrentId]: 'cc'.repeat(32) },
    handClass: 'KQo',
    spotSignature: data.items[0].spotKey + ':KQo',
    evidenceIdentity: JSON.stringify(identity),
    evaluation: { ...data.items[0].evaluation, evaluationId: concurrentId, payloadSha256: 'cc'.repeat(32), handClass: 'KQo' },
  });
  fs.writeFileSync(file, JSON.stringify(data));
});
`, storeDir, bank.file, ready, go], { stdio: ['ignore', 'ignore', 'pipe'] });
  registerOwnedProcess(holder, 'mistake-bank concurrent writer');
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
  assert.equal(items[1].mistakeId, nextEvaluation().evaluationId);
  assert.equal(items[1].payloadSha256, 'cc'.repeat(32));
});

test('bank schema 2 separates game and practice evidence from review state', async () => {
  const storeDir = createOwnedTempDir('bank-origin');
  const bank = createMistakeBank(storeDir, { now: () => '2026-09-06T00:00:00.000Z' });
  const source = {
    id: 'local-preflop-baseline',
    version: '1.0.0',
    contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
  };
  const game = evaluation({ source, origin: 'game' });
  const practice = evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-2-preflop-0',
      providerId: source.id,
      providerVersion: source.version,
    }),
    payloadSha256: 'bb'.repeat(32),
    source,
    origin: 'practice',
  });
  await bank.collect(game);
  await bank.collect(practice);

  const gameEvidence = await bank.listEvidence({ origin: 'game' });
  const practiceEvidence = await bank.listEvidence({ origin: 'practice' });
  assert.equal(JSON.parse(fs.readFileSync(bank.file, 'utf8')).schemaVersion, 2);
  assert.deepEqual(gameEvidence.map((row) => row.evaluationId), [game.evaluationId]);
  assert.deepEqual(practiceEvidence.map((row) => row.evaluationId), [practice.evaluationId]);
  assert.equal(gameEvidence[0].origin, 'game');
  assert.equal(gameEvidence[0].sourceIdentity.contentSha256, source.contentSha256);
  assert.equal(gameEvidence[0].intervalDays, undefined);
  assert.equal(gameEvidence[0].reviewState, undefined);
});

test('mixed and low-frequency choices are absent from the evidence bank', async () => {
  const storeDir = createOwnedTempDir('bank-allowed');
  const bank = createMistakeBank(storeDir);
  for (const [index, grade] of ['mixed', 'low-frequency'].entries()) {
    const result = await bank.collect(evaluation({
      evaluationId: evaluationIdOf({
        gameEpoch: 'ab'.repeat(32),
        decisionId: `d-${index + 20}-preflop-0`,
        providerId: 'local-preflop-baseline',
        providerVersion: '1.0.0',
      }),
      payloadSha256: String(index + 1).repeat(64),
      grade,
    }));
    assert.equal(result.added, false);
  }
  assert.deepEqual(await bank.listEvidence({ origin: 'game' }), []);
});

test('SRS updates cannot mutate origin/source evidence and compatibility update is field-limited', async () => {
  const storeDir = createOwnedTempDir('bank-review-state');
  const bank = createMistakeBank(storeDir);
  const row = evaluation({ origin: 'game' });
  await bank.collect(row);
  const evidenceBefore = await bank.listEvidence({ origin: 'game' });

  await bank.updateReviewState(row.evaluationId, {
    lastReviewedAt: '2026-09-06T01:00:00.000Z',
    nextReviewAt: '2026-09-07T01:00:00.000Z',
    intervalDays: 1,
    ease: 2.3,
    attempts: 1,
    correctStreak: 0,
    lapses: 1,
  });
  assert.deepEqual(await bank.listEvidence({ origin: 'game' }), evidenceBefore);
  const composed = await bank.list();
  assert.equal(composed[0].reviewState.intervalDays, 1);
  await assert.rejects(
    () => bank.update(row.evaluationId, { evaluation: { grade: 'preferred' } }),
    { code: 'MISTAKE_UPDATE_FORBIDDEN' },
  );
  assert.deepEqual(await bank.listEvidence({ origin: 'game' }), evidenceBefore);
});

test('schema 1 migrates to schema 2 with original ids and digests intact', async () => {
  const storeDir = createOwnedTempDir('bank-v1-migrate');
  const bank = createMistakeBank(storeDir);
  const row = evaluation({ origin: 'game' });
  await bank.collect(row);
  const legacy = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
  legacy.schemaVersion = 1;
  fs.writeFileSync(bank.file, JSON.stringify(legacy));

  const evidence = await createMistakeBank(storeDir).listEvidence({ origin: 'game' });

  assert.equal(JSON.parse(fs.readFileSync(bank.file, 'utf8')).schemaVersion, 2);
  assert.equal(evidence[0].evaluationId, row.evaluationId);
  assert.equal(evidence[0].payloadSha256, row.payloadSha256);
});

test('a frozen schema-1 reader rejects bank 2 without modifying its bytes', async () => {
  const storeDir = createOwnedTempDir('bank-old-reader');
  const file = path.join(storeDir, 'mistakes.json');
  const raw = `${JSON.stringify({ schemaVersion: 2, evidence: [], reviewState: {} })}\n`;
  fs.writeFileSync(file, raw);
  const frozenSchema1Reader = () => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schemaVersion !== 1) {
      const error = new Error(`schema ${value.schemaVersion}`);
      error.code = 'UNSUPPORTED_MISTAKES';
      throw error;
    }
    return value;
  };

  assert.throws(frozenSchema1Reader, { code: 'UNSUPPORTED_MISTAKES' });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('same evidence identity with a conflicting digest fails without rewriting bank bytes', async () => {
  const storeDir = createOwnedTempDir('bank-digest-conflict');
  const bank = createMistakeBank(storeDir);
  const first = evaluation();
  await bank.collect(first);
  const secondId = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId: 'd-33-preflop-0',
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  await bank.collect(evaluation({ evaluationId: secondId, payloadSha256: 'bb'.repeat(32) }));
  const before = fs.readFileSync(bank.file);

  await assert.rejects(
    () => bank.collect(evaluation({ evaluationId: secondId, payloadSha256: 'cc'.repeat(32) })),
    { code: 'MISTAKE_EVIDENCE_CONFLICT' },
  );
  assert.deepEqual(fs.readFileSync(bank.file), before);
});

test('review state rejects invalid dates, counters and non-finite values without writes', async () => {
  const storeDir = createOwnedTempDir('bank-review-invalid');
  const bank = createMistakeBank(storeDir);
  const row = evaluation();
  await bank.collect(row);
  for (const patch of [
    { nextReviewAt: 'not-a-date' },
    { intervalDays: -1 },
    { attempts: 1.5 },
    { ease: Number.NaN },
    { lapses: {} },
  ]) {
    const before = fs.readFileSync(bank.file);
    await assert.rejects(() => bank.updateReviewState(row.evaluationId, patch), {
      code: 'MISTAKE_UPDATE_INVALID',
    });
    assert.deepEqual(fs.readFileSync(bank.file), before);
  }
});

test('schema 1 migration validates duplicate evidence and schedules before its only write', async () => {
  for (const mode of ['duplicate', 'schedule']) {
    const storeDir = createOwnedTempDir(`bank-v1-atomic-${mode}`);
    const bank = createMistakeBank(storeDir);
    fs.mkdirSync(path.dirname(bank.file), { recursive: true });
    const first = {
      schemaVersion: 1,
      mistakeId: evaluation().evaluationId,
      spotSignature: '6max-100bb-btn-rfi-unopened:AJo',
      skillKey: 'preflop.rfi.BTN',
      evaluation: evaluation(),
      evidenceIds: [evaluation().evaluationId],
      intervalDays: mode === 'schedule' ? -1 : 1,
      ease: 2.3,
      attempts: 0,
      correctStreak: 0,
      lapses: 0,
      nextReviewAt: '2026-09-06T00:00:00.000Z',
    };
    const data = { schemaVersion: 1, items: mode === 'duplicate' ? [first, { ...first }] : [first] };
    fs.writeFileSync(bank.file, JSON.stringify(data));
    const before = fs.readFileSync(bank.file);
    await assert.rejects(() => bank.list());
    assert.deepEqual(fs.readFileSync(bank.file), before);
  }
});

test('missing source digest cannot enter the bank', async () => {
  const storeDir = createOwnedTempDir('bank-unverified-source');
  const bank = createMistakeBank(storeDir);
  const source = { id: 'local-preflop-baseline', version: '1.0.0' };
  assert.deepEqual(await bank.collect(evaluation({ source })), { added: false, item: null });
  assert.equal(fs.existsSync(bank.file), false);
});

function nextEvaluation(overrides = {}) {
  return evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32), decisionId: 'd-99-preflop-0',
      providerId: 'local-preflop-baseline', providerVersion: '1.0.0',
    }),
    payloadSha256: 'bb'.repeat(32),
    ...overrides,
  });
}

async function storedFixture() {
  const bank = createMistakeBank(tmp());
  await bank.collect(evaluation());
  return { bank, data: JSON.parse(fs.readFileSync(bank.file, 'utf8')) };
}

function legacyItem(row = evaluation()) {
  return {
    schemaVersion: 1,
    mistakeId: row.evaluationId,
    evaluation: row,
    spotSignature: `${row.spotKey}:${row.handClass}`,
    skillKey: 'preflop.rfi.BTN',
    evidenceIds: [row.evaluationId],
    evidence: 1,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    nextReviewAt: '2026-09-02T00:00:00.000Z',
    intervalDays: 1,
    ease: 2.3,
    attempts: 0,
    correctStreak: 0,
    lapses: 0,
  };
}

function replaceBank(bank, data) {
  fs.mkdirSync(path.dirname(bank.file), { recursive: true });
  fs.writeFileSync(bank.file, `${JSON.stringify(data, null, 2)}\n`);
  return fs.readFileSync(bank.file);
}

async function rejectsUnchanged(bank, data, operation = () => bank.list()) {
  const before = replaceBank(bank, data);
  await assert.rejects(operation);
  assert.deepEqual(fs.readFileSync(bank.file), before);
}

test('stored authority and every duplicated evidence field are validated before a read can rewrite bytes', async (t) => {
  const corruptions = [
    ['cached reference quality', (item) => { item.referenceQuality = 'solver-verified'; }],
    ['cached availability', (item) => { item.availability = 'unverified'; }],
    ['missing quality cannot repair wrong availability', (item) => {
      delete item.referenceQuality; item.availability = 'unverified';
    }],
    ['missing availability cannot repair wrong quality', (item) => {
      delete item.availability; item.referenceQuality = 'unverified';
    }],
    ['both source hashes removed with self-consistent signature', (item) => {
      delete item.sourceIdentity.contentSha256;
      delete item.evaluation.source.contentSha256;
      const identity = JSON.parse(item.evidenceIdentity);
      identity[3] = null;
      item.evidenceIdentity = JSON.stringify(identity);
    }],
    ['source id', (item) => { item.sourceIdentity.id = 'fake-solver'; }],
    ['source version', (item) => { item.sourceIdentity.version = '9.0.0'; }],
    ['source hash', (item) => { item.sourceIdentity.contentSha256 = 'dd'.repeat(32); }],
    ['nested source missing', (item) => { delete item.evaluation.source; }],
    ['nested source hash missing', (item) => { delete item.evaluation.source.contentSha256; }],
    ['nested origin', (item) => { item.evaluation.origin = 'practice'; }],
    ['unknown origin', (item) => { item.evaluation.origin = 'arbitrary'; }],
    ['item origin', (item) => { item.origin = 'practice'; }],
    ['spot', (item) => { item.spotKey = '6max-100bb-co-rfi-unopened'; }],
    ['hand', (item) => { item.handClass = 'KQo'; }],
    ['legacy signature', (item) => { item.spotSignature = '6max-100bb-btn-rfi-unopened:KQo'; }],
    ['group signature', (item) => { item.evidenceIdentity = 'another-group'; }],
    ['skill', (item) => { item.skillKey = 'preflop.rfi.CO'; }],
    ['primary evaluation id', (item) => { item.evaluationId = nextEvaluation().evaluationId; }],
    ['nested evaluation id', (item) => { item.evaluation.evaluationId = nextEvaluation().evaluationId; }],
    ['primary payload', (item) => { item.payloadSha256 = 'cc'.repeat(32); }],
    ['nested payload', (item) => { item.evaluation.payloadSha256 = 'cc'.repeat(32); }],
    ['primary digest entry', (item) => { item.evidenceDigests[item.mistakeId] = 'cc'.repeat(32); }],
    ['missing primary digest entry', (item) => { delete item.evidenceDigests[item.mistakeId]; }],
    ['primary id absent from evidence ids', (item) => {
      item.evidenceIds = [nextEvaluation().evaluationId];
      item.evidenceDigests = { [nextEvaluation().evaluationId]: 'bb'.repeat(32) };
    }],
    ['duplicate id within item', (item) => { item.evidenceIds.push(item.mistakeId); item.evidence = 2; }],
    ['wrong evidence count', (item) => { item.evidence = 3; }],
    ['malformed evidence ids', (item) => { item.evidenceIds = {}; }],
    ['malformed digest map', (item) => { item.evidenceDigests = []; }],
    ['malformed evaluation', (item) => { item.evaluation = []; }],
    ['malformed source', (item) => { item.sourceIdentity = []; }],
    ['review state embedded in evidence', (item) => { item.reviewState = { attempts: 99 }; }],
    ['schedule embedded in evidence', (item) => { item.attempts = 99; }],
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async () => {
      const { bank, data } = await storedFixture();
      corrupt(data.items[0]);
      await rejectsUnchanged(bank, data);
    });
  }
});

test('all bank entrypoints reject inconsistent authority before any migration or SRS write', async (t) => {
  for (const name of ['list', 'listEvidence', 'stats', 'collect', 'updateReviewState', 'migrateDigests']) {
    await t.test(name, async () => {
      const { bank, data } = await storedFixture();
      delete data.items[0].referenceQuality;
      data.items[0].availability = 'unverified';
      const operations = {
        list: () => bank.list(), listEvidence: () => bank.listEvidence(), stats: () => bank.stats(),
        collect: () => bank.collect(nextEvaluation()),
        updateReviewState: () => bank.updateReviewState(evaluation().evaluationId, { attempts: 1 }),
        migrateDigests: () => bank.migrateDigests({ oldToNew: { ['aa'.repeat(32)]: 'cc'.repeat(32) } }),
      };
      await rejectsUnchanged(bank, data, operations[name]);
    });
  }
});

test('cross-item ids and map keys cannot alias another item or inherited object state', async (t) => {
  const cases = [
    ['duplicate group identity', (data) => {
      const second = data.items[1];
      second.handClass = data.items[0].handClass;
      second.evaluation.handClass = second.handClass;
      second.spotSignature = data.items[0].spotSignature;
      second.evidenceIdentity = data.items[0].evidenceIdentity;
    }],
    ['cross-item evidence id', (data) => {
      const first = data.items[0];
      first.evidenceIds.push(data.items[1].mistakeId);
      first.evidenceDigests[data.items[1].mistakeId] = data.items[1].payloadSha256;
      first.evidence = 2;
    }],
    ['orphan review state', (data) => { data.reviewState[nextEvaluation().evaluationId] = { attempts: 1 }; }],
    ['unsafe review key', (data) => { Object.defineProperty(data.reviewState, '__proto__', { value: {}, enumerable: true }); }],
    ['inherited review key', (data) => { data.reviewState.constructor = { attempts: 1 }; }],
    ['invalid existing review state', (data) => { data.reviewState[data.items[0].mistakeId] = null; }],
    ['invalid metadata', (data) => { data.meta.prunedUnlearnable = -1; }],
    ['unsafe evidence id', (data) => {
      data.items[0].evidenceIds.push('constructor');
      data.items[0].evidence = 2;
    }],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async () => {
      const { bank } = await storedFixture();
      await bank.collect(nextEvaluation({ handClass: 'KQo' }));
      const data = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
      if (name === 'orphan review state') {
        data.items.pop(); delete data.reviewState[nextEvaluation().evaluationId];
      }
      corrupt(data);
      await rejectsUnchanged(bank, data);
    });
  }
});

test('schema 1 rejects malformed top-level and item graphs without replacing legacy bytes', async (t) => {
  const cases = [
    ['null document', null], ['array document', []],
    ['missing items', { schemaVersion: 1 }],
    ['null items', { schemaVersion: 1, items: null }],
    ['object items', { schemaVersion: 1, items: {} }],
    ['string items', { schemaVersion: 1, items: 'lost evidence' }],
    ['null item', { schemaVersion: 1, items: [null] }],
    ['array item', { schemaVersion: 1, items: [[]] }],
    ['missing evaluation', { schemaVersion: 1, items: [{ mistakeId: evaluation().evaluationId }] }],
    ['nested id mismatch', { schemaVersion: 1, items: [{ ...legacyItem(), mistakeId: nextEvaluation().evaluationId }] }],
    ['signature mismatch', { schemaVersion: 1, items: [{ ...legacyItem(), spotSignature: '6max-100bb-co-rfi-unopened:AJo' }] }],
    ['duplicate within legacy item', { schemaVersion: 1, items: [{ ...legacyItem(), evidenceIds: [evaluation().evaluationId, evaluation().evaluationId], evidence: 2 }] }],
    ['invalid legacy evidence ids', { schemaVersion: 1, items: [{ ...legacyItem(), evidenceIds: null }] }],
    ['contradictory compatibility payload', { schemaVersion: 1, items: [{ ...legacyItem(), payloadSha256: 'cc'.repeat(32) }] }],
    ['contradictory compatibility authority', { schemaVersion: 1, items: [{ ...legacyItem(), referenceQuality: 'unverified' }] }],
  ];
  for (const [name, data] of cases) {
    await t.test(name, async () => {
      const bank = createMistakeBank(tmp());
      await rejectsUnchanged(bank, data);
    });
  }
});

test('migration validates a later item before committing earlier backfills or Q4 pruning', async () => {
  const bank = createMistakeBank(tmp());
  const first = legacyItem(evaluation({ spotKey: 'postflop-flop' }));
  const second = legacyItem(nextEvaluation());
  second.evidenceIds = null;
  await rejectsUnchanged(bank, { schemaVersion: 1, items: [first, second] });
});

test('missing compatibility labels are derived from evidence without inventing a source hash', async (t) => {
  for (const verified of [true, false]) {
    await t.test(verified ? 'validated source' : 'unverified legacy source', async () => {
      const row = evaluation();
      if (!verified) delete row.source.contentSha256;
      const bank = createMistakeBank(tmp());
      replaceBank(bank, { schemaVersion: 1, items: [legacyItem(row)] });
      const evidence = await bank.listEvidence();
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].referenceQuality, verified ? 'heuristic-reference' : 'unverified');
      assert.equal(evidence[0].availability, verified ? 'available' : 'unverified');
      assert.deepEqual(evidence[0].evaluation, row);
      assert.equal(evidence[0].payloadSha256, row.payloadSha256);
      assert.equal(evidence[0].sourceIdentity.contentSha256, row.source.contentSha256);
      const data = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
      delete data.items[0].referenceQuality;
      delete data.items[0].availability;
      replaceBank(bank, data);
      assert.equal((await bank.list()).length, verified ? 1 : 0);
      assert.deepEqual(await bank.listEvidence(), evidence);
    });
  }
});

test('legacy allowed, forced and unsupported choices remain diagnostic evidence only', async (t) => {
  for (const overrides of [{ grade: 'preferred' }, { grade: 'mixed' }, { grade: 'low-frequency' }, { forced: true }, { status: 'unsupported' }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const bank = createMistakeBank(tmp());
      const row = evaluation(overrides);
      replaceBank(bank, { schemaVersion: 1, items: [legacyItem(row)] });
      assert.deepEqual(await bank.list(), []);
      assert.equal((await bank.listEvidence())[0].evaluationId, row.evaluationId);
      assert.deepEqual(await bank.list(), []);
    });
  }
});

test('a same-id same-digest collection cannot conceal a different evidence group', async () => {
  const { bank } = await storedFixture();
  const before = fs.readFileSync(bank.file);
  await assert.rejects(() => bank.collect(evaluation({ origin: 'practice' })), { code: 'MISTAKE_EVIDENCE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(bank.file), before);
});

test('digest migration rejects invalid replacements before changing the stored graph', async () => {
  const { bank } = await storedFixture();
  const before = fs.readFileSync(bank.file);
  await assert.rejects(() => bank.migrateDigests({ oldToNew: { ['aa'.repeat(32)]: 'invalid' } }));
  assert.deepEqual(fs.readFileSync(bank.file), before);
});

test('collection validates its complete new evidence graph before creating a bank file', async (t) => {
  for (const overrides of [{ payloadSha256: 'invalid' }, { origin: 'arbitrary' }, { handClass: null }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const bank = createMistakeBank(tmp());
      await assert.rejects(() => bank.collect(evaluation(overrides)));
      assert.equal(fs.existsSync(bank.file), false);
    });
  }
});
