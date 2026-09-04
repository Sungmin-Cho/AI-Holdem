import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonical } from '../export/manifest.js';
import { formatTrainingCard } from '../server/public/training-format.js';
import { validateExplanation } from '../training/explain.js';
import { generateQueue as buildQueue } from '../training/drill-generator.js';
import { classifyOpportunity, skillKeyOf } from '../training/opportunities.js';
import { evaluateSolvedDecision } from '../training/postflop/solved-decision.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl } from '../tools/training-control.js';
import { createMistakeBank, createProfileStore } from '../tools/training-stores.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRILL_CLI = path.join(ROOT, 'tools', 'drill-cli.js');
const EPOCH = 'ab'.repeat(32);
const SOURCE = { id: 'local-preflop-baseline', version: '1.0.0' };

function tmp(prefix = 'holdem-q4-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function solvedEvaluation(decisionId = 'd-3-flop-0') {
  return evaluateSolvedDecision({
    schemaVersion: 1,
    decisionId,
    street: 'flop',
    holeCards: ['Ah', 'Ad'],
    blinds: [50, 100],
    chosenAction: { action: 'check', amount: 0 },
    forced: false,
  }, {
    schemaVersion: 1,
    accuracy: 'heuristic',
    evBb: null,
    providerId: 'fake-solver',
    providerVersion: '1.0.0',
    actions: [
      { action: 'bet', sizeBb: 0.5, frequency: 1 },
      { action: 'check', frequency: 0 },
    ],
  }, { gameEpoch: EPOCH });
}

function preflopEvaluation(decisionId = 'd-1-preflop-0', overrides = {}) {
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: EPOCH,
      decisionId,
      providerId: SOURCE.id,
      providerVersion: SOURCE.version,
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.85, evBb: null }],
    chosen: { action: 'fold', frequency: 0.15, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'off-policy',
    forced: false,
    source: SOURCE,
    payloadSha256: '11'.repeat(32),
    ...overrides,
  };
}

function bankItem({
  mistakeId = 'm1',
  spotSignature = '6max-100bb-btn-rfi-unopened:AJo',
  skillKey = 'preflop.rfi.BTN',
} = {}) {
  return {
    schemaVersion: 1,
    mistakeId,
    spotSignature,
    skillKey,
    evaluation: preflopEvaluation(),
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastReviewedAt: null,
    nextReviewAt: '2026-09-01T00:00:00.000Z',
    intervalDays: 1,
    ease: 2.3,
    attempts: 0,
    correctStreak: 0,
    lapses: 0,
    evidence: 1,
    evidenceIds: [mistakeId],
  };
}

function writeBank(storeDir, data) {
  const dir = path.join(storeDir, '.training');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mistakes.json'), JSON.stringify(data));
}

function runDrill(args) {
  return JSON.parse(execFileSync(process.execPath, [DRILL_CLI, ...args], {
    encoding: 'utf8',
  }).trim());
}

test('S2 ① solved postflop opportunities are explicitly not learnable', () => {
  const solved = solvedEvaluation();
  const classified = classifyOpportunity(solved);
  assert.equal(classified.skillKey, 'postflop.flop');
  assert.equal(classified.learnable, false);
  assert.equal(skillKeyOf({ spotKey: solved.spotKey }).startsWith('preflop.'), false);

  for (const street of ['flop', 'turn', 'river']) {
    const other = classifyOpportunity({ ...solved, street, spotKey: null });
    assert.equal(other.skillKey, `postflop.${street}`);
    assert.equal(other.learnable, false);
  }
  assert.deepEqual(
    {
      skillKey: classifyOpportunity({ street: 'preflop', spotKey: 'bad-spot' }).skillKey,
      learnable: classifyOpportunity({ street: 'preflop', spotKey: 'bad-spot' }).learnable,
    },
    { skillKey: 'preflop.unknown', learnable: true },
  );
  assert.equal(classifyOpportunity({ street: 'preflop' }).skillKey, 'preflop.unknown');
});

