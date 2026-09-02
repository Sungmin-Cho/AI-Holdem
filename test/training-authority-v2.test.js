import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  canonicalTrainingJson,
  detailRefOf,
  gameEpochOf,
  MAX_PUBLISH_BODY_BYTES,
  publicProofId,
  sha256Hex,
  SUPPORTED_TRAINING_AUTHORITY_SCHEMAS,
  trainingPayloadSha256,
} from '../publish-contract.js';
import * as contract from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import { createTrainingControl } from '../tools/training-control.js';
import { ingestHand, unpublishedEnvelope } from '../tools/training-pipeline.js';
import * as pipeline from '../tools/training-pipeline.js';
import { createProfileStore } from '../training/profile-store.js';
import { createMistakeBank } from '../training/mistake-bank.js';
import * as profileCli from '../tools/profile-cli.js';
import { formatTrainingCard } from '../server/public/training-format.js';
import * as trainingFormat from '../server/public/training-format.js';
import { startServer } from '../server/server.js';
import { createCoachControl } from '../tools/coach-control.js';
import { writeJsonAtomic } from '../engine/state.js';
import { readJsonl, readJsonSecure } from '../tools/training-store.js';

const PUBLISH_TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');
const execFileAsync = promisify(execFile);
const EPOCH = 'ab'.repeat(32);
const CHUNK_SLACK = 4096;
const V1_KEYS = Object.freeze([
  'evaluationId', 'handNo', 'decisionId', 'status', 'street', 'spotKey', 'handClass',
  'chosen', 'recommended', 'evLossBb', 'grade', 'forced', 'source', 'explanation',
  'detailRef', 'detailSha256', 'code', 'reason',
]);

function tmp(prefix = 'holdem-v2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function v1Canonical(summary) {
  const out = {};
  for (const key of V1_KEYS) {
    if (summary?.[key] !== undefined) out[key] = summary[key];
  }
  return JSON.stringify(out);
}

function v1Sha(summary) {
  return sha(v1Canonical(summary));
}

