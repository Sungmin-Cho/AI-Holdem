import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gameEpochOf,
  legacyTrainingPayloadSha256,
  projectTrainingAnnotation,
} from '../publish-contract.js';
import { createCoachControl } from '../tools/coach-control.js';
import {
  annotationExactSegments,
  createTrainingControl,
  readAnnotationExactFile,
} from '../tools/training-control.js';
import * as pipeline from '../tools/training-pipeline.js';
import {
  FIXTURE_POLICY_ID,
  writeSecurityFixtures,
} from './helpers/security-fixtures.js';
import {
  q3Evaluation,
  readJson,
  tmpQ3,
  writeJson,
} from './helpers/q3-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'tok';
const EPOCH = gameEpochOf(TOKEN);
const OWNER = 'owner-q3';
const SAFE_EXPLANATION = 'BTN에서 AJo는 레이즈가 주력이고 폴드는 낮은 빈도입니다.';

function freshDir(t, prefix) {
  const dir = tmpQ3(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, { gameOver: true });
  return dir;
}

async function seedMachine(t, prefix = 'holdem-q3-machine-') {
  const dir = freshDir(t, prefix);
  const tc = createTrainingControl();
  const evaluation = q3Evaluation(EPOCH);
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH,
    owner: OWNER,
    handNo: 1,
    evaluations: [evaluation],
  });
  return { dir, tc, evaluation };
}

async function seedAnnotation(t, {
  status = 'ready',
  value = SAFE_EXPLANATION,
  prefix = 'holdem-q3-annotation-',
} = {}) {
  const seeded = await seedMachine(t, prefix);
  const { dir, tc, evaluation } = seeded;
  let auth = tc.loadAuthority(dir);
  await tc.markPublished(dir, evaluation.evaluationId, auth.items[evaluation.evaluationId].payloadSha256);
  const sealed = await tc.sealAnnotation(
    dir,
    evaluation.evaluationId,
    'explanation',
    status === 'unavailable' ? 'unavailable' : value,
    status === 'unavailable' ? { sealReason: 'explain-failed' } : undefined,
  );
  assert.equal(sealed.ok, true);
  auth = tc.loadAuthority(dir);
  return {
    ...seeded,
    auth,
    item: auth.items[evaluation.evaluationId],
    value: status === 'unavailable' ? null : value,
  };
}

function exactFile(dir, item, field = 'explanation') {
  return path.join(dir, 'training', ...annotationExactSegments(item.detailRef, field));
}

function envelopeFromArgs(args) {
  const at = args.indexOf('--from');
  assert.notEqual(at, -1, 'publish did not receive --from');
  return readJson(args[at + 1]);
}

function writeUiSnapshot(dir, item, annotation = null, { machine = item.summary } = {}) {
  writeJson(path.join(dir, 'ui-snapshot.json'), {
    revision: 7,
    publishId: 7,
    view: null,
    log: [],
    coach: [],
    training: [machine],
    trainingAnnotations: annotation === null
      ? {}
      : { [item.evaluationId]: { [annotation.field]: annotation } },
    history: [],
  });
}

async function assertRollbackUnblocked(dir) {
  writeJson(path.join(dir, 'state.json'), { lastHand: null });
  writeJson(path.join(dir, 'loop-state.json'), { phase: 'done' });
  const guard = await createCoachControl().assertRollbackAllowed(dir);
  assert.equal(
    guard.reasons?.some((reason) => reason.code === 'pending_annotation') ?? false,
    false,
    JSON.stringify(guard.reasons) ?? 'no rollback reasons',
  );
  assert.equal(guard.ok, true, JSON.stringify(guard.reasons) ?? 'no rollback reasons');
}

test('Q3 M3: machine and annotation mark failures halt after exactly one publish', async (t) => {
  const cases = [
    {
      kind: 'machine',
      seed: () => seedMachine(t, 'holdem-q3-mark-machine-'),
      flush: pipeline.flushMachinePublish,
      method: 'markPublished',
    },
    {
      kind: 'annotation',
      seed: () => seedAnnotation(t, { prefix: 'holdem-q3-mark-annotation-' }),
      flush: pipeline.flushAnnotationPublish,
      method: 'markAnnotationPublished',
    },
  ];

  for (const current of cases) {
    await t.test(current.kind, async () => {
      const { dir } = await current.seed();
      let publishes = 0;
      const injected = new Error(`injected ${current.method}`);
      injected.code = 'INJECTED_MARK_FAILURE';
      const trainingControl = {
        async [current.method]() { throw injected; },
      };
      await assert.rejects(
        current.flush(dir, {
          gameEpoch: EPOCH,
          trainingControl,
          executePublish: async () => { publishes += 1; },
        }),
        (error) => {
          assert.equal(error.code, 'TRAINING_MARK_FAILED');
          assert.equal(
            error.cause?.code === injected.code
              || error.causeCode === injected.code
              || String(error.message).includes(injected.code),
            true,
            'TRAINING_MARK_FAILED did not preserve the mark failure code',
          );
          return true;
        },
      );
      assert.equal(publishes, 1);
    });
  }
});

