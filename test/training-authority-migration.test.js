import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as contract from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { createTrainingControl } from '../tools/training-control.js';
import {
  readJsonl,
  writeJsonSecure as secureWriteJson,
  writeTextSecure as secureWriteText,
} from '../tools/training-store.js';
import { loadUiState } from '../server/server.js';
import { writeSecurityFixtures } from './helpers/security-fixtures.js';

const EPOCH = 'ab'.repeat(32);
const V1_KEYS = Object.freeze([
  'evaluationId', 'handNo', 'decisionId', 'status', 'street', 'spotKey', 'handClass',
  'chosen', 'recommended', 'evLossBb', 'grade', 'forced', 'source', 'explanation',
  'detailRef', 'detailSha256', 'code', 'reason',
]);

function tmp(prefix = 'holdem-migration-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function evaluation(decisionId = 'd-1-preflop-0') {
  return {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: EPOCH,
      decisionId,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  };
}

function v1Canonical(summary) {
  const canonical = {};
  for (const key of V1_KEYS) {
    if (summary[key] !== undefined) canonical[key] = summary[key];
  }
  return JSON.stringify(canonical);
}

function writeV1Session(dir, {
  explanation = 'legacy explanation',
  status = 'evaluated',
  decisionId = 'd-1-preflop-0',
} = {}) {
  const row = evaluation(decisionId);
  const detailRef = contract.detailRefOf(row.evaluationId);
  const detailSha256 = sha(JSON.stringify(row));
  const summary = {
    evaluationId: row.evaluationId,
    handNo: 1,
    decisionId: row.decisionId,
    status: row.status,
    street: row.street,
    spotKey: row.spotKey,
    handClass: row.handClass,
    chosen: { ...row.chosen },
    recommended: row.recommended.map((action) => ({ ...action })),
    evLossBb: row.evLossBb,
    grade: row.grade,
    forced: row.forced,
    source: { ...row.source },
    explanation,
    detailRef,
    detailSha256,
  };
  summary.payloadSha256 = sha(v1Canonical(summary));

  const training = path.join(dir, 'training');
  fs.mkdirSync(path.join(training, 'details'), { recursive: true });
  fs.writeFileSync(path.join(training, 'details', `${detailRef}.json`), JSON.stringify(row));
  fs.writeFileSync(path.join(training, 'evaluations.jsonl'), `${JSON.stringify(summary)}\n`);
  fs.writeFileSync(path.join(training, '.training-authority.json'), JSON.stringify({
    schemaVersion: 1,
    gameEpoch: EPOCH,
    ownerSessionId: 'owner-1',
    items: {
      [row.evaluationId]: {
        status,
        handNo: 1,
        decisionId: row.decisionId,
        evaluationId: row.evaluationId,
        payloadSha256: summary.payloadSha256,
        detailRef,
        detailSha256,
      },
    },
    publishQueue: status === 'published' ? {} : {
      [row.evaluationId]: {
        evaluationId: row.evaluationId,
        handNo: 1,
        payloadSha256: summary.payloadSha256,
      },
    },
  }));
  return { evaluation: row, summary };
}

function writeV1Attempt(dir, summary, { applied = true, publishId = 7 } = {}) {
  fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
    expectedGameEpoch: EPOCH,
    body: { publishId, training: [summary] },
    trainingAuthority: {
      expectedGameEpoch: EPOCH,
      evaluationId: summary.evaluationId,
      payloadSha256: summary.payloadSha256,
    },
  }));
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({
    publishId: applied ? publishId : publishId - 1,
    training: applied ? [summary] : [],
  }));
}

function nativeV2Authority() {
  return {
    schemaVersion: 2,
    gameEpoch: EPOCH,
    ownerSessionId: 'owner-1',
    items: {},
    publishQueue: {},
    pending: {},
    annotationQueue: {},
    solveTasks: {},
  };
}

function treeSnapshot(root) {
  const entries = {};
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries[`${relative}/`] = 'directory';
        visit(file, relative);
      } else if (entry.isFile()) {
        entries[relative] = sha(fs.readFileSync(file));
      } else if (entry.isSymbolicLink()) {
        entries[relative] = `symlink:${fs.readlinkSync(file)}`;
      }
    }
  };
  visit(root);
  return entries;
}