test('S2 ② profile apply returns NOT_LEARNABLE without changing either store file or active segment', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  await store.apply(preflopEvaluation());
  const beforeProfile = fs.readFileSync(store.profilePath);
  const beforeEvents = fs.readFileSync(store.eventsPath);

  const result = await store.apply({
    ...solvedEvaluation(),
    payloadSha256: '22'.repeat(32),
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'NOT_LEARNABLE');
  assert.equal(result.profile.activeSegmentId, `${SOURCE.id}@${SOURCE.version}`);
  assert.deepEqual(fs.readFileSync(store.profilePath), beforeProfile);
  assert.deepEqual(fs.readFileSync(store.eventsPath), beforeEvents);
});

test('S2 ③ mistake bank refuses an otherwise collectable postflop solve result', async () => {
  const bank = createMistakeBank(tmp());
  const result = await bank.collect({
    ...solvedEvaluation(),
    payloadSha256: '22'.repeat(32),
  });
  assert.deepEqual(result, { added: false, item: null });
  assert.deepEqual(await bank.list(), []);
});

for (const mode of ['mistake-review', 'daily']) {
  test(`S2 ④ ${mode} skips invalid signatures and preserves the queue array contract`, () => {
    const mistakes = [
      bankItem({
        mistakeId: 'postflop',
        spotSignature: 'postflop-flop:AA',
        skillKey: 'preflop.other.UNK',
      }),
      bankItem({ mistakeId: 'preflop' }),
    ];
    const queue = buildQueue({
      mode,
      mistakes,
      now: '2026-09-04T00:00:00.000Z',
      source: SOURCE,
    });
    assert.equal(Array.isArray(queue), true);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].prompt.spotKey, '6max-100bb-btn-rfi-unopened');
    assert.equal(queue[0].prompt.position, 'BTN');
  });
}

test('S2 ⑤ an unsupported spot cannot fall back to a BTN drill question', () => {
  assert.throws(() => buildQueue({
    mode: 'free',
    spotKey: 'postflop-flop',
    source: SOURCE,
  }), { code: 'UNSUPPORTED_SPOT' });
});

test('S2 ⑥ NOT_LEARNABLE is a terminal profiled/banked skip and replay is a no-op', async () => {
  const storeDir = tmp();
  const sessionDir = path.join(storeDir, 'session');
  fs.mkdirSync(sessionDir);
  const tc = createTrainingControl({ storeDir });
  const solved = solvedEvaluation();
  await tc.acceptEvaluations(sessionDir, {
    gameEpoch: EPOCH,
    owner: 'owner-q4',
    handNo: 3,
    evaluations: [solved],
  });

  const trainingDir = path.join(storeDir, '.training');
  fs.mkdirSync(path.join(trainingDir, 'mistakes.json'), { recursive: true });
  const first = await tc.consumeTrainingItems(sessionDir, { storeDir });
  const afterFirst = tc.loadAuthority(sessionDir);
  const consumers = afterFirst.items[solved.evaluationId].consumers;

  assert.deepEqual(first, { profiled: 1, banked: 1, applied: 0, failed: 0 });
  assert.equal(consumers.profiled, true);
  assert.equal(consumers.banked, true);
  assert.equal(consumers.skipReason, 'NOT_LEARNABLE');
  assert.equal(fs.existsSync(path.join(trainingDir, 'profile.json')), false);
  assert.equal(fs.existsSync(path.join(trainingDir, 'profile-events.jsonl')), false);

  fs.mkdirSync(path.join(trainingDir, 'profile.json'));
  const second = await tc.consumeTrainingItems(sessionDir, { storeDir });
  assert.deepEqual(second, { profiled: 0, banked: 0, applied: 0, failed: 0 });
});