test('Q3 M3: repeated machine and annotation envelopes fail with TRAINING_FLUSH_NO_PROGRESS', async (t) => {
  const cases = [
    {
      kind: 'machine',
      seed: () => seedMachine(t, 'holdem-q3-progress-machine-'),
      flush: pipeline.flushMachinePublish,
      method: 'markPublished',
    },
    {
      kind: 'annotation',
      seed: () => seedAnnotation(t, { prefix: 'holdem-q3-progress-annotation-' }),
      flush: pipeline.flushAnnotationPublish,
      method: 'markAnnotationPublished',
    },
  ];

  for (const current of cases) {
    await t.test(current.kind, async () => {
      const { dir } = await current.seed();
      let publishes = 0;
      const trainingControl = {
        async [current.method]() { return { noop: true }; },
      };
      await assert.rejects(
        current.flush(dir, {
          gameEpoch: EPOCH,
          trainingControl,
          executePublish: async () => { publishes += 1; },
        }),
        { code: 'TRAINING_FLUSH_NO_PROGRESS' },
      );
      assert.equal(publishes, 1, 'the repeated envelope was posted before no-progress detection');
    });
  }
});

test('Q3 flush locks serialize same-session machine and annotation publication', async (t) => {
  const cases = [
    {
      kind: 'machine',
      staleCode: 'STALE_TRAINING_AUTHORITY',
      seed: () => seedMachine(t, 'holdem-q3-lock-machine-'),
      flush: pipeline.flushMachinePublish,
      rows: (envelope) => envelope.training,
    },
    {
      kind: 'annotation',
      staleCode: 'STALE_ANNOTATION_AUTHORITY',
      seed: () => seedAnnotation(t, { prefix: 'holdem-q3-lock-annotation-' }),
      flush: pipeline.flushAnnotationPublish,
      rows: (envelope) => envelope.trainingAnnotations,
    },
  ];

  for (const current of cases) {
    await t.test(current.kind, async () => {
      const { dir } = await current.seed();
      let active = 0;
      let maxActive = 0;
      let staleFailures = 0;
      let posts = 0;
      const publishedIds = [];
      const executePublish = async (args) => {
        if (active > 0) {
          staleFailures += 1;
          const error = new Error('same-session publication overlapped');
          error.code = current.staleCode;
          throw error;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          posts += 1;
          const envelope = envelopeFromArgs(args);
          publishedIds.push(...current.rows(envelope).map((row) => (
            current.kind === 'annotation' ? `${row.evaluationId}:${row.field}` : row.evaluationId
          )));
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { ok: true };
        } finally {
          active -= 1;
        }
      };

      const outcomes = await Promise.allSettled([
        current.flush(dir, { gameEpoch: EPOCH, executePublish }),
        current.flush(dir, { gameEpoch: EPOCH, executePublish }),
      ]);
      assert.deepEqual(outcomes.map((row) => row.status), ['fulfilled', 'fulfilled']);
      assert.equal(staleFailures, 0, `${current.staleCode} escaped the flush lock`);
      assert.equal(maxActive, 1);
      assert.equal(posts, 1);
      assert.equal(new Set(publishedIds).size, publishedIds.length, 'duplicate publication observed');
    });
  }
});

test('Q3 exact-file recovery reconstructs an unavailable annotation and publishes it', async (t) => {
  const { dir, tc, item } = await seedAnnotation(t, {
    status: 'unavailable',
    prefix: 'holdem-q3-recover-unavailable-',
  });
  fs.unlinkSync(exactFile(dir, item));
  const posted = [];

  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH,
    executePublish: async (args) => { posted.push(envelopeFromArgs(args)); },
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].trainingAnnotations[0].status, 'unavailable');
  assert.deepEqual(readAnnotationExactFile(dir, item.detailRef, 'explanation'), {
    field: 'explanation', status: 'unavailable', value: null,
  });
  const after = tc.loadAuthority(dir);
  assert.equal(after.annotationQueue[item.evaluationId], undefined);
  assert.equal(after.items[item.evaluationId].annotations.explanation.published, true);
  assert.equal(after.items[item.evaluationId].annotations.explanation.sealReason, 'explain-failed');
  await assertRollbackUnblocked(dir);
});