function operationFor(kind, file, value) {
  const name = path.basename(file);
  if (kind === 'unlink' && name === '.publish-attempt.json') return 'attempt';
  if (kind === 'text' && name === 'evaluations.jsonl') return 'jsonl';
  if (kind !== 'json') return null;
  if (name === '.digest-map-v2.json') return 'map';
  if (name === '.training-authority.json') return 'authority';
  if (name === '.migration-v2.json') return `marker:${value?.status ?? 'unknown'}`;
  return null;
}

function injectedError(operation, suffix = 'FAILURE') {
  const error = new Error(`injected ${operation} ${suffix.toLowerCase()}`);
  error.code = `INJECTED_${operation.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_${suffix}`;
  return error;
}

function migrationIo({ failAt = null, commitThenThrowAt = null, calls = [] } = {}) {
  const invoke = (kind, file, value, commit) => {
    const operation = operationFor(kind, file, value);
    if (operation) calls.push(operation);
    const target = operation === 'marker:session-done' ? 'marker' : operation;
    if (target === failAt) throw injectedError(target);
    const result = commit();
    if (target === commitThenThrowAt) throw injectedError(target, 'AFTER_COMMIT');
    return result;
  };
  return {
    writeJsonSecure(file, value) {
      return invoke('json', file, value, () => secureWriteJson(file, value));
    },
    writeTextSecure(file, value) {
      return invoke('text', file, value, () => secureWriteText(file, value));
    },
    unlinkSync(file) {
      return invoke('unlink', file, null, () => fs.unlinkSync(file));
    },
  };
}

function readAuth(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'training', '.training-authority.json'), 'utf8'));
}

function readMarker(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'training', '.migration-v2.json'), 'utf8'));
}

function assertCompleteMigration(dir, summary, { applied = true } = {}) {
  const auth = readAuth(dir);
  const item = auth.items[summary.evaluationId];
  assert.equal(auth.schemaVersion, 2);
  assert.equal(readMarker(dir).status, 'session-done');
  assert.equal(item.status, applied ? 'published' : 'evaluated');
  assert.equal(item.consumers.published, applied);
  assert.equal(item.annotations.explanation.status, 'ready');
  assert.equal(item.annotations.explanation.published, applied);
  assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'training', '.digest-map-v2.json'), 'utf8'));
  assert.equal(map.oldToNew[summary.payloadSha256], item.payloadSha256);
  const rows = readJsonl(path.join(dir, 'training', 'evaluations.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].explanation, undefined);
  const exact = JSON.parse(fs.readFileSync(
    path.join(dir, 'training', 'annotations', `${item.detailRef}.explanation.json`),
    'utf8',
  ));
  assert.deepEqual(exact, { field: 'explanation', status: 'ready', value: summary.explanation });
}

async function snapshotFromLegacyServer(summary) {
  const dir = tmp('holdem-server-migration-');
  writeSecurityFixtures(dir);
  fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'training', '.training-authority.json'),
    JSON.stringify({ schemaVersion: 1 }),
  );
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({
    revision: 1,
    publishId: 1,
    view: null,
    log: [],
    coach: [],
    training: [summary],
    history: [],
  }));
  const restored = loadUiState(dir, 'tok');
  return {
    ...restored,
    trainingAnnotations: Object.values(restored.trainingAnnotations)
      .flatMap((fields) => Object.values(fields)),
  };
}

test('legacyExplanationAnnotation is the 600-character SSOT', () => {
  assert.equal(contract.EXPLANATION_MAX_CHARS, 600);
  assert.equal(contract.TRAINING_SUMMARY_LIMITS.explanation, contract.EXPLANATION_MAX_CHARS);
  assert.equal(contract.legacyExplanationAnnotation(''), null);
  assert.equal(contract.legacyExplanationAnnotation(12345), null);
  assert.deepEqual(contract.legacyExplanationAnnotation('x'), { status: 'ready', value: 'x' });
  assert.deepEqual(contract.legacyExplanationAnnotation('x'.repeat(600)), {
    status: 'ready', value: 'x'.repeat(600),
  });
  assert.deepEqual(contract.legacyExplanationAnnotation('x'.repeat(601)), {
    status: 'unavailable', value: null, sealReason: 'LEGACY_OVER_CAP',
  });
});

