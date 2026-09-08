import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createProfileStore } from '../tools/training-stores.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';

function tmp() {
  return createOwnedTempDir('holdem-profile');
}

function evaluation(overrides = {}) {
  return {
    ...(overrides.origin==='practice'?{assistance:{schemaVersion:1,hintShown:false,exposureId:null}}:{}),
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: 'aa'.repeat(32),
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    grade: 'preferred',
    forced: false,
    evLossBb: null,
    source: {
      id: 'local-preflop-baseline', version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
    ...overrides,
  };
}

test('readEventSnapshot shares the profile lock and reads committed validated events without writes', async () => {
  const store = createProfileStore(tmp());
  await store.apply(evaluation());
  assert.equal(typeof store.readEventSnapshot, 'function');
  const original = JSON.parse(fs.readFileSync(store.eventsPath, 'utf8').trim());
  const second = { ...original, evaluationId: evaluationIdOf({ gameEpoch: 'cd'.repeat(32), decisionId: 'd-2-preflop-0', providerId: original.providerId, providerVersion: original.providerVersion }), payloadSha256: 'bb'.repeat(32) };
  fs.appendFileSync(store.eventsPath, JSON.stringify(second));
  const beforeProfile = fs.readFileSync(store.profilePath);
  const beforeEvents = fs.readFileSync(store.eventsPath);
  assert.deepEqual(await store.readEventSnapshot(), [original]);
  assert.deepEqual(fs.readFileSync(store.eventsPath), beforeEvents);
  assert.deepEqual(fs.readFileSync(store.profilePath), beforeProfile);
  const ready = path.join(store.root, 'snapshot-holder-ready');
  const holder = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { withNamedLock } from ${JSON.stringify(pathToFileURL(path.resolve('engine/state.js')).href)};
    const [root, events, ready] = process.argv.slice(1);
    await withNamedLock(root, 'profile.lock.d', async () => {
      fs.writeFileSync(ready, 'ready');
      await new Promise((resolve) => setTimeout(resolve, 500));
      fs.appendFileSync(events, '\\n');
    });
  `, store.root, store.eventsPath, ready], { stdio: ['ignore', 'ignore', 'pipe'] }), 'profile snapshot lock holder');
  let stderr = '';
  holder.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => holder.once('exit', resolve));
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, stderr);
  const started = Date.now();
  assert.deepEqual(await store.readEventSnapshot(), [original, second]);
  assert.ok(Date.now() - started >= 100, 'snapshot must wait for the profile writer lock');
  assert.equal(await exit, 0, stderr);
  assert.deepEqual(fs.readFileSync(store.profilePath), beforeProfile);
});

test('event snapshot rejects future, noncanonical and conflicting metadata without repairing files', async (t) => {
  for (const kind of ['schema', 'id', 'digest', 'metadata']) await t.test(kind, async () => {
    const store = createProfileStore(tmp()); await store.apply(evaluation());
    assert.equal(typeof store.readEventSnapshot, 'function');
    const original = JSON.parse(fs.readFileSync(store.eventsPath, 'utf8').trim());
    const row = structuredClone(original);
    if (kind === 'schema') row.schemaVersion = 99;
    if (kind === 'id') row.evaluationId = 'bad-id';
    if (kind === 'digest') row.payloadSha256 = 'bad-digest';
    if (kind === 'metadata') row.origin = 'practice';
    fs.appendFileSync(store.eventsPath, `${JSON.stringify(row)}\n`);
    const beforeProfile = fs.readFileSync(store.profilePath), beforeEvents = fs.readFileSync(store.eventsPath);
    await assert.rejects(() => store.readEventSnapshot());
    assert.deepEqual(fs.readFileSync(store.eventsPath), beforeEvents);
    assert.deepEqual(fs.readFileSync(store.profilePath), beforeProfile);
  });
});

test('same-id same-digest apply rejects changed learning metadata before writes', async () => {
  const store = createProfileStore(tmp()); await store.apply(evaluation());
  const beforeProfile = fs.readFileSync(store.profilePath), beforeEvents = fs.readFileSync(store.eventsPath);
  await assert.rejects(() => store.apply(evaluation({ origin: 'practice' })), { code: 'PROFILE_EVENT_CONFLICT' });
  assert.deepEqual(fs.readFileSync(store.eventsPath), beforeEvents);
  assert.deepEqual(fs.readFileSync(store.profilePath), beforeProfile);
});

test('profile lives under store/.training and survives a torn jsonl tail', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  await store.apply(evaluation());
  const profilePath = path.join(storeDir, '.training', 'profile.json');
  const eventsPath = path.join(storeDir, '.training', 'profile-events.jsonl');
  if (process.platform !== 'win32') {
    assert.equal(fs.lstatSync(path.join(storeDir, '.training')).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(profilePath).mode & 0o777, 0o600);
  }
  fs.appendFileSync(eventsPath, '{"partial":true');
  const rebuilt = await store.rebuild();
  assert.equal(rebuilt.overall.evaluatedDecisions, 1);
  await store.apply(evaluation());
  assert.equal((await store.show()).overall.evaluatedDecisions, 1);
});

test('apply returns {applied}; missing payloadSha256 is PROFILE_EVENT_INVALID', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = await store.apply(evaluation());
  assert.equal(first.applied, true);
  const again = await store.apply(evaluation());
  assert.equal(again.applied, false);
  await assert.rejects(() => store.apply(evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-2-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: undefined,
  })), {
    code: 'PROFILE_EVENT_INVALID',
  });
});

test('new profile persist uses schemaVersion 6', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = await store.apply(evaluation());
  assert.equal(first.profile.schemaVersion, 6);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 6);
  assert.equal(disk.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
});

test('schema 1 profile is rebuilt from events as schema 6 and is not returned raw', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = evaluation();
  const second = evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    source: { id: 'local-preflop-baseline', version: '2.0.0' },
  });
  await store.apply(first);
  await store.apply(second);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    processed: {
      [first.evaluationId]: first.payloadSha256,
      [second.evaluationId]: second.payloadSha256,
    },
    overall: {
      evaluatedDecisions: 2,
      supportedDecisions: 2,
      unsupportedDecisions: 0,
      forfeits: 0,
      preferred: 2,
      offPolicy: 0,
      evLossBb: null,
      evLossBbPer100: null,
    },
    skills: {
      'preflop.rfi.BTN': { opportunities: 2, supported: 2, preferred: 2, offPolicy: 0 },
    },
    leaks: [],
    segments: {
      'local-preflop-baseline@1.0.0': { evaluatedDecisions: 1, supportedDecisions: 1 },
      'local-preflop-baseline@2.0.0': { evaluatedDecisions: 1, supportedDecisions: 1 },
    },
  }));
  const shown = await store.show();
  assert.equal(shown.schemaVersion, 6);
  assert.equal(shown.activeSegmentId, 'local-preflop-baseline@1.0.0');
  assert.equal(shown.overall.evaluatedDecisions, 1);
  assert.equal(shown.segments['local-preflop-baseline@1.0.0'].overall.evaluatedDecisions, 1);
  assert.equal(shown.segments['local-preflop-baseline@2.0.0'], undefined);
  assert.equal(shown.game.coverage.unverifiedDecisions, 1);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 6);
  assert.equal(disk.overall.evaluatedDecisions, 1);
});

test('schema 1 load fails closed when events cannot support the nested schema', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true, mode: 0o700 });
  const row = evaluation();
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    processed: { [row.evaluationId]: row.payloadSha256 },
    overall: { evaluatedDecisions: 2 },
    skills: {},
    leaks: [],
    segments: {},
  }));
  await assert.rejects(() => store.show(), { code: 'UNSUPPORTED_PROFILE' });

  fs.writeFileSync(store.eventsPath, `${JSON.stringify({
    evaluationId: row.evaluationId,
    skillKey: 'preflop.rfi.BTN',
    status: 'supported',
    grade: 'preferred',
    forced: false,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
    appliedAt: '2026-09-01T00:00:00.000Z',
  })}\n`);
  await assert.rejects(() => store.show(), { code: 'PROFILE_EVENT_INVALID' });
});

test('schema 1 processed digest mismatch fails closed without writing schema 4', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const row = evaluation();
  await store.apply(row);
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    processed: { [row.evaluationId]: 'ff'.repeat(32) },
    overall: { evaluatedDecisions: 1 },
    skills: {},
    leaks: [],
    segments: {},
  }));
  await assert.rejects(() => store.show(), { code: 'UNSUPPORTED_PROFILE' });
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 1);
});

test('schema 1 event with unsafe skillKey fails closed', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const row = evaluation();
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(store.profilePath, JSON.stringify({
    schemaVersion: 1,
    processed: { [row.evaluationId]: row.payloadSha256 },
    overall: {},
    skills: {},
    leaks: [],
    segments: {},
  }));
  fs.writeFileSync(store.eventsPath, `${JSON.stringify({
    evaluationId: row.evaluationId,
    payloadSha256: row.payloadSha256,
    skillKey: '__proto__',
    status: 'supported',
    grade: 'preferred',
    forced: false,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
    appliedAt: '2026-09-01T00:00:00.000Z',
  })}\n`);
  await assert.rejects(() => store.show(), { code: 'PROFILE_EVENT_INVALID' });
});

test('schema 3 file is not read as legacy mixed totals; duplicate apply projects', async () => {
  const storeDir = tmp();
  const store = createProfileStore(storeDir);
  const first = evaluation();
  const second = evaluation({
    evaluationId: evaluationIdOf({
      gameEpoch: 'ab'.repeat(32),
      decisionId: 'd-4-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '2.0.0',
    }),
    payloadSha256: 'ee'.repeat(32),
    source: { id: 'local-preflop-baseline', version: '2.0.0' },
  });
  await store.apply(first);
  await store.apply(second);
  const disk = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
  assert.equal(disk.schemaVersion, 6);
  disk.schemaVersion = 3;
  disk.overall.evaluatedDecisions = 99;
  disk.overall.supportedDecisions = 99;
  fs.writeFileSync(store.profilePath, JSON.stringify(disk));
  const shown = await store.show();
  assert.equal(shown.schemaVersion, 6);
  assert.equal(shown.overall.evaluatedDecisions, 1);
  const again = await store.apply(second);
  assert.equal(again.applied, false);
  assert.equal(again.profile.schemaVersion, 6);
  assert.equal(again.profile.overall.evaluatedDecisions, 1);
});

test('schema 1, 2 and 3 profiles replay to schema 6 without rewriting event bytes', async () => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const storeDir = createOwnedTempDir(`profile-migrate-${schemaVersion}`);
    const store = createProfileStore(storeDir);
    const row = evaluation({
      chosen: { action: 'fold', frequency: 0.2, evBb: null },
      recommended: [
        { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null },
        { action: 'fold', frequency: 0.2, evBb: null },
      ],
      handClass: 'AJo',
      source: {
        id: 'local-preflop-baseline',
        version: '1.0.0',
        contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
      },
    });
    await store.apply(row);
    const legacy = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
    legacy.schemaVersion = schemaVersion;
    fs.writeFileSync(store.profilePath, JSON.stringify(legacy));
    const eventBytes = fs.readFileSync(store.eventsPath);
    const processed = structuredClone(legacy.processed);

    const shown = await store.show();

    assert.equal(shown.schemaVersion, 6);
    assert.deepEqual(shown.processed, processed);
    assert.deepEqual(fs.readFileSync(store.eventsPath), eventBytes);
  }
});

test('prospective profile events retain validated mix observations in the existing journal', async () => {
  const storeDir = createOwnedTempDir('profile-mix-journal');
  const store = createProfileStore(storeDir);
  const source = {
    id: 'local-preflop-baseline',
    version: '1.0.0',
    contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
  };
  const row = evaluation({
    grade: 'mixed',
    chosen: { action: 'fold', frequency: 0.2, evBb: null, hidden: 'drop' },
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null, hidden: 'drop' },
      { action: 'fold', frequency: 0.2, evBb: null },
    ],
    handClass: 'AJo',
    source,
    detailSha256: 'dd'.repeat(32),
  });

  const applied = await store.apply(row);
  const raw = fs.readFileSync(store.eventsPath, 'utf8');
  const events = raw.trim().split('\n').map(JSON.parse);

  assert.equal(applied.profile.schemaVersion, 6);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].mixObservation, {
    spotKey: row.spotKey,
    handClass: row.handClass,
    referenceActions: [
      { action: 'fold', frequency: 0.2, evBb: null },
      { action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null },
    ],
    chosenAction: { action: 'fold', frequency: 0.2, evBb: null },
    sourceIdentity: source,
    detailSha256: row.detailSha256,
  });
  await store.rebuild();
  assert.equal(fs.readFileSync(store.eventsPath, 'utf8'), raw);
});

test('future, corrupt and conflicting profile inputs fail without any writes', async () => {
  const cases = [
    {
      name: 'future',
      profile: { schemaVersion: 99, processed: {} },
      events: '',
      code: 'UNSUPPORTED_PROFILE',
    },
    {
      name: 'derived-without-journal',
      profile: {
        schemaVersion: 4,
        processed: {},
        game: { overall: { evaluatedDecisions: 1 } },
        practice: { overall: { evaluatedDecisions: 0 } },
        segments: {},
      },
      events: '',
      code: 'UNSUPPORTED_PROFILE',
    },
    {
      name: 'corrupt',
      profile: { schemaVersion: 2, processed: {} },
      events: '{"schemaVersion":4,"evaluationId":null}\n',
      code: 'PROFILE_EVENT_INVALID',
    },
    {
      name: 'conflict',
      profile: { schemaVersion: 2, processed: {} },
      events: [
        {
          evaluationId: `${'ab'.repeat(32)}:d-1-preflop-0:local-preflop-baseline@1.0.0`,
          payloadSha256: 'aa'.repeat(32),
          skillKey: 'preflop.rfi.BTN',
          status: 'supported',
          grade: 'preferred',
          forced: false,
          providerId: 'local-preflop-baseline',
          providerVersion: '1.0.0',
          origin: 'game',
        },
        {
          evaluationId: `${'ab'.repeat(32)}:d-1-preflop-0:local-preflop-baseline@1.0.0`,
          payloadSha256: 'bb'.repeat(32),
          skillKey: 'preflop.rfi.BTN',
          status: 'supported',
          grade: 'preferred',
          forced: false,
          providerId: 'local-preflop-baseline',
          providerVersion: '1.0.0',
          origin: 'game',
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      code: 'PROFILE_EVENT_CONFLICT',
    },
  ];
  for (const fixture of cases) {
    const storeDir = createOwnedTempDir(`profile-reject-${fixture.name}`);
    const store = createProfileStore(storeDir);
    fs.mkdirSync(path.dirname(store.profilePath), { recursive: true });
    fs.writeFileSync(store.profilePath, JSON.stringify(fixture.profile));
    fs.writeFileSync(store.eventsPath, fixture.events);
    const profileBefore = fs.readFileSync(store.profilePath);
    const eventsBefore = fs.readFileSync(store.eventsPath);

    await assert.rejects(() => store.show(), { code: fixture.code });

    assert.deepEqual(fs.readFileSync(store.profilePath), profileBefore);
    assert.deepEqual(fs.readFileSync(store.eventsPath), eventsBefore);
  }
});

test('journal append followed by profile write failure recovers exactly once', async () => {
  const storeDir = createOwnedTempDir('profile-append-crash');
  const { createProfileStore: createRawProfileStore } = await import('../training/profile-store.js');
  const { trainingStoreIo } = await import('../tools/training-stores.js');
  let failProfileWrite = true;
  const failingIo = {
    ...trainingStoreIo,
    writeJsonSecure(file, value) {
      if (failProfileWrite && /[\\/]profile\.json$/.test(file)) {
        failProfileWrite = false;
        const error = new Error('injected profile write failure');
        error.code = 'INJECTED_WRITE_FAILURE';
        throw error;
      }
      return trainingStoreIo.writeJsonSecure(file, value);
    },
  };
  const row = evaluation();
  await assert.rejects(
    () => createRawProfileStore(storeDir, { io: failingIo }).apply(row),
    { code: 'INJECTED_WRITE_FAILURE' },
  );
  const normal = createProfileStore(storeDir);
  const shown = await normal.show();
  assert.equal(shown.overall.evaluatedDecisions, 1);
  assert.equal((await normal.apply(row)).applied, false);
  assert.equal(fs.readFileSync(normal.eventsPath, 'utf8').trim().split('\n').length, 1);
});

test('rebuild and digest migration reject unbacked ledgers before any rewrite', async () => {
  for (const operation of ['rebuild', 'migrateDigests']) {
    const storeDir = createOwnedTempDir(`profile-ledger-${operation}`);
    const store = createProfileStore(storeDir);
    const row = evaluation();
    await store.apply(row);
    const profile = JSON.parse(fs.readFileSync(store.profilePath, 'utf8'));
    profile.processed[`${'ab'.repeat(32)}:d-99-preflop-0:local-preflop-baseline@1.0.0`] = 'ff'.repeat(32);
    fs.writeFileSync(store.profilePath, JSON.stringify(profile));
    const profileBefore = fs.readFileSync(store.profilePath);
    const eventsBefore = fs.readFileSync(store.eventsPath);

    await assert.rejects(() => store[operation](), { code: 'UNSUPPORTED_PROFILE' });

    assert.deepEqual(fs.readFileSync(store.profilePath), profileBefore);
    assert.deepEqual(fs.readFileSync(store.eventsPath), eventsBefore);
  }
});

test('digest migration rejects a future profile before rewriting the event journal', async () => {
  const storeDir = createOwnedTempDir('profile-future-digest-migrate');
  const store = createProfileStore(storeDir);
  await store.apply(evaluation());
  fs.writeFileSync(store.profilePath, JSON.stringify({ schemaVersion: 99, processed: {} }));
  const profileBefore = fs.readFileSync(store.profilePath);
  const eventsBefore = fs.readFileSync(store.eventsPath);

  await assert.rejects(() => store.migrateDigests({ oldToNew: { ['aa'.repeat(32)]: 'bb'.repeat(32) } }), {
    code: 'UNSUPPORTED_PROFILE',
  });

  assert.deepEqual(fs.readFileSync(store.profilePath), profileBefore);
  assert.deepEqual(fs.readFileSync(store.eventsPath), eventsBefore);
  await assert.rejects(() => store.rebuild(), { code: 'UNSUPPORTED_PROFILE' });
  assert.deepEqual(fs.readFileSync(store.profilePath), profileBefore);
  assert.deepEqual(fs.readFileSync(store.eventsPath), eventsBefore);
});

test('study runs are validated before append and valid evidence uses the profile journal', async () => {
  const invalidDir = createOwnedTempDir('profile-study-invalid');
  const invalidStore = createProfileStore(invalidDir);
  await assert.rejects(() => invalidStore.apply(evaluation({
    origin: 'practice',
    studyRun: { id: 'not-a-uuid', mode: 'assessment', total: 2, index: 0, startedAt: 'bad' },
  })), { code: 'STUDY_RUN_INVALID' });
  assert.equal(fs.existsSync(invalidStore.profilePath), false);
  assert.equal(fs.existsSync(invalidStore.eventsPath), false);

  const validDir = createOwnedTempDir('profile-study-valid');
  const validStore = createProfileStore(validDir);
  const studyRun = {
    id: '11111111-1111-4111-8111-111111111111',
    mode: 'assessment',
    total: 2,
    index: 0,
    startedAt: '2026-09-06T00:00:00.000Z',
    assessmentId: '22222222-2222-4222-8222-222222222222',
  };
  await validStore.apply(evaluation({ origin: 'practice', studyRun }));
  const event = JSON.parse(fs.readFileSync(validStore.eventsPath, 'utf8').trim());
  assert.deepEqual(event.studyRun, studyRun);
  assert.deepEqual((await validStore.show()).practice.studyRuns[studyRun.id], studyRun);
});

test('digest-map retry recovers journal-new profile-old crash state', async () => {
  const storeDir = createOwnedTempDir('profile-digest-crash');
  const normal = createProfileStore(storeDir);
  const row = evaluation();
  await normal.apply(row);
  const oldDigest = row.payloadSha256;
  const newDigest = 'bb'.repeat(32);
  const map = {
    oldToNew: { [oldDigest]: newDigest },
    byEvaluationId: { [row.evaluationId]: { old: oldDigest, new: newDigest } },
  };
  const { createProfileStore: createRawProfileStore } = await import('../training/profile-store.js');
  const { trainingStoreIo } = await import('../tools/training-stores.js');
  let fail = true;
  const failingIo = {
    ...trainingStoreIo,
    writeJsonSecure(file, value) {
      if (fail && /[\\/]profile\.json$/.test(file)) {
        fail = false;
        const error = new Error('injected profile write failure');
        error.code = 'INJECTED_WRITE_FAILURE';
        throw error;
      }
      return trainingStoreIo.writeJsonSecure(file, value);
    },
  };
  await assert.rejects(() => createRawProfileStore(storeDir, { io: failingIo }).migrateDigests(map), {
    code: 'INJECTED_WRITE_FAILURE',
  });
  assert.equal(JSON.parse(fs.readFileSync(normal.eventsPath, 'utf8')).payloadSha256, newDigest);
  assert.equal(JSON.parse(fs.readFileSync(normal.profilePath, 'utf8')).processed[row.evaluationId], oldDigest);

  const recovered = await normal.migrateDigests(map);
  assert.equal(recovered.processed[row.evaluationId], newDigest);
  assert.equal(JSON.parse(fs.readFileSync(normal.profilePath, 'utf8')).processed[row.evaluationId], newDigest);
});

test('schema 4 rebuild and digest migration preserve journal-backed evidence',async()=>{
 for(const operation of ['rebuild','migrateDigests']){
  const store=createProfileStore(createOwnedTempDir(`schema4-${operation}`));
  await store.apply(evaluation());
  const profile=JSON.parse(fs.readFileSync(store.profilePath,'utf8'));profile.schemaVersion=4;
  fs.writeFileSync(store.profilePath,JSON.stringify(profile));
  await store[operation]();
  assert.equal((await store.show()).overall.evaluatedDecisions,1);
  assert.equal(JSON.parse(fs.readFileSync(store.profilePath,'utf8')).schemaVersion,6);
 }
});
test('schema 4 derived profile without journal fails without rewriting evidence',async()=>{
 const store=createProfileStore(createOwnedTempDir('schema4-no-journal'));
 await store.apply(evaluation());
 const profile=JSON.parse(fs.readFileSync(store.profilePath,'utf8'));profile.schemaVersion=4;
 const bytes=JSON.stringify(profile);fs.writeFileSync(store.profilePath,bytes);fs.unlinkSync(store.eventsPath);
 await assert.rejects(store.show(),{code:'UNSUPPORTED_PROFILE'});
 assert.equal(fs.readFileSync(store.profilePath,'utf8'),bytes);
});

test('legacy practice duplicates remain byte-preserving but undeclared new practice cannot append',async()=>{
 const dir=tmp(),store=createProfileStore(dir);
 const {eventFromEvaluation}=await import('../training/profile-store.js');
 const legacyEvaluation=evaluation({origin:'practice'});delete legacyEvaluation.assistance;
 const prior=eventFromEvaluation({...legacyEvaluation,assistance:{schemaVersion:1,hintShown:false,exposureId:null}},'2026-09-08T00:00:00.000Z');
 prior.schemaVersion=5;delete prior.assistance;
 fs.mkdirSync(path.dirname(store.eventsPath),{recursive:true});
 const bytes=JSON.stringify(prior)+'\n';fs.writeFileSync(store.eventsPath,bytes);
 const result=await store.apply(legacyEvaluation);assert.equal(result.applied,false);
 assert.equal(fs.readFileSync(store.eventsPath,'utf8'),bytes);
 await assert.rejects(()=>store.apply({...legacyEvaluation,evaluationId:legacyEvaluation.evaluationId.replace('d-1-','d-2-')}),{code:'ASSISTANCE_INVALID'});
 assert.equal(fs.readFileSync(store.eventsPath,'utf8'),bytes);
});