test('Q3 exact-file recovery treats a valid current snapshot as response-lost with zero POST', async (t) => {
  const { dir, tc, item, value } = await seedAnnotation(t, {
    prefix: 'holdem-q3-recover-response-lost-',
  });
  const snapshotRow = projectTrainingAnnotation({
    evaluationId: item.evaluationId,
    payloadSha256: item.payloadSha256,
    field: 'explanation',
    status: 'ready',
    value,
  });
  writeUiSnapshot(dir, item, snapshotRow);
  fs.unlinkSync(exactFile(dir, item));
  let posts = 0;

  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH,
    executePublish: async () => { posts += 1; },
  });

  assert.equal(posts, 0);
  assert.equal(readAnnotationExactFile(dir, item.detailRef, 'explanation').value, value);
  const after = tc.loadAuthority(dir);
  assert.equal(after.annotationQueue[item.evaluationId], undefined);
  assert.equal(after.items[item.evaluationId].annotations.explanation.published, true);
  await assertRollbackUnblocked(dir);
});

test('Q3 exact-file recovery restores a stale machine-digest snapshot then posts current digest once', async (t) => {
  const { dir, tc, item, value } = await seedAnnotation(t, {
    prefix: 'holdem-q3-recover-stale-',
  });
  const legacyMachine = { ...item.summary, explanation: value };
  legacyMachine.payloadSha256 = legacyTrainingPayloadSha256(legacyMachine);
  assert.notEqual(legacyMachine.payloadSha256, item.payloadSha256);
  const staleRow = projectTrainingAnnotation({
    evaluationId: item.evaluationId,
    payloadSha256: legacyMachine.payloadSha256,
    field: 'explanation',
    status: 'ready',
    value,
  });
  writeJson(path.join(dir, 'training', '.digest-map-v2.json'), {
    schemaVersion: 1,
    oldToNew: { [legacyMachine.payloadSha256]: item.payloadSha256 },
    byEvaluationId: {
      [item.evaluationId]: { old: legacyMachine.payloadSha256, new: item.payloadSha256 },
    },
  });
  writeJson(path.join(dir, 'training', '.migration-v2.json'), {
    status: 'session-done',
    at: '2026-09-04T00:00:00.000Z',
    digestMapRef: '.digest-map-v2.json',
  });
  writeUiSnapshot(dir, item, staleRow, { machine: legacyMachine });
  fs.unlinkSync(exactFile(dir, item));
  const posted = [];

  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH,
    executePublish: async (args) => { posted.push(envelopeFromArgs(args)); },
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].trainingAnnotations.length, 1);
  assert.equal(posted[0].trainingAnnotations[0].payloadSha256, item.payloadSha256);
  assert.equal(readAnnotationExactFile(dir, item.detailRef, 'explanation').value, value);
  assert.equal(tc.loadAuthority(dir).annotationQueue[item.evaluationId], undefined);
  await assertRollbackUnblocked(dir);
});

test('Q3 exact-file recovery drops invalid or missing snapshot proof and unblocks rollback', async (t) => {
  const cases = [
    { name: 'snapshot file missing', snapshot: 'missing' },
    { name: 'annotation row missing', snapshot: 'row-missing' },
    { name: 'payloadSha256 missing', snapshot: 'payload-missing' },
    { name: 'deny literal in explanation', snapshot: 'deny-literal', value: `${FIXTURE_POLICY_ID} 노출` },
  ];

  for (const current of cases) {
    await t.test(current.name, async (st) => {
      const seeded = await seedAnnotation(st, {
        value: current.value ?? SAFE_EXPLANATION,
        prefix: `holdem-q3-recover-invalid-${current.snapshot}-`,
      });
      const {
        dir, tc, item, value,
      } = seeded;
      const row = projectTrainingAnnotation({
        evaluationId: item.evaluationId,
        payloadSha256: item.payloadSha256,
        field: 'explanation',
        status: 'ready',
        value,
      });
      if (current.snapshot === 'row-missing') writeUiSnapshot(dir, item, null);
      if (current.snapshot === 'payload-missing') {
        delete row.payloadSha256;
        writeUiSnapshot(dir, item, row);
      }
      if (current.snapshot === 'deny-literal') writeUiSnapshot(dir, item, row);
      fs.unlinkSync(exactFile(dir, item));
      let posts = 0;

      await pipeline.flushAnnotationPublish(dir, {
        gameEpoch: EPOCH,
        executePublish: async () => { posts += 1; },
      });

      assert.equal(posts, 0);
      const after = tc.loadAuthority(dir);
      assert.equal(after.annotationQueue[item.evaluationId], undefined);
      assert.equal(
        after.items[item.evaluationId].annotations.explanation.publishFailed,
        'exact-file-missing',
      );
      assert.equal(after.items[item.evaluationId].annotations.explanation.status, 'ready');
      await assertRollbackUnblocked(dir);
    });
  }
});