test('loadAuthority is a byte-stable pure reader and a locked writer cannot lazily migrate v1', async () => {
  const dir = tmp();
  const { evaluation: row } = writeV1Session(dir);
  const tc = createTrainingControl();
  const before = treeSnapshot(dir);

  assert.throws(() => tc.loadAuthority(dir), { code: 'TRAINING_AUTHORITY_V1' });
  assert.deepEqual(treeSnapshot(dir), before);

  await assert.rejects(
    tc.acceptEvaluations(dir, {
      gameEpoch: EPOCH,
      owner: 'owner-1',
      handNo: 1,
      evaluations: [row],
    }),
    { code: 'TRAINING_AUTHORITY_V1' },
  );
  assert.deepEqual(treeSnapshot(dir), before);
});

test('a conflicting legacy explanation exact-file fails closed as ANNOTATION_CONFLICT', async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir);
  const exactDir = path.join(dir, 'training', 'annotations');
  fs.mkdirSync(exactDir);
  fs.writeFileSync(
    path.join(exactDir, `${summary.detailRef}.explanation.json`),
    JSON.stringify({ field: 'explanation', status: 'ready', value: 'different legacy text' }),
  );

  await assert.rejects(
    createTrainingControl().migrateAuthority(dir),
    { code: 'ANNOTATION_CONFLICT' },
  );
  assert.equal(readAuth(dir).schemaVersion, 1);
  assert.equal(fs.existsSync(path.join(dir, 'training', '.migration-v2.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'training', '.digest-map-v2.json')), false);
});

test('migration writes in-progress then map → authority → jsonl → marker → attempt deletion', async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir);
  writeV1Attempt(dir, summary, { applied: true });
  const calls = [];

  await createTrainingControl({ io: migrationIo({ calls }) }).migrateAuthority(dir);

  assert.deepEqual(calls, [
    'marker:in-progress',
    'map',
    'authority',
    'jsonl',
    'marker:session-done',
    'attempt',
  ]);
  assertCompleteMigration(dir, summary, { applied: true });
});