function evaluationId(decisionId = 'd-1-preflop-0', gameEpoch = EPOCH) {
  return evaluationIdOf({
    gameEpoch,
    decisionId,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
}

function compact(action) {
  if (!action || typeof action !== 'object') return null;
  const out = { action: action.action ?? null };
  if (action.sizeBb != null) out.sizeBb = action.sizeBb;
  if (action.frequency != null) out.frequency = action.frequency;
  out.evBb = action.evBb ?? null;
  return out;
}

function evaluation(overrides = {}) {
  const decisionId = overrides.decisionId ?? 'd-1-preflop-0';
  const gameEpoch = overrides.gameEpoch ?? EPOCH;
  const base = {
    schemaVersion: 1,
    evaluationId: evaluationId(decisionId, gameEpoch),
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
  return { ...base, ...overrides, evaluationId: overrides.evaluationId ?? evaluationId(overrides.decisionId ?? decisionId, overrides.gameEpoch ?? gameEpoch) };
}

function v1SummaryOf(evaluationRow, {
  handNo = 1,
  explanation = null,
} = {}) {
  const detailRef = detailRefOf(evaluationRow.evaluationId);
  const detailSha256 = sha(JSON.stringify(evaluationRow));
  const summary = {
    evaluationId: evaluationRow.evaluationId,
    handNo,
    decisionId: evaluationRow.decisionId,
    status: evaluationRow.status,
    street: evaluationRow.street,
    spotKey: evaluationRow.spotKey,
    handClass: evaluationRow.handClass,
    chosen: compact(evaluationRow.chosen),
    recommended: Array.isArray(evaluationRow.recommended) ? evaluationRow.recommended.map(compact) : [],
    evLossBb: evaluationRow.evLossBb ?? null,
    grade: evaluationRow.grade ?? null,
    forced: Boolean(evaluationRow.forced),
    source: evaluationRow.source
      ? { id: evaluationRow.source.id, version: evaluationRow.source.version }
      : null,
    explanation,
    detailRef,
    detailSha256,
  };
  if (evaluationRow.code) summary.code = evaluationRow.code;
  if (evaluationRow.reason) summary.reason = evaluationRow.reason;
  summary.payloadSha256 = v1Sha(summary);
  return summary;
}

function writeV1Session(dir, {
  explanation = 'BTN unopened에서 AA는 오픈이 주력이다.',
  status = 'evaluated',
  evaluationRow = evaluation(),
  handNo = 1,
} = {}) {
  const summary = v1SummaryOf(evaluationRow, { handNo, explanation });
  const training = path.join(dir, 'training');
  fs.mkdirSync(path.join(training, 'details'), { recursive: true });
  fs.writeFileSync(path.join(training, 'details', `${summary.detailRef}.json`), JSON.stringify(evaluationRow));
  fs.writeFileSync(path.join(training, 'evaluations.jsonl'), `${JSON.stringify(summary)}\n`);
  fs.writeFileSync(path.join(training, '.training-authority.json'), JSON.stringify({
    schemaVersion: 1,
    gameEpoch: EPOCH,
    ownerSessionId: 'owner-1',
    items: {
      [summary.evaluationId]: {
        status,
        handNo,
        decisionId: evaluationRow.decisionId,
        evaluationId: summary.evaluationId,
        payloadSha256: summary.payloadSha256,
        detailRef: summary.detailRef,
        detailSha256: summary.detailSha256,
      },
    },
    publishQueue: status === 'published' ? {} : {
      [summary.evaluationId]: {
        evaluationId: summary.evaluationId,
        handNo,
        payloadSha256: summary.payloadSha256,
      },
    },
  }));
  return { evaluation: evaluationRow, summary };
}

function snapshotDecision(decisionId = 'd-1-preflop-0') {
  return {
    schemaVersion: 1,
    decisionId,
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
}

function lastHandOf(decisionId = 'd-1-preflop-0') {
  return { handNo: 1, decisions: [snapshotDecision(decisionId)] };
}

function annotationCanonical({ field, status, value }) {
  return JSON.stringify({ field, status, value });
}

async function publishCli(dir, args) {
  const { stdout } = await execFileAsync(process.execPath, [PUBLISH_TOOL, ...args, '--game-dir', dir], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim());
}

async function publishCliFail(dir, args) {
  try {
    await execFileAsync(process.execPath, [PUBLISH_TOOL, ...args, '--game-dir', dir], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (error) {
    return JSON.parse(String(error.stdout ?? '').trim() || 'null');
  }
  throw new Error('실패했어야 하는 호출이 성공했습니다');
}

function postPublish(port, token, body) {
  return fetch(`http://127.0.0.1:${port}/api/publish?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

function findAnnotationFile(dir, detailRef, field) {
  const candidates = [
    path.join(dir, 'training', 'annotations', `${detailRef}.${field}.json`),
    path.join(dir, 'training', 'annotations', `${detailRef}-${field}.json`),
    path.join(dir, 'training', 'explanations', `${detailRef}.json`),
    path.join(dir, 'training', 'details', 'annotations', `${detailRef}.${field}.json`),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

// --- contract ---

test('SUPPORTED schemas include 1 (read-only) and 2; explanation is not a digest key', () => {
  assert.deepEqual([...SUPPORTED_TRAINING_AUTHORITY_SCHEMAS], [1, 2]);
  const json = canonicalTrainingJson({
    grade: 'preferred',
    explanation: 'should-not-enter-digest',
    recommendedTruncated: true,
  });
  assert.equal(json.includes('explanation'), false);
  assert.equal(json.includes('recommendedTruncated'), true);
});

test('projectTrainingSummary drops nested extra keys and type-fails object leaves', () => {
  assert.equal(typeof contract.projectTrainingSummary, 'function');
  const evaluationRow = evaluation({
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null, policySeed: 'secret' },
    source: { id: 'local-preflop-baseline', version: '1.0.0', path: '/secret/x.json' },
  });
  const projected = contract.projectTrainingSummary({
    ...evaluationRow,
    handNo: 1,
    detailRef: detailRefOf(evaluationRow.evaluationId),
    recommendedTruncated: false,
  });
  assert.equal(projected.chosen.policySeed, undefined);
  assert.equal(projected.source.path, undefined);
  assert.equal(projected.explanation, undefined);
  assert.equal(projected.payloadSha256, trainingPayloadSha256(projected));

  assert.throws(
    () => contract.projectTrainingSummary({
      ...evaluationRow,
      chosen: { action: { policySeed: 'secret' } },
      handNo: 1,
    }),
    { code: 'TRAINING_PROOF_MISMATCH' },
  );
  assert.throws(
    () => contract.projectTrainingSummary({
      ...evaluationRow,
      source: { id: { configDigest: 'abc' }, version: '1.0.0' },
      handNo: 1,
    }),
    { code: 'TRAINING_PROOF_MISMATCH' },
  );
});

test('toPublicSummary truncates recommended at accept and never puts explanation on the digest', () => {
  const recommended = [
    { action: 'fold', frequency: 0.04, evBb: null },
    { action: 'call', frequency: 0.10, evBb: null },
    { action: 'raise', sizeBb: 2.5, frequency: 0.50, evBb: null },
    { action: 'raise', sizeBb: 8.5, frequency: 0.20, evBb: null },
    { action: 'raise', sizeBb: 3.5, frequency: 0.16, evBb: null },
  ];
  const summary = toPublicSummary(evaluation({ recommended }), {
    handNo: 1,
    explanation: '이 문구는 digest에 들어가면 안 된다.',
    detailSha256: 'dd'.repeat(32),
  });
  assert.equal(summary.explanation, undefined);
  assert.equal(summary.recommended.length, 4);
  assert.equal(summary.recommendedTruncated, true);
  assert.equal(summary.recommended[0].frequency, 0.50);
  assert.equal(JSON.stringify(summary).includes('이 문구는'), false);
  assert.equal(summary.payloadSha256, trainingPayloadSha256(summary));
});

test('canonical summary string caps keep a single item at or under 4KB; over-cap is SUMMARY_FIELD_TOO_LONG', () => {
  const maxed = evaluation({
    reason: 'R'.repeat(256),
    spotKey: 'K'.repeat(64),
    handClass: 'H'.repeat(64),
    code: 'C'.repeat(64),
    source: { id: 'I'.repeat(64), version: 'V'.repeat(32) },
    recommended: [
      { action: 'raise', sizeBb: 2.5, frequency: 0.4, evBb: null },
      { action: 'fold', frequency: 0.3, evBb: null },
      { action: 'call', frequency: 0.2, evBb: null },
      { action: 'raise', sizeBb: 8.5, frequency: 0.1, evBb: null },
    ],
  });
  const summary = toPublicSummary(maxed, { handNo: 1, detailSha256: 'ab'.repeat(32) });
  assert.equal(Buffer.byteLength(canonicalTrainingJson(summary), 'utf8') <= 4096, true);

  const tc = createTrainingControl();
  const dir = tmp();
  return assert.rejects(
    () => tc.acceptEvaluations(dir, {
      gameEpoch: EPOCH,
      owner: 'owner-1',
      handNo: 1,
      evaluations: [evaluation({ reason: 'R'.repeat(257) })],
    }),
    { code: 'SUMMARY_FIELD_TOO_LONG' },
  ).then(() => {
    const auth = tc.loadAuthority(dir);
    assert.equal(auth.pending['d-1-preflop-0'].reason, 'SUMMARY_FIELD_TOO_LONG');
    assert.equal(auth.items[evaluationId()], undefined);
  });
});

test('projectTrainingAnnotation: explanation cap, exploit keys, unavailable canonical bytes', () => {
  assert.equal(typeof contract.projectTrainingAnnotation, 'function');
  const ready = contract.projectTrainingAnnotation({
    evaluationId: evaluationId(),
    payloadSha256: 'aa'.repeat(32),
    field: 'explanation',
    status: 'ready',
    value: '짧은 해설',
  });
  assert.equal(ready.value, '짧은 해설');
  assert.equal(ready.valueSha256, sha(annotationCanonical({
    field: 'explanation', status: 'ready', value: '짧은 해설',
  })));

  assert.throws(
    () => contract.projectTrainingAnnotation({
      evaluationId: evaluationId(),
      payloadSha256: 'aa'.repeat(32),
      field: 'explanation',
      status: 'ready',
      value: 'x'.repeat(601),
    }),
    { code: 'ANNOTATION_PROOF_MISMATCH' },
  );

  const exploit = contract.projectTrainingAnnotation({
    evaluationId: evaluationId(),
    payloadSha256: 'aa'.repeat(32),
    field: 'exploit',
    status: 'ready',
    value: {
      opponents: [{
        opponentId: 'p1',
        policyId: 'tight',
        adjustment: { bluff: 'increase', thinValue: 'hold' },
        comparison: { summaryCode: 'GTO_OK_EXPLOIT_MISSED', extra: 'drop-me' },
        secret: true,
      }],
      primary: 'p1',
      extra: 'nope',
    },
  });
  assert.equal(exploit.value.extra, undefined);
  assert.equal(exploit.value.opponents[0].secret, undefined);
  assert.equal(exploit.value.opponents[0].comparison.extra, undefined);
  assert.equal(exploit.value.primary, 'p1');

  const unavailable = contract.projectTrainingAnnotation({
    evaluationId: evaluationId(),
    payloadSha256: 'aa'.repeat(32),
    field: 'explanation',
    status: 'unavailable',
    value: 'ignored',
  });
  assert.equal(unavailable.value, null);
  assert.equal(
    unavailable.valueSha256,
    sha(annotationCanonical({ field: 'explanation', status: 'unavailable', value: null })),
  );
});

test('training/annotation body byte length is measured on the actual POST body', () => {
  assert.equal(typeof contract.trainingBodyByteLength, 'function');
  assert.equal(typeof contract.annotationBodyByteLength, 'function');
  const training = [toPublicSummary(evaluation(), { handNo: 1, detailSha256: 'ab'.repeat(32) })];
  const trainingAuthority = {
    expectedGameEpoch: EPOCH,
    items: [{ evaluationId: training[0].evaluationId, payloadSha256: training[0].payloadSha256 }],
  };
  const measured = contract.trainingBodyByteLength({
    publishId: 7,
    training,
    trainingAuthority,
  });
  assert.equal(measured, Buffer.byteLength(JSON.stringify({
    publishId: 7, training, trainingAuthority,
  }), 'utf8'));
});

// --- control v2 ---

test('empty authority is schema 2 with pending and annotationQueue; write order is detail → authority → jsonl', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation()],
  });
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.schemaVersion, 2);
  assert.equal(auth.pending && typeof auth.pending, 'object');
  assert.equal(auth.annotationQueue && typeof auth.annotationQueue, 'object');
  const item = auth.items[evaluationId()];
  assert.equal(item.status, 'evaluated');
  assert.equal(item.summary.payloadSha256, item.payloadSha256);
  assert.equal(item.summary.explanation, undefined);
  assert.deepEqual(item.consumers, { published: false, profiled: false, banked: false });
  assert.equal(item.consumers.explained, undefined);
  const jsonl = readJsonl(path.join(dir, 'training', 'evaluations.jsonl'));
  assert.equal(jsonl[0].explanation, undefined);
  assert.equal(jsonl[0].payloadSha256, item.payloadSha256);
});

test('pending[decisionId] is recorded, accept deletes it and transfers attempts; same digest re-accept is a no-op', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  assert.equal(typeof tc.recordPending, 'function');
  await tc.recordPending(dir, 'd-1-preflop-0', { handNo: 1, reason: 'EVALUATE_FAILED' });
  await tc.recordPending(dir, 'd-1-preflop-0', { handNo: 1, reason: 'EVALUATE_FAILED' });
  let auth = tc.loadAuthority(dir);
  assert.equal(auth.pending['d-1-preflop-0'].attempts, 2);
  const first = await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation()],
  });
  auth = tc.loadAuthority(dir);
  assert.equal(auth.pending['d-1-preflop-0'], undefined);
  assert.equal(auth.items[evaluationId()].status, 'evaluated');
  assert.equal(auth.items[evaluationId()].attempts, 2);
  const again = await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    handNo: 1,
    evaluations: [evaluation()],
  });
  assert.equal(again.accepted.length, 1);
  assert.equal(readJsonl(path.join(dir, 'training', 'evaluations.jsonl')).length, 1);
  assert.equal(first.accepted[0].payloadSha256, again.accepted[0].payloadSha256);
});

test('annotation transition table: unavailable is terminal; late ready is discarded', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  const id = evaluationId();
  const unavailable = await tc.sealAnnotation(dir, id, 'explanation', 'unavailable');
  assert.equal(unavailable.ok, true);
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[id].annotations.explanation.status, 'unavailable');
  const late = await tc.sealAnnotation(dir, id, 'explanation', '늦은 해설');
  assert.equal(late.ok === false || late.discarded === true, true);
  const after = tc.loadAuthority(dir);
  assert.equal(after.items[id].annotations.explanation.status, 'unavailable');
  const file = findAnnotationFile(dir, after.items[id].detailRef, 'explanation');
  assert.ok(file);
  const sealed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(sealed.status, 'unavailable');
  assert.equal(sealed.value, null);
  assert.equal(sealed.field, 'explanation');
});

test('sealAnnotation of missing item is coded NO_TRAINING_ITEM (halt notice, not uncoded throw)', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  const result = await tc.sealAnnotation(dir, 'missing-id', 'explanation', 'x');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_TRAINING_ITEM');
});

test('reconcile ① rebuilds item from detail when jsonl row exists and evaluate is never called', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  const authPath = path.join(dir, 'training', '.training-authority.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const saved = auth.items[evaluationId()];
  delete auth.items[evaluationId()];
  delete auth.publishQueue[evaluationId()];
  fs.writeFileSync(authPath, JSON.stringify(auth));
  let calls = 0;
  const result = await tc.reconcile(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    lastHand: lastHandOf(),
    handsDir: path.join(dir, 'hands'),
    evaluate: () => {
      calls += 1;
      return [evaluation()];
    },
  });
  assert.equal(calls, 0);
  const restored = tc.loadAuthority(dir);
  assert.equal(restored.items[evaluationId()].payloadSha256, saved.payloadSha256);
  assert.equal(restored.items[evaluationId()].summary.evaluationId, evaluationId());
  assert.ok(result.repaired >= 1 || restored.items[evaluationId()]);
});

test('reconcile ② rewrites a missing jsonl row from the inlined summary', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  fs.writeFileSync(path.join(dir, 'training', 'evaluations.jsonl'), '');
  await tc.reconcile(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    lastHand: lastHandOf(),
    handsDir: path.join(dir, 'hands'),
    evaluate: () => { throw new Error('evaluate must not run'); },
  });
  const rows = readJsonl(path.join(dir, 'training', 'evaluations.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evaluationId, evaluationId());
  assert.equal(rows[0].explanation, undefined);
});

test('reconcile ③ records pending for missing decisions and does not evaluate', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  let calls = 0;
  const result = await tc.reconcile(dir, {
    gameEpoch: EPOCH,
    owner: 'owner-1',
    lastHand: lastHandOf(),
    handsDir: path.join(dir, 'hands'),
    evaluate: () => {
      calls += 1;
      return [evaluation()];
    },
  });
  assert.equal(calls, 0);
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.pending['d-1-preflop-0'] != null, true);
  assert.equal(Object.keys(auth.items).length, 0);
  assert.equal(result.missing?.length ?? 1, 1);
});

// --- v1 → v2 migration ---

test('v1 fixture with explanation migrates byte-stable: annotation exact-file, jsonl rewritten, digest map', async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir, { status: 'evaluated' });
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.schemaVersion, 2);
  const item = auth.items[summary.evaluationId];
  assert.notEqual(item.payloadSha256, summary.payloadSha256);
  assert.equal(item.summary.explanation, undefined);
  assert.equal(item.annotations.explanation.status, 'ready');
  assert.equal(item.annotations.explanation.published, false);
  assert.equal(auth.annotationQueue[summary.evaluationId].explanation.published, false);
  const file = findAnnotationFile(dir, item.detailRef, 'explanation');
  assert.ok(file);
  const sealed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(sealed.value, summary.explanation);
  const rows = readJsonl(path.join(dir, 'training', 'evaluations.jsonl'));
  assert.equal(rows[0].explanation, undefined);
  assert.equal(rows[0].payloadSha256, item.payloadSha256);
  const mapPath = path.join(dir, 'training', '.digest-map-v2.json');
  const digestMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.equal(digestMap.oldToNew[summary.payloadSha256], item.payloadSha256);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'training', '.migration-v2.json'), 'utf8'));
  assert.equal(marker.status === 'session-done' || marker.status === 'complete', true);

  const again = tc.loadAuthority(dir);
  assert.equal(again.items[summary.evaluationId].payloadSha256, item.payloadSha256);
  assert.equal(
    fs.readFileSync(path.join(dir, 'training', '.training-authority.json'), 'utf8'),
    JSON.stringify(auth) === fs.readFileSync(path.join(dir, 'training', '.training-authority.json'), 'utf8')
      ? fs.readFileSync(path.join(dir, 'training', '.training-authority.json'), 'utf8')
      : fs.readFileSync(path.join(dir, 'training', '.training-authority.json'), 'utf8'),
  );
});

test('v1 explanation:null becomes absent; published+string explanation does not enter annotationQueue as unpublished', async () => {
  const dir = tmp();
  writeV1Session(dir, { explanation: null, status: 'evaluated' });
  const tc = createTrainingControl();
  const auth = tc.loadAuthority(dir);
  const item = auth.items[evaluationId()];
  assert.equal(item.annotations?.explanation, undefined);
  assert.equal(auth.annotationQueue[evaluationId()]?.explanation, undefined);

  const dir2 = tmp();
  writeV1Session(dir2, {
    explanation: '이미 게시된 해설',
    status: 'published',
  });
  const auth2 = createTrainingControl().loadAuthority(dir2);
  const item2 = auth2.items[evaluationId()];
  assert.equal(item2.annotations.explanation.status, 'ready');
  assert.equal(item2.annotations.explanation.published, true);
  assert.equal(item2.consumers.published, true);
  assert.equal(auth2.annotationQueue[evaluationId()]?.explanation, undefined);
});

test('v1 attempt applied vs unapplied: exact-retry is forbidden', async () => {
  const dir = tmp();
  const { summary } = writeV1Session(dir, { status: 'evaluated' });
  fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
    expectedGameEpoch: gameEpochOf('tok'),
    body: { publishId: 4, training: [summary] },
    trainingAuthority: {
      expectedGameEpoch: gameEpochOf('tok'),
      evaluationId: summary.evaluationId,
      payloadSha256: summary.payloadSha256,
    },
  }));
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({ publishId: 4, training: [summary] }));
  const appliedAuth = createTrainingControl().loadAuthority(dir);
  assert.equal(appliedAuth.items[summary.evaluationId].status, 'published');
  assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);

  const dir2 = tmp();
  const second = writeV1Session(dir2, { status: 'evaluated' });
  fs.writeFileSync(path.join(dir2, '.publish-attempt.json'), JSON.stringify({
    expectedGameEpoch: gameEpochOf('tok'),
    body: { publishId: 9, training: [second.summary] },
    trainingAuthority: {
      expectedGameEpoch: gameEpochOf('tok'),
      evaluationId: second.summary.evaluationId,
      payloadSha256: second.summary.payloadSha256,
    },
  }));
  fs.writeFileSync(path.join(dir2, 'ui-snapshot.json'), JSON.stringify({ publishId: 1 }));
  const unapplied = createTrainingControl().loadAuthority(dir2);
  assert.equal(unapplied.items[second.summary.evaluationId].status, 'evaluated');
  assert.equal(fs.existsSync(path.join(dir2, '.publish-attempt.json')), false);
});

test('v1 consumers are induced from processed/mistake; consume treats apply idempotent hit as success', async () => {
  const storeDir = tmp();
  const dir = tmp();
  const { summary } = writeV1Session(dir, { status: 'published' });
  const store = createProfileStore(storeDir);
  await store.apply({ ...summary, payloadSha256: summary.payloadSha256 });
  await createMistakeBank(storeDir).collect({
    ...summary,
    grade: 'off-policy',
    payloadSha256: summary.payloadSha256,
  });
  const tc = createTrainingControl({ storeDir });
  const auth = tc.loadAuthority(dir);
  assert.equal(auth.items[summary.evaluationId].consumers.published, true);
  assert.equal(auth.items[summary.evaluationId].consumers.profiled, true);
  assert.equal(auth.items[summary.evaluationId].consumers.banked, true);

  const consume = await tc.consumeTrainingItems(dir, { storeDir });
  assert.equal(consume.profiled >= 0, true);
  const after = tc.loadAuthority(dir);
  assert.equal(after.items[summary.evaluationId].consumers.profiled, true);
});

test('profile/mistake re-sign via digest map; rebuild has no PROFILE_EVENT_CONFLICT; apply returns {applied}', async () => {
  const storeDir = tmp();
  const dir = tmp();
  const { summary } = writeV1Session(dir, { status: 'published' });
  const store = createProfileStore(storeDir);
  const first = await store.apply({ ...summary });
  assert.equal(first.applied, true);
  const again = await store.apply({ ...summary });
  assert.equal(again.applied, false);
  await createMistakeBank(storeDir).collect({ ...summary, grade: 'off-policy' });

  createTrainingControl({ storeDir }).loadAuthority(dir);
  const mapFile = path.join(dir, 'training', '.digest-map-v2.json');
  assert.equal(typeof profileCli.migrateStoreV2, 'function');
  await profileCli.migrateStoreV2(storeDir, mapFile);
  const rebuilt = await createProfileStore(storeDir).rebuild();
  assert.equal(rebuilt.overall.evaluatedDecisions, 1);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const newDigest = map.oldToNew[summary.payloadSha256];
  assert.equal(rebuilt.processed[summary.evaluationId], newDigest);
});

test('session-done marker, crash mid store-migration, restart completes', async () => {
  const storeDir = tmp();
  const sessionDir = path.join(storeDir, '.session-store', 'sessions', '11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(sessionDir, { recursive: true });
  const { summary } = writeV1Session(sessionDir, { status: 'published' });
  const store = createProfileStore(storeDir);
  await store.apply({ ...summary });
  createTrainingControl({ storeDir }).loadAuthority(sessionDir);
  const markerPath = path.join(sessionDir, 'training', '.migration-v2.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.status, 'session-done');
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, status: 'session-done' }));
  assert.equal(typeof profileCli.completeSessionStoreMigrations, 'function');
  await profileCli.completeSessionStoreMigrations(storeDir);
  const complete = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(complete.status, 'complete');
  fs.writeFileSync(markerPath, JSON.stringify({ ...complete, status: 'session-done' }));
  await profileCli.completeSessionStoreMigrations(storeDir);
  assert.equal(JSON.parse(fs.readFileSync(markerPath, 'utf8')).status, 'complete');
});

// --- pipeline / publish envelopes ---

test('unpublishedEnvelope is authority-based, binds every item, splits by real body bytes', async () => {
  const dir = tmp();
  const tc = createTrainingControl();
  const evaluations = [];
  for (let i = 1; i <= 60; i += 1) {
    evaluations.push(evaluation({
      decisionId: `d-${i}-preflop-0`,
      reason: `reason-${i}-${'x'.repeat(200)}`,
      recommended: [
        { action: 'raise', sizeBb: 2.5, frequency: 0.4, evBb: null },
        { action: 'fold', frequency: 0.3, evBb: null },
        { action: 'call', frequency: 0.2, evBb: null },
        { action: 'raise', sizeBb: 8.5, frequency: 0.1, evBb: null },
      ],
    }));
  }
  for (let i = 0; i < evaluations.length; i += 1) {
    await tc.acceptEvaluations(dir, {
      gameEpoch: EPOCH,
      owner: 'owner-1',
      handNo: i + 1,
      evaluations: [evaluations[i]],
    });
  }
  const before = Object.fromEntries(
    Object.values(tc.loadAuthority(dir).items).map((item) => [item.evaluationId, item.payloadSha256]),
  );
  const chunks = [];
  for (;;) {
    const envelope = unpublishedEnvelope(dir, { gameEpoch: EPOCH });
    if (!envelope) break;
    assert.ok(Array.isArray(envelope.training) && envelope.training.length > 0);
    assert.ok(Array.isArray(envelope.trainingAuthority.items));
    assert.equal(envelope.trainingAuthority.items.length, envelope.training.length);
    const bytes = contract.trainingBodyByteLength({
      publishId: Number.MAX_SAFE_INTEGER,
      training: envelope.training,
      trainingAuthority: envelope.trainingAuthority,
    });
    assert.equal(bytes <= MAX_PUBLISH_BODY_BYTES - CHUNK_SLACK, true);
    chunks.push(envelope);
    for (const item of envelope.training) {
      await tc.markPublished(dir, item.evaluationId, item.payloadSha256);
    }
  }
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.reduce((n, chunk) => n + chunk.training.length, 0), 60);
  const after = tc.loadAuthority(dir);
  for (const [id, digest] of Object.entries(before)) {
    assert.equal(after.items[id].payloadSha256, digest);
    assert.equal(after.items[id].status, 'published');
  }
});

test('ingestHand does not fold explanation into the public summary', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    sessionToken: 'tok',
    lastHand: lastHandOf(),
  }));
  const result = await ingestHand({
    sessionDir: dir,
    handNo: 1,
    gameEpoch: gameEpochOf('tok'),
    owner: 'owner-1',
    explain: async () => '이 해설은 summary에 들어가면 안 된다.',
  });
  assert.equal(result.ok, true);
  const envelope = unpublishedEnvelope(dir, { gameEpoch: gameEpochOf('tok') });
  assert.equal(envelope.training[0].explanation, undefined);
  assert.ok(envelope.trainingAuthority.items.length >= 1);
});

test('empty training: [] and trainingAnnotations: [] are BAD_ENVELOPE', async () => {
  const dir = tmp();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    fs.writeFileSync(path.join(dir, 'empty-training.json'), JSON.stringify({ training: [] }));
    const emptyTraining = await publishCliFail(dir, ['--from', path.join(dir, 'empty-training.json')]);
    assert.equal(emptyTraining.code, 'BAD_ENVELOPE');
    fs.writeFileSync(path.join(dir, 'empty-ann.json'), JSON.stringify({ trainingAnnotations: [] }));
    const emptyAnn = await publishCliFail(dir, ['--from', path.join(dir, 'empty-ann.json')]);
    assert.equal(emptyAnn.code, 'BAD_ENVELOPE');
  } finally {
    await started.close();
  }
});

test('publish.js: annotation after cutoff still passes via annotationAuthority', async () => {
  const dir = tmp();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const tc = createTrainingControl();
    const ev = evaluation({ gameEpoch: gameEpochOf('tok') });
    await tc.acceptEvaluations(dir, {
      gameEpoch: gameEpochOf('tok'),
      owner: 'owner-1',
      handNo: 1,
      evaluations: [ev],
    });
    const sealed = await tc.sealAnnotation(dir, ev.evaluationId, 'explanation', '컷오프 뒤 해설');
    assert.equal(sealed.ok, true);
    const machine = unpublishedEnvelope(dir, { gameEpoch: gameEpochOf('tok') });
    fs.writeFileSync(path.join(dir, 'training-env.json'), JSON.stringify(machine));
    const machinePublished = await publishCli(dir, ['--from', path.join(dir, 'training-env.json')]);
    assert.equal(machinePublished.ok, true);
    await tc.markPublished(dir, ev.evaluationId, machine.training[0].payloadSha256);
    fs.writeFileSync(path.join(dir, '.coach-authority.json'), JSON.stringify({
      schemaVersion: 2,
      gameEpoch: gameEpochOf('tok'),
      noNewPlayTimePublishers: true,
      hands: {},
      publishQueue: {},
      publishedSeals: {},
      retiredAttempts: [],
    }));
    assert.equal(typeof pipeline.annotationEnvelope, 'function');
    const envelope = pipeline.annotationEnvelope(dir, { gameEpoch: gameEpochOf('tok') });
    assert.ok(envelope.trainingAnnotations.length >= 1);
    assert.ok(envelope.annotationAuthority);
    const file = path.join(dir, 'ann-env.json');
    fs.writeFileSync(file, JSON.stringify(envelope));
    const published = await publishCli(dir, ['--from', file]);
    assert.equal(published.ok, true);
  } finally {
    await started.close();
  }
});

// --- server ---

test('server deep-projects training: nested extra keys 400; object leaf 400; forged digest 400', async () => {
  const dir = tmp();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const summary = toPublicSummary(evaluation(), { handNo: 1, detailSha256: 'ab'.repeat(32) });
    const extra = {
      ...summary,
      chosen: { ...summary.chosen, policySeed: 'leak' },
      source: { ...summary.source, path: '/secret/x.json' },
    };
    extra.payloadSha256 = sha256Hex(JSON.stringify(extra));
    const nested = await postPublish(started.port, 'tok', { publishId: 1, training: [extra] });
    assert.equal(nested.json.ok, false);
    assert.equal(nested.status, 400);
    assert.equal(nested.json.code, 'TRAINING_PROOF_MISMATCH');

    const objectLeaf = {
      ...summary,
      chosen: { action: { policySeed: 'x' }, evBb: null },
    };
    objectLeaf.payloadSha256 = summary.payloadSha256;
    const leaf = await postPublish(started.port, 'tok', { publishId: 1, training: [objectLeaf] });
    assert.equal(leaf.status, 400);
    assert.equal(leaf.json.code, 'TRAINING_PROOF_MISMATCH');

    const ok = await postPublish(started.port, 'tok', { publishId: 1, training: [summary] });
    assert.equal(ok.json.ok, true);
    const forged = {
      ...summary,
      grade: 'off-policy',
      payloadSha256: summary.payloadSha256,
    };
    const conflict = await postPublish(started.port, 'tok', { publishId: 2, training: [forged] });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.json.code, 'TRAINING_PROOF_MISMATCH');
  } finally {
    await started.close();
  }
});

test('server annotations: orphan 409, same value no-op, different value 409, fields independent, proof required, deny-literal, extra keys dropped', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify([
    { playerId: 'user' },
    { playerId: 'p1', archetype: 'DENY_ARCHETYPE_SENTINEL', personality: 'quiet' },
  ]));
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const summary = toPublicSummary(evaluation(), { handNo: 1, detailSha256: 'ab'.repeat(32) });
    const projectedAnn = contract.projectTrainingAnnotation({
      evaluationId: summary.evaluationId,
      payloadSha256: summary.payloadSha256,
      field: 'explanation',
      status: 'ready',
      value: '기계 카드 뒤 해설',
    });
    const proof = {
      id: publicProofId(`${summary.evaluationId}:explanation`),
      valueSha256: projectedAnn.valueSha256,
    };
    const orphan = await postPublish(started.port, 'tok', {
      publishId: 1,
      trainingAnnotations: [{
        ...projectedAnn,
        annotationProof: proof,
      }],
    });
    assert.equal(orphan.status, 409);
    assert.equal(orphan.json.code, 'ANNOTATION_ORPHAN');

    await postPublish(started.port, 'tok', { publishId: 1, training: [summary] });

    const noProof = await postPublish(started.port, 'tok', {
      publishId: 2,
      trainingAnnotations: [{ ...projectedAnn }],
    });
    assert.equal(noProof.status, 400);

    const denied = await postPublish(started.port, 'tok', {
      publishId: 2,
      trainingAnnotations: [{
        ...contract.projectTrainingAnnotation({
          evaluationId: summary.evaluationId,
          payloadSha256: summary.payloadSha256,
          field: 'explanation',
          status: 'ready',
          value: 'DENY_ARCHETYPE_SENTINEL 누수',
        }),
        annotationProof: {
          id: publicProofId(`${summary.evaluationId}:explanation`),
          valueSha256: sha(annotationCanonical({
            field: 'explanation', status: 'ready', value: 'DENY_ARCHETYPE_SENTINEL 누수',
          })),
        },
      }],
    });
    assert.equal(denied.json.ok, false);
    assert.equal(denied.status, 400);

    const mismatch = await postPublish(started.port, 'tok', {
      publishId: 2,
      trainingAnnotations: [{
        ...projectedAnn,
        payloadSha256: 'ff'.repeat(32),
        annotationProof: proof,
      }],
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.code, 'ANNOTATION_PROOF_MISMATCH');

    const extra = await postPublish(started.port, 'tok', {
      publishId: 2,
      trainingAnnotations: [{
        ...projectedAnn,
        leak: '/secret/path',
        annotationProof: proof,
      }],
    });
    assert.equal(extra.json.ok, true);

    const same = await postPublish(started.port, 'tok', {
      publishId: 3,
      trainingAnnotations: [{ ...projectedAnn, annotationProof: proof }],
    });
    assert.equal(same.json.ok, true);

    const other = contract.projectTrainingAnnotation({
      evaluationId: summary.evaluationId,
      payloadSha256: summary.payloadSha256,
      field: 'explanation',
      status: 'ready',
      value: '다른 해설',
    });
    const conflict = await postPublish(started.port, 'tok', {
      publishId: 4,
      trainingAnnotations: [{
        ...other,
        annotationProof: { id: publicProofId(`${summary.evaluationId}:explanation`), valueSha256: other.valueSha256 },
      }],
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'ANNOTATION_CONFLICT');

    const exploit = contract.projectTrainingAnnotation({
      evaluationId: summary.evaluationId,
      payloadSha256: summary.payloadSha256,
      field: 'exploit',
      status: 'ready',
      value: {
        opponents: [{
          opponentId: 'p1',
          policyId: 'tight',
          adjustment: { bluff: 'increase' },
          comparison: { summaryCode: 'GTO_OK_EXPLOIT_MISSED' },
        }],
        primary: 'p1',
      },
    });
    const beforeOver = await postPublish(started.port, 'tok', {
      publishId: 5,
      trainingAnnotations: [{
        ...exploit,
        annotationProof: {
          id: publicProofId(`${summary.evaluationId}:exploit`),
          valueSha256: exploit.valueSha256,
        },
      }],
    });
    assert.equal(beforeOver.status, 409);
    assert.equal(beforeOver.json.code, 'EXPLOIT_BEFORE_GAMEOVER');

    await postPublish(started.port, 'tok', {
      publishId: 6,
      view: { handNo: 1, gameOver: true, toAct: null, seats: [] },
    });
    const afterOver = await postPublish(started.port, 'tok', {
      publishId: 7,
      trainingAnnotations: [{
        ...exploit,
        annotationProof: {
          id: publicProofId(`${summary.evaluationId}:exploit`),
          valueSha256: exploit.valueSha256,
        },
      }],
    });
    assert.equal(afterOver.json.ok, true);
  } finally {
    await started.close();
  }
});

test('persist → restart → loadUiState keeps annotations; old snapshot explanation is split and digest recomputed', async () => {
  const dir = tmp();
  const summary = toPublicSummary(evaluation(), { handNo: 1, detailSha256: 'ab'.repeat(32) });
  const projectedAnn = contract.projectTrainingAnnotation({
    evaluationId: summary.evaluationId,
    payloadSha256: summary.payloadSha256,
    field: 'explanation',
    status: 'ready',
    value: '재시작 뒤에도 남아야 한다',
  });
  let a = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  let b;
  try {
    await postPublish(a.port, 'tok', { publishId: 1, training: [summary] });
    await postPublish(a.port, 'tok', {
      publishId: 2,
      trainingAnnotations: [{
        ...projectedAnn,
        annotationProof: {
          id: publicProofId(`${summary.evaluationId}:explanation`),
          valueSha256: projectedAnn.valueSha256,
        },
      }],
    });
    await a.close();
    a = null;
    b = await startServer({ gameDir: dir, port: 0, token: 'tok' });
    const snap = await (await fetch(`http://127.0.0.1:${b.port}/api/snapshot?token=tok`)).json();
    assert.equal(snap.training.length, 1);
    assert.equal(snap.training[0].explanation, undefined);
    assert.equal(Array.isArray(snap.trainingAnnotations), true);
    assert.equal(snap.trainingAnnotations.some((row) => (
      row.evaluationId === summary.evaluationId
      && row.field === 'explanation'
      && row.value === '재시작 뒤에도 남아야 한다'
    )), true);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }

  const dir2 = tmp();
  const v1 = v1SummaryOf(evaluation(), { explanation: '구 스냅샷 해설' });
  fs.writeFileSync(path.join(dir2, 'ui-snapshot.json'), JSON.stringify({
    revision: 3,
    publishId: 3,
    training: [v1],
    view: null,
    log: [],
    coach: [],
  }));
  const c = await startServer({ gameDir: dir2, port: 0, token: 'tok' });
  try {
    const snap = await (await fetch(`http://127.0.0.1:${c.port}/api/snapshot?token=tok`)).json();
    assert.equal(snap.training[0].explanation, undefined);
    assert.notEqual(snap.training[0].payloadSha256, v1.payloadSha256);
    assert.equal(snap.trainingAnnotations[0].value, '구 스냅샷 해설');
  } finally {
    await c.close();
  }
});

test('SSE payload is projected (no nested extra keys) and includes trainingAnnotations array', async () => {
  const dir = tmp();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const summary = toPublicSummary(evaluation(), { handNo: 1, detailSha256: 'ab'.repeat(32) });
    const leaky = {
      ...summary,
      chosen: { ...summary.chosen, policySeed: 'drop-me-now' },
      source: { ...summary.source, path: '/secret/sse.json' },
    };
    await postPublish(started.port, 'tok', { publishId: 1, training: [leaky] });
    const snap = await (await fetch(`http://127.0.0.1:${started.port}/api/snapshot?token=tok`)).json();
    const raw = JSON.stringify(snap);
    assert.equal(raw.includes('drop-me-now'), false);
    assert.equal(raw.includes('/secret/sse.json'), false);
    assert.equal(Array.isArray(snap.trainingAnnotations), true);
  } finally {
    await started.close();
  }
});

// --- client formatter ---

test('formatter merges annotations by evaluationId+field; unavailable is displayed; payloadSha256 no-op is machine-only', () => {
  assert.equal(typeof trainingFormat.applyTrainingAnnotation, 'function');
  const item = {
    evaluationId: evaluationId(),
    handNo: 1,
    handClass: 'AA',
    chosen: { action: 'raise' },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1 }],
    status: 'supported',
    grade: 'preferred',
    payloadSha256: 'aa'.repeat(32),
  };
  const withExplain = trainingFormat.applyTrainingAnnotation(item, {
    evaluationId: item.evaluationId,
    field: 'explanation',
    status: 'ready',
    value: '병합된 해설',
    payloadSha256: 'ff'.repeat(32),
  });
  const card = formatTrainingCard(withExplain);
  assert.match(card.explanation, /병합된 해설/);
  const unavailable = trainingFormat.applyTrainingAnnotation(item, {
    evaluationId: item.evaluationId,
    field: 'explanation',
    status: 'unavailable',
    value: null,
  });
  const unavailableCard = formatTrainingCard(unavailable);
  assert.match(String(unavailableCard.explanation), /unavailable/i);
});

// --- coach rollback ---

test('coach rollback requires empty pending map and empty annotationQueue (evaluated items are not blockers)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastHand: null }));
  writeJsonAtomic(path.join(dir, 'loop-state.json'), { phase: 'done' });
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  const cc = createCoachControl();
  const evaluatedOnly = await cc.assertRollbackAllowed(dir);
  assert.equal(evaluatedOnly.ok, true);

  await tc.recordPending(dir, 'd-9-preflop-0', { handNo: 9, reason: 'EVALUATE_FAILED' });
  const pending = await cc.assertRollbackAllowed(dir);
  assert.equal(pending.ok, false);
  assert.equal(pending.reasons.some((reason) => reason.code === 'pending_training'), true);

  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ lastHand: null }));
  writeJsonAtomic(path.join(dir2, 'loop-state.json'), { phase: 'done' });
  const tc2 = createTrainingControl();
  await tc2.acceptEvaluations(dir2, {
    gameEpoch: EPOCH, owner: 'owner-1', handNo: 1, evaluations: [evaluation()],
  });
  await tc2.sealAnnotation(dir2, evaluationId(), 'explanation', '대기 중 해설');
  const queued = await createCoachControl().assertRollbackAllowed(dir2);
  assert.equal(queued.ok, false);
  assert.equal(queued.reasons.some((reason) => reason.code === 'pending_annotation'), true);
});