test('Q3 post-cutoff accept immediately seals and queues unavailable explanation', async (t) => {
  const dir = freshDir(t, 'holdem-q3-post-cutoff-');
  const tc = createTrainingControl();
  await tc.writeCutoffMarker(dir);
  const evaluation = q3Evaluation(EPOCH);
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH,
    owner: OWNER,
    handNo: 1,
    evaluations: [evaluation],
  });
  let auth = tc.loadAuthority(dir);
  const item = auth.items[evaluation.evaluationId];
  assert.equal(item.annotations.explanation.status, 'unavailable');
  assert.equal(item.annotations.explanation.sealReason, 'post-cutoff');
  assert.equal(auth.annotationQueue[evaluation.evaluationId].explanation.published, false);
  assert.deepEqual(readAnnotationExactFile(dir, item.detailRef, 'explanation'), {
    field: 'explanation', status: 'unavailable', value: null,
  });

  await tc.markPublished(dir, evaluation.evaluationId, item.payloadSha256);
  const posted = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH,
    executePublish: async (args) => { posted.push(envelopeFromArgs(args)); },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].trainingAnnotations[0].status, 'unavailable');
  auth = tc.loadAuthority(dir);
  assert.equal(auth.annotationQueue[evaluation.evaluationId], undefined);
});

test('Q3 M14: cutoff seal requires a durable marker and persists its explicit reason', async (t) => {
  const { dir, tc, evaluation } = await seedMachine(t, 'holdem-q3-cutoff-reason-');
  const rejected = await tc.sealAnnotation(
    dir,
    evaluation.evaluationId,
    'explanation',
    'unavailable',
    { sealReason: 'cutoff' },
  );
  assert.deepEqual(rejected, { ok: false, code: 'CUTOFF_MARKER_REQUIRED' });
  let auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation, undefined);

  await tc.writeCutoffMarker(dir);
  const sealed = await tc.sealAnnotation(
    dir,
    evaluation.evaluationId,
    'explanation',
    'unavailable',
    { sealReason: 'cutoff' },
  );
  assert.equal(sealed.ok, true);
  auth = tc.loadAuthority(dir);
  assert.equal(auth.items[evaluation.evaluationId].annotations.explanation.sealReason, 'cutoff');
});

function javascriptFiles(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) found.push(full);
    }
  };
  visit(root);
  return found;
}

test('Q3 M14 inventory: every literal unavailable seal caller pins an allowed sealReason', () => {
  const allowed = new Set(['cutoff', 'exact-file-missing', 'post-cutoff', 'explain-failed']);
  const inventory = [];
  for (const scope of ['tools', 'test']) {
    for (const file of javascriptFiles(path.join(ROOT, scope))) {
      const source = fs.readFileSync(file, 'utf8');
      let offset = 0;
      for (const statement of source.split(';')) {
        const start = offset;
        offset += statement.length + 1;
        if (!/(?:sealAnnotation|sealExplanation)\s*\(/.test(statement)) continue;
        if (!/['"]unavailable['"]/.test(statement)) continue;
        const line = source.slice(0, start).split('\n').length;
        const reason = /sealReason\s*:\s*['"]([^'"]+)['"]/.exec(statement)?.[1] ?? null;
        inventory.push({
          file: path.relative(ROOT, file),
          line,
          reason,
        });
      }
    }
  }
  assert.ok(inventory.length >= 4, `literal unavailable seal inventory unexpectedly small: ${JSON.stringify(inventory)}`);
  assert.deepEqual(
    inventory.filter((entry) => !allowed.has(entry.reason)),
    [],
    `unreasoned unavailable callers: ${JSON.stringify(inventory)}`,
  );
});