test('five-row migration re-entry table', async (t) => {
  await t.test('row 1: authority v1 + marker absent/in-progress + map absent/present → restart from the beginning', async () => {
    const cases = [
      { marker: null, map: false },
      { marker: 'in-progress', map: false },
      { marker: 'in-progress', map: true },
    ];
    for (const [index, variant] of cases.entries()) {
      const dir = tmp(`holdem-row1-${index}-`);
      const { summary } = writeV1Session(dir);
      if (variant.marker) {
        secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: variant.marker });
      }
      if (variant.map) {
        secureWriteJson(path.join(dir, 'training', '.digest-map-v2.json'), { stale: true });
      }
      await createTrainingControl().migrateAuthority(dir);
      const auth = readAuth(dir);
      assert.equal(auth.schemaVersion, 2);
      assert.equal(readMarker(dir).status, 'session-done');
      assert.equal(auth.items[summary.evaluationId].annotations.explanation.status, 'ready');
    }
  });

  await t.test('row 2: authority v2 + in-progress + map present → rewrite jsonl, finish marker, delete attempt', async () => {
    const dir = tmp();
    const { summary } = writeV1Session(dir);
    writeV1Attempt(dir, summary, { applied: true });
    await assert.rejects(
      createTrainingControl({ io: migrationIo({ failAt: 'jsonl' }) }).migrateAuthority(dir),
      { code: 'INJECTED_JSONL_FAILURE' },
    );
    assert.equal(readAuth(dir).schemaVersion, 2);
    assert.equal(readMarker(dir).status, 'in-progress');
    assert.equal(fs.existsSync(path.join(dir, 'training', '.digest-map-v2.json')), true);

    await createTrainingControl().migrateAuthority(dir);
    assertCompleteMigration(dir, summary, { applied: true });
  });

  await t.test('row 3: authority v2 + in-progress + map absent → TRAINING_MIGRATION_CORRUPT and zero writes', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
    secureWriteJson(path.join(dir, 'training', '.training-authority.json'), nativeV2Authority());
    secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: 'in-progress' });
    const before = treeSnapshot(dir);
    const calls = [];
    const tc = createTrainingControl({ io: migrationIo({ calls }) });

    assert.throws(() => tc.loadAuthority(dir), { code: 'TRAINING_MIGRATION_CORRUPT' });
    await assert.rejects(tc.migrateAuthority(dir), { code: 'TRAINING_MIGRATION_CORRUPT' });
    assert.deepEqual(calls, []);
    assert.deepEqual(treeSnapshot(dir), before);
  });

  await t.test('row 4: authority v2 + session-done/complete + attempt present → reapply judgement and retry deletion', async () => {
    for (const markerStatus of ['session-done', 'complete']) {
      const dir = tmp(`holdem-row4-${markerStatus}-`);
      const { summary } = writeV1Session(dir);
      await createTrainingControl().migrateAuthority(dir);
      const auth = readAuth(dir);
      const item = auth.items[summary.evaluationId];
      item.status = 'evaluated';
      item.consumers.published = false;
      auth.publishQueue[summary.evaluationId] = {
        evaluationId: summary.evaluationId,
        handNo: 1,
        payloadSha256: item.payloadSha256,
      };
      secureWriteJson(path.join(dir, 'training', '.training-authority.json'), auth);
      secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: markerStatus });
      writeV1Attempt(dir, summary, { applied: true });
      const calls = [];

      await createTrainingControl({ io: migrationIo({ calls }) }).migrateAuthority(dir);

      assert.equal(readAuth(dir).items[summary.evaluationId].status, 'published');
      assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
      assert.deepEqual(calls, ['authority', 'attempt']);
    }
  });

  await t.test('row 5: authority v2 + done/marker absent + attempt absent → no-op', async () => {
    for (const markerStatus of [null, 'session-done', 'complete']) {
      const dir = tmp(`holdem-row5-${markerStatus ?? 'absent'}-`);
      fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
      secureWriteJson(path.join(dir, 'training', '.training-authority.json'), nativeV2Authority());
      if (markerStatus) {
        secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: markerStatus });
      }
      const before = treeSnapshot(dir);
      const calls = [];

      const auth = await createTrainingControl({ io: migrationIo({ calls }) }).migrateAuthority(dir);

      assert.equal(auth.schemaVersion, 2);
      assert.deepEqual(calls, []);
      assert.deepEqual(treeSnapshot(dir), before);
    }
  });
});

test('five injected migration failures recover without losing map, explanation, or attempt judgement', async (t) => {
  for (const failure of ['map', 'authority', 'jsonl', 'marker', 'attempt']) {
    await t.test(failure, async () => {
      const appliedCases = failure === 'authority' ? [true, false] : [true];
      for (const applied of appliedCases) {
        const dir = tmp(`holdem-fail-${failure}-${applied}-`);
        const { summary } = writeV1Session(dir);
        writeV1Attempt(dir, summary, { applied });
        const originalAuthority = fs.readFileSync(path.join(dir, 'training', '.training-authority.json'));

        await assert.rejects(
          createTrainingControl({ io: migrationIo({ failAt: failure }) }).migrateAuthority(dir),
          (error) => error.code === `INJECTED_${failure.toUpperCase()}_FAILURE`,
        );

        const diskAuth = readAuth(dir);
        if (failure === 'map' || failure === 'authority') {
          assert.equal(diskAuth.schemaVersion, 1);
          assert.deepEqual(
            fs.readFileSync(path.join(dir, 'training', '.training-authority.json')),
            originalAuthority,
          );
          assert.equal(fs.existsSync(path.join(dir, 'training', '.migration-v2.json')), false);
          assert.equal(fs.existsSync(path.join(dir, 'training', '.digest-map-v2.json')), false);
        } else {
          assert.equal(diskAuth.schemaVersion, 2);
          assert.equal(fs.existsSync(path.join(dir, 'training', '.digest-map-v2.json')), true);
          assert.equal(readMarker(dir).status, failure === 'attempt' ? 'session-done' : 'in-progress');
        }
        assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), true);

        await createTrainingControl().migrateAuthority(dir);
        assertCompleteMigration(dir, summary, { applied });
      }
    });
  }
});