test('S2 ⑦ a solve result remains present in canonical export evaluations', () => {
  const gameDir = tmp();
  const solved = solvedEvaluation();
  const record = {
    handNo: 3,
    button: 'user',
    blinds: [25, 50],
    startStacks: { user: 5000, p1: 5000 },
    endStacks: { user: 5000, p1: 5000 },
    holes: { user: ['Ah', 'Ad'] },
    board: [],
    actions: [],
    pots: [],
    posts: [],
    uncalledReturns: {},
    allIn: [],
    folded: [],
  };
  fs.mkdirSync(path.join(gameDir, 'hands'));
  fs.writeFileSync(path.join(gameDir, 'hands', 'hand-0003.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(gameDir, 'state.json'), JSON.stringify({
    gameEpoch: EPOCH,
    config: { mode: 'tournament' },
    seats: [{ playerId: 'user' }, { playerId: 'p1' }],
  }));

  const canonical = buildCanonical(gameDir, { evaluationsByHand: { 3: [solved] } });
  assert.deepEqual(canonical.hands[0].evaluations, [solved]);
});

test('schema 2 load rebuilds from canonical ids, preserves preflop unknown and processed ids, and drops polluted postflop skills', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.dirname(store.profilePath), { recursive: true });
  const preflopId = evaluationIdOf({
    gameEpoch: EPOCH,
    decisionId: 'd-2-preflop-0',
    providerId: SOURCE.id,
    providerVersion: SOURCE.version,
  });
  const flopId = evaluationIdOf({
    gameEpoch: EPOCH,
    decisionId: 'd-3-flop-0',
    providerId: 'fake-solver',
    providerVersion: '1.0.0',
  });
  const preflopDigest = '33'.repeat(32);
  const flopDigest = '44'.repeat(32);
  const events = [
    {
      evaluationId: preflopId,
      payloadSha256: preflopDigest,
      skillKey: 'preflop.unknown',
      status: 'unsupported',
      grade: null,
      forced: false,
      evLossBb: null,
      providerId: SOURCE.id,
      providerVersion: SOURCE.version,
      appliedAt: '2026-09-02T00:00:00.000Z',
    },
    {
      evaluationId: flopId,
      payloadSha256: flopDigest,
      skillKey: 'preflop.other.UNK',
      status: 'supported',
      grade: 'off-policy',
      forced: false,
      evLossBb: null,
      providerId: 'fake-solver',
      providerVersion: '1.0.0',
      appliedAt: '2026-09-03T00:00:00.000Z',
    },
  ];
  fs.writeFileSync(store.eventsPath, `${events.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt: '2026-09-03T00:00:00.000Z',
    processed: { [preflopId]: preflopDigest, [flopId]: flopDigest },
    overall: { evaluatedDecisions: 1, supportedDecisions: 1 },
    skills: { 'preflop.other.UNK': { opportunities: 1, supported: 1 } },
    leaks: [],
    coverageGaps: [],
    segments: {},
    activeSegmentId: 'fake-solver@1.0.0',
    hasGameEvents: true,
  }));

  const profile = await store.show();
  assert.equal(profile.schemaVersion, 3);
  assert.equal(profile.activeSegmentId, `${SOURCE.id}@${SOURCE.version}`);
  assert.equal(profile.skills['preflop.unknown'].opportunities, 1);
  assert.equal(profile.skills['preflop.other.UNK'], undefined);
  assert.equal(Object.keys(profile.skills).some((key) => key.startsWith('postflop.')), false);
  assert.equal(profile.segments['fake-solver@1.0.0'], undefined);
  assert.equal(profile.processed[preflopId], preflopDigest);
  assert.equal(profile.processed[flopId], flopDigest);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 3);
  assert.deepEqual(disk.processed, profile.processed);
});

test('schema 2 rebuild fails closed on a non-canonical evaluationId', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.dirname(store.profilePath), { recursive: true });
  const row = {
    evaluationId: 'not-a-canonical-evaluation-id',
    payloadSha256: '55'.repeat(32),
    skillKey: 'preflop.unknown',
    status: 'unsupported',
    grade: null,
    forced: false,
    evLossBb: null,
    providerId: SOURCE.id,
    providerVersion: SOURCE.version,
    appliedAt: '2026-09-02T00:00:00.000Z',
  };
  fs.writeFileSync(store.eventsPath, `${JSON.stringify(row)}\n`);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 2,
    processed: { [row.evaluationId]: row.payloadSha256 },
    segments: {},
  }));

  await assert.rejects(() => store.show(), { code: 'PROFILE_EVENT_INVALID' });
  assert.equal(JSON.parse(fs.readFileSync(store.profilePath, 'utf8')).schemaVersion, 2);
});

test('new schema 3 profile events persist street additively', async () => {
  const store = createProfileStore(tmp());
  const result = await store.apply(preflopEvaluation());
  const [event] = fs.readFileSync(store.eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(result.profile.schemaVersion, 3);
  assert.equal(event.street, 'preflop');
});

test('mistake load prunes invalid signatures and persists cumulative stats while list remains an array', async () => {
  const storeDir = tmp();
  const prunedAt = '2026-09-04T01:02:03.000Z';
  writeBank(storeDir, {
    schemaVersion: 1,
    items: [
      bankItem({ mistakeId: 'valid' }),
      bankItem({
        mistakeId: 'polluted',
        spotSignature: 'postflop-flop:AA',
        skillKey: 'preflop.other.UNK',
      }),
    ],
    meta: { prunedUnlearnable: 2, prunedAt: '2026-09-03T00:00:00.000Z' },
  });
  const bank = createMistakeBank(storeDir, { now: () => prunedAt });

  const items = await bank.list();
  assert.equal(Array.isArray(items), true);
  assert.deepEqual(items.map((item) => item.mistakeId), ['valid']);
  assert.deepEqual(await bank.stats(), { prunedUnlearnable: 3, prunedAt });
  const disk = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
  assert.equal(disk.meta.prunedUnlearnable, 3);
  assert.equal(disk.meta.prunedAt, prunedAt);
  await bank.list();
  assert.equal(JSON.parse(fs.readFileSync(bank.file, 'utf8')).meta.prunedUnlearnable, 3);
});

test('drill-cli start surfaces one persisted prune notice and keeps session.queue an array', () => {
  const storeDir = tmp();
  writeBank(storeDir, {
    schemaVersion: 1,
    items: [bankItem({
      mistakeId: 'polluted',
      spotSignature: 'postflop-flop:AA',
      skillKey: 'preflop.other.UNK',
    })],
  });

  const started = runDrill([
    'start', '--store-dir', storeDir, '--mode', 'mistake-review', '--seed', 'q4',
  ]);
  assert.deepEqual(started.notices, ['postflop 항목 1건은 드릴 대상이 아닙니다']);
  assert.equal(Array.isArray(started.session.queue), true);
  assert.equal(started.session.queue.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(storeDir, '.training', 'mistakes.json'),
    'utf8',
  )).meta.prunedUnlearnable, 1);
});

const supportedWithoutEv = {
  status: 'supported',
  handNo: 17,
  chosen: { action: 'fold', frequency: 0.04, evBb: null },
  recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96, evBb: null }],
};

test('M11 supported branch rejects handNo inside an EV clause but permits it outside', () => {
  assert.deepEqual(
    validateExplanation(supportedWithoutEv, 'EV loss 17'),
    { ok: false, code: 'NUMBER_CONTRADICTION' },
  );
  assert.deepEqual(validateExplanation(supportedWithoutEv, '핸드 17'), { ok: true });
});

test('M11 unsupported branch rejects handNo inside an EV clause but permits it outside', () => {
  const unsupported = { status: 'unsupported', handNo: 17, code: 'UNSUPPORTED_SPOT' };
  assert.deepEqual(
    validateExplanation(unsupported, 'EV loss 17'),
    { ok: false, code: 'NUMBER_CONTRADICTION' },
  );
  assert.deepEqual(validateExplanation(unsupported, '핸드 17'), { ok: true });
});

test('postflop training cards say they are excluded from learning aggregation', () => {
  const card = formatTrainingCard({
    ...solvedEvaluation(),
    handNo: 3,
    chosen: { action: 'check', frequency: 0 },
  });
  assert.match(card.note, /학습 집계 제외\(postflop\)/);
});

test('canonical flop evaluationId cannot become learnable when street is omitted', async () => {
  const disguised = preflopEvaluation('d-3-flop-0');
  delete disguised.street;
  const classified = classifyOpportunity(disguised);
  assert.deepEqual(
    { street: classified.street, skillKey: classified.skillKey, learnable: classified.learnable },
    { street: 'flop', skillKey: 'postflop.flop', learnable: false },
  );

  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const applied = await store.apply(disguised);
  assert.equal(applied.reason, 'NOT_LEARNABLE');
  assert.equal(fs.existsSync(store.eventsPath), false);
  assert.equal(fs.existsSync(store.profilePath), false);
});

test('NOT_LEARNABLE against a valid schema 2 profile is byte-for-byte read-only', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.dirname(store.profilePath), { recursive: true });
  const row = {
    evaluationId: preflopEvaluation().evaluationId,
    payloadSha256: '66'.repeat(32),
    skillKey: 'preflop.rfi.BTN',
    status: 'supported',
    grade: 'off-policy',
    forced: false,
    evLossBb: null,
    providerId: SOURCE.id,
    providerVersion: SOURCE.version,
    appliedAt: '2026-09-02T00:00:00.000Z',
  };
  fs.writeFileSync(store.eventsPath, `${JSON.stringify(row)}\n`);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 2,
    processed: { [row.evaluationId]: row.payloadSha256 },
    segments: {},
  }));
  const profileBefore = fs.readFileSync(store.profilePath);
  const eventsBefore = fs.readFileSync(store.eventsPath);

  const result = await store.apply(solvedEvaluation());

  assert.equal(result.reason, 'NOT_LEARNABLE');
  assert.equal(result.profile.schemaVersion, 3);
  assert.deepEqual(fs.readFileSync(store.profilePath), profileBefore);
  assert.deepEqual(fs.readFileSync(store.eventsPath), eventsBefore);
});

test('digest migration validates malformed evaluation ids before rewriting events', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.dirname(store.eventsPath), { recursive: true });
  const oldDigest = '77'.repeat(32);
  const row = {
    evaluationId: 'malformed-evaluation-id',
    payloadSha256: oldDigest,
    skillKey: 'preflop.unknown',
    status: 'unsupported',
    grade: null,
    forced: false,
    evLossBb: null,
    providerId: SOURCE.id,
    providerVersion: SOURCE.version,
    appliedAt: '2026-09-02T00:00:00.000Z',
  };
  fs.writeFileSync(store.eventsPath, `${JSON.stringify(row)}\n`);
  const before = fs.readFileSync(store.eventsPath);

  await assert.rejects(
    store.migrateDigests({ oldToNew: { [oldDigest]: '88'.repeat(32) } }),
    { code: 'PROFILE_EVENT_INVALID' },
  );
  assert.deepEqual(fs.readFileSync(store.eventsPath), before);
  assert.equal(fs.existsSync(store.profilePath), false);
});

test('leak mode never fabricates a BTN question when no valid leak exists', () => {
  assert.deepEqual(buildQueue({ mode: 'leak', profile: { leaks: [] }, source: SOURCE }), []);
  assert.deepEqual(buildQueue({
    mode: 'leak',
    profile: { leaks: [{ id: 'not-a-training-skill' }] },
    source: SOURCE,
  }), []);
});

test('M11 rejects every number in supported EV clauses even when EV data exists', () => {
  const supportedWithEv = {
    ...supportedWithoutEv,
    chosen: { ...supportedWithoutEv.chosen, evBb: -0.9 },
    recommended: [{ ...supportedWithoutEv.recommended[0], evBb: 0.1 }],
  };
  for (const explanation of ['EV loss 17', 'raise EV 96%']) {
    assert.deepEqual(
      validateExplanation(supportedWithEv, explanation),
      { ok: false, code: 'NUMBER_CONTRADICTION' },
    );
  }
});

test('postflop UI exclusion label follows street when spotKey is absent', () => {
  const card = formatTrainingCard({
    ...solvedEvaluation(),
    street: 'flop',
    spotKey: null,
    handNo: 3,
    chosen: { action: 'check', frequency: 0 },
  });
  assert.match(card.note, /학습 집계 제외\(postflop\)/);
});