test('authority and session-done marker commit-after-throw states resume from disk truth', async (t) => {
  for (const failure of ['authority', 'marker']) {
    await t.test(`${failure} commit-after-throw`, async () => {
      const dir = tmp(`holdem-after-commit-${failure}-`);
      const { summary } = writeV1Session(dir);
      writeV1Attempt(dir, summary, { applied: true });

      await assert.rejects(
        createTrainingControl({
          io: migrationIo({ commitThenThrowAt: failure }),
        }).migrateAuthority(dir),
        (error) => error.code === `INJECTED_${failure.toUpperCase()}_AFTER_COMMIT`,
      );

      assert.equal(readAuth(dir).schemaVersion, 2);
      assert.equal(fs.existsSync(path.join(dir, 'training', '.digest-map-v2.json')), true);
      assert.equal(readMarker(dir).status, failure === 'marker' ? 'session-done' : 'in-progress');
      assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), true);

      await createTrainingControl().migrateAuthority(dir);
      assertCompleteMigration(dir, summary, { applied: true });
    });
  }
});

test('withMigrationLock alone waits past the 6-second stale threshold; common withLock remains 3 seconds', { concurrency: false }, async () => {
  const originalNow = Date.now;
  const runWithAdvancingClock = async (work) => {
    const base = originalNow();
    let calls = 0;
    Date.now = () => base + calls++ * 1_000;
    try {
      return await work({ base, calls: () => calls });
    } finally {
      Date.now = originalNow;
    }
  };

  const commonDir = tmp('holdem-common-lock-');
  fs.mkdirSync(path.join(commonDir, 'training.lock.d'));
  await runWithAdvancingClock(async ({ base }) => {
    fs.utimesSync(path.join(commonDir, 'training.lock.d'), new Date(base), new Date(base));
    await assert.rejects(
      createTrainingControl().withLock(commonDir, () => assert.fail('common lock entered')),
      { code: 'LOCKED' },
    );
  });
  assert.equal(fs.existsSync(path.join(commonDir, 'training.lock.d')), true);

  const migrationDir = tmp('holdem-migration-lock-');
  writeV1Session(migrationDir);
  fs.mkdirSync(path.join(migrationDir, 'training.lock.d'));
  await runWithAdvancingClock(async ({ base }) => {
    fs.utimesSync(path.join(migrationDir, 'training.lock.d'), new Date(base), new Date(base));
    await createTrainingControl().migrateAuthority(migrationDir);
  });
  assert.equal(readMarker(migrationDir).status, 'session-done');

  const liveDir = tmp('holdem-live-lock-');
  writeV1Session(liveDir);
  fs.mkdirSync(path.join(liveDir, 'training.lock.d'));
  fs.writeFileSync(path.join(liveDir, 'training.lock.d', 'pid'), String(process.pid));
  const before = treeSnapshot(liveDir);
  await runWithAdvancingClock(async ({ calls }) => {
    await assert.rejects(
      createTrainingControl().migrateAuthority(liveDir),
      { code: 'LOCKED' },
    );
    assert.equal(calls() >= 11, true, 'migration lock did not retain the 10-second deadline');
  });
  assert.deepEqual(treeSnapshot(liveDir), before);
});

test('legacy explanation lengths {0,1,600,601,5000} match migration and server restore', async () => {
  for (const length of [0, 1, 600, 601, 5000]) {
    const explanation = 'x'.repeat(length);
    const dir = tmp(`holdem-legacy-length-${length}-`);
    const { summary } = writeV1Session(dir, { explanation });

    const migrated = await createTrainingControl().migrateAuthority(dir);
    const item = migrated.items[summary.evaluationId];
    const local = item.annotations?.explanation ?? null;
    const snapshot = await snapshotFromLegacyServer(summary);
    const restored = snapshot.trainingAnnotations.find((row) => (
      row.evaluationId === summary.evaluationId && row.field === 'explanation'
    )) ?? null;

    assert.deepEqual(
      local ? { status: local.status, valueSha256: local.valueSha256 } : null,
      restored ? { status: restored.status, valueSha256: restored.valueSha256 } : null,
      `migration/server drift at legacy explanation length ${length}`,
    );
    if (length === 0) {
      assert.equal(local, null);
      assert.deepEqual(migrated.notices, []);
      continue;
    }
    const exact = JSON.parse(fs.readFileSync(
      path.join(dir, 'training', 'annotations', `${item.detailRef}.explanation.json`),
      'utf8',
    ));
    if (length <= 600) {
      assert.equal(local.status, 'ready');
      assert.equal(exact.value, explanation);
      assert.deepEqual(migrated.notices, []);
    } else {
      assert.equal(local.status, 'unavailable');
      assert.equal(local.sealReason, 'LEGACY_OVER_CAP');
      assert.deepEqual(exact, { field: 'explanation', status: 'unavailable', value: null });
      assert.deepEqual(migrated.notices, ['legacy explanation 1건 상한 초과 → unavailable']);
    }
  }
});

test('non-string legacy explanation is absent in migration and server restore, with a restore notice', { concurrency: false }, async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir, { explanation: 12345 });
  const migrated = await createTrainingControl().migrateAuthority(dir);
  assert.equal(migrated.items[summary.evaluationId].annotations?.explanation, undefined);

  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = function capture(chunk, ...args) {
    stderr += String(chunk);
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };
  try {
    const snapshot = await snapshotFromLegacyServer(summary);
    assert.equal(snapshot.trainingAnnotations.length, 0);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(stderr, /dropped 1 annotation/);
});

test('an unapplied current-v2 publish attempt survives completed migration re-entry', async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir);
  const migrated = await createTrainingControl().migrateAuthority(dir);
  const item = migrated.items[summary.evaluationId];
  fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
    expectedGameEpoch: EPOCH,
    body: { publishId: 42, training: [item.summary] },
    trainingAuthority: {
      expectedGameEpoch: EPOCH,
      items: [{ evaluationId: item.evaluationId, payloadSha256: item.payloadSha256 }],
    },
  }));
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({ publishId: 41, training: [] }));
  secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: 'complete' });

  await createTrainingControl().migrateAuthority(dir);

  assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), true);
  assert.equal(readAuth(dir).items[item.evaluationId].status, 'evaluated');
});

test('v2 migration validates items, marker status, and the digest-map file before every write', async () => {
  const make = () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
    secureWriteJson(path.join(dir, 'training', '.training-authority.json'), nativeV2Authority());
    secureWriteJson(path.join(dir, 'training', '.migration-v2.json'), { status: 'in-progress' });
    return dir;
  };
  const cases = [];

  const missingItems = make();
  const noItems = readAuth(missingItems);
  delete noItems.items;
  secureWriteJson(path.join(missingItems, 'training', '.training-authority.json'), noItems);
  secureWriteJson(path.join(missingItems, 'training', '.digest-map-v2.json'), {
    schemaVersion: 1, oldToNew: {}, byEvaluationId: {},
  });
  cases.push(missingItems);

  const mapDirectory = make();
  fs.mkdirSync(path.join(mapDirectory, 'training', '.digest-map-v2.json'));
  cases.push(mapDirectory);

  const mapSymlink = make();
  const outside = path.join(tmp(), 'map.json');
  secureWriteJson(outside, { schemaVersion: 1, oldToNew: {}, byEvaluationId: {} });
  fs.symlinkSync(outside, path.join(mapSymlink, 'training', '.digest-map-v2.json'));
  cases.push(mapSymlink);

  const malformedMap = make();
  fs.writeFileSync(path.join(malformedMap, 'training', '.digest-map-v2.json'), '{broken');
  cases.push(malformedMap);

  const unknownMarker = make();
  secureWriteJson(path.join(unknownMarker, 'training', '.migration-v2.json'), { status: 'mystery' });
  cases.push(unknownMarker);

  for (const dir of cases) {
    const before = treeSnapshot(dir);
    const calls = [];
    await assert.rejects(
      createTrainingControl({ io: migrationIo({ calls }) }).migrateAuthority(dir),
      { code: 'TRAINING_MIGRATION_CORRUPT' },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(treeSnapshot(dir), before);
  }
});

test('legacy row, detail, and attempt evidence are digest- and epoch-bound', async () => {
  const tamperedRow = tmp();
  const first = writeV1Session(tamperedRow);
  const rowPath = path.join(tamperedRow, 'training', 'evaluations.jsonl');
  const row = JSON.parse(fs.readFileSync(rowPath, 'utf8'));
  row.explanation = 'tampered without a new v1 digest';
  fs.writeFileSync(rowPath, `${JSON.stringify(row)}\n`);
  await assert.rejects(
    createTrainingControl().migrateAuthority(tamperedRow),
    { code: 'TRAINING_MIGRATION_CORRUPT' },
  );
  assert.equal(readAuth(tamperedRow).schemaVersion, 1);

  const tamperedDetail = tmp();
  const second = writeV1Session(tamperedDetail);
  fs.writeFileSync(
    path.join(tamperedDetail, 'training', 'details', `${second.summary.detailRef}.json`),
    JSON.stringify({ ...second.evaluation, handClass: 'KK' }),
  );
  await assert.rejects(
    createTrainingControl().migrateAuthority(tamperedDetail),
    { code: 'TRAINING_MIGRATION_CORRUPT' },
  );
  assert.equal(readAuth(tamperedDetail).schemaVersion, 1);

  for (const mutate of [
    (attempt) => { attempt.expectedGameEpoch = 'ff'.repeat(32); },
    (attempt) => { attempt.trainingAuthority.payloadSha256 = 'ff'.repeat(32); },
  ]) {
    const dir = tmp();
    const { summary } = writeV1Session(dir);
    writeV1Attempt(dir, summary, { applied: true });
    const attemptPath = path.join(dir, '.publish-attempt.json');
    const attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
    mutate(attempt);
    fs.writeFileSync(attemptPath, JSON.stringify(attempt));
    await assert.rejects(
      createTrainingControl().migrateAuthority(dir),
      { code: 'TRAINING_MIGRATION_CORRUPT' },
    );
    assert.equal(fs.existsSync(attemptPath), true);
    assert.equal(readAuth(dir).schemaVersion, 1);
  }
});

test('server restores legacy UI rows after authority migration using the digest map provenance', async () => {
  const dir = tmp();
  writeSecurityFixtures(dir);
  const { summary } = writeV1Session(dir);
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({
    revision: 1,
    publishId: 1,
    view: null,
    log: [],
    coach: [],
    training: [summary],
    history: [],
  }));
  await createTrainingControl().migrateAuthority(dir);

  const restored = loadUiState(dir, 'tok');
  assert.equal(restored.training.length, 1);
  assert.equal(Object.values(restored.trainingAnnotations).flatMap(Object.values).length, 1);
});

test('identical duplicate legacy rows and detail-only authority items remain recoverable', async () => {
  const duplicateDir = tmp();
  const duplicate = writeV1Session(duplicateDir);
  const rowPath = path.join(duplicateDir, 'training', 'evaluations.jsonl');
  const originalRow = fs.readFileSync(rowPath, 'utf8');
  fs.appendFileSync(rowPath, originalRow);
  const migratedDuplicate = await createTrainingControl().migrateAuthority(duplicateDir);
  assert.equal(migratedDuplicate.items[duplicate.summary.evaluationId].summary.evaluationId, duplicate.summary.evaluationId);

  const missingRowDir = tmp();
  const missing = writeV1Session(missingRowDir);
  fs.writeFileSync(path.join(missingRowDir, 'training', 'evaluations.jsonl'), '');
  const migratedMissing = await createTrainingControl().migrateAuthority(missingRowDir);
  assert.equal(migratedMissing.items[missing.summary.evaluationId].summary.evaluationId, missing.summary.evaluationId);
  assert.equal(migratedMissing.items[missing.summary.evaluationId].annotations.explanation, undefined);
});

test('v2 authority items and digest-map coverage are semantically bound before resume writes', async () => {
  const makeInterrupted = async () => {
    const dir = tmp();
    writeV1Session(dir);
    await assert.rejects(
      createTrainingControl({ io: migrationIo({ failAt: 'jsonl' }) }).migrateAuthority(dir),
      { code: 'INJECTED_JSONL_FAILURE' },
    );
    return dir;
  };
  const cases = [];

  const badItem = await makeInterrupted();
  const badItemAuth = readAuth(badItem);
  Object.values(badItemAuth.items)[0].payloadSha256 = 'ff'.repeat(32);
  secureWriteJson(path.join(badItem, 'training', '.training-authority.json'), badItemAuth);
  cases.push(badItem);

  const missingCoverage = await makeInterrupted();
  const mapPath = path.join(missingCoverage, 'training', '.digest-map-v2.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  map.oldToNew = {};
  map.byEvaluationId = {};
  secureWriteJson(mapPath, map);
  cases.push(missingCoverage);

  const nullMarker = await makeInterrupted();
  secureWriteJson(path.join(nullMarker, 'training', '.migration-v2.json'), null);
  cases.push(nullMarker);

  for (const dir of cases) {
    const before = treeSnapshot(dir);
    const calls = [];
    await assert.rejects(
      createTrainingControl({ io: migrationIo({ calls }) }).migrateAuthority(dir),
      { code: 'TRAINING_MIGRATION_CORRUPT' },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(treeSnapshot(dir), before);
  }
});

test('malformed attempts and unsafe snapshot publish ids never become applied evidence', async () => {
  const malformed = tmp();
  writeV1Session(malformed);
  fs.writeFileSync(path.join(malformed, '.publish-attempt.json'), '{broken');
  await assert.rejects(
    createTrainingControl().migrateAuthority(malformed),
    { code: 'TRAINING_MIGRATION_CORRUPT' },
  );
  assert.equal(readAuth(malformed).schemaVersion, 1);

  const unsafeSnapshot = tmp();
  const { summary } = writeV1Session(unsafeSnapshot);
  writeV1Attempt(unsafeSnapshot, summary, { applied: true, publishId: 7 });
  fs.writeFileSync(path.join(unsafeSnapshot, 'ui-snapshot.json'), JSON.stringify({
    publishId: 'Infinity',
    training: [summary],
  }));
  await assert.rejects(
    createTrainingControl().migrateAuthority(unsafeSnapshot),
    { code: 'TRAINING_MIGRATION_CORRUPT' },
  );
  assert.equal(readAuth(unsafeSnapshot).schemaVersion, 1);

  const forgedBody = tmp();
  const forged = writeV1Session(forgedBody);
  writeV1Attempt(forgedBody, forged.summary, { applied: true });
  const attemptPath = path.join(forgedBody, '.publish-attempt.json');
  const attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  attempt.body.training[0].grade = 'off-policy';
  fs.writeFileSync(attemptPath, JSON.stringify(attempt));
  await assert.rejects(
    createTrainingControl().migrateAuthority(forgedBody),
    { code: 'TRAINING_MIGRATION_CORRUPT' },
  );
  assert.equal(readAuth(forgedBody).schemaVersion, 1);
});

test('legacy UI provenance fails closed when marker or digest-map coverage is missing', async () => {
  const make = async () => {
    const dir = tmp();
    writeSecurityFixtures(dir);
    const { summary } = writeV1Session(dir);
    fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({
      revision: 1, publishId: 1, training: [summary], history: [],
    }));
    await createTrainingControl().migrateAuthority(dir);
    return { dir, summary };
  };

  const noMarker = await make();
  fs.unlinkSync(path.join(noMarker.dir, 'training', '.migration-v2.json'));
  assert.equal(loadUiState(noMarker.dir, 'tok').training.length, 0);

  const missingMapEntry = await make();
  const mapPath = path.join(missingMapEntry.dir, 'training', '.digest-map-v2.json');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  delete map.oldToNew[missingMapEntry.summary.payloadSha256];
  secureWriteJson(mapPath, map);
  assert.equal(loadUiState(missingMapEntry.dir, 'tok').training.length, 0);
});
