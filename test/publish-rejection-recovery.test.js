// #274: a relay's refusal of an explanatory annotation — what survives of it, when the
// recorded attempt may be retired, and what must stay exactly as it was. Everything runs
// against the real relay (server/server.js) and the real publisher CLI (tools/publish.js)
// over real session files; the only stand-ins are hostile relays whose replies the
// publisher must not trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';
import {
  gameEpochOf,
  preserveInitialRejection,
  projectTrainingAnnotation,
  publicProofId,
  recheckRejectionTupleOf,
  rejectionTupleOf,
  sha256Hex,
} from '../publish-contract.js';
import { serverProcessStartTime } from '../engine/state.js';
import { createTrainingControl } from '../tools/training-control.js';
import * as pipeline from '../tools/training-pipeline.js';
import { writeSecurityFixtures } from './helpers/security-fixtures.js';
import { q3Evaluation, readJson, tmpQ3, writeJson } from './helpers/q3-fixtures.js';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');
const TOKEN = 'tok';
const EPOCH = gameEpochOf(TOKEN);
const OWNER = 'owner-274';
// p1 holds 7c in the hand in progress, so the relay denies any explanation that names it.
const LEAKING_TEXT = 'BTN에서 7c를 든 상대 앞에서 AJo는 레이즈가 주력입니다.';
const SAFE_TEXT = 'BTN에서 AJo는 레이즈가 주력이고 폴드는 낮은 빈도입니다.';
const attemptFile = (dir) => path.join(dir, '.publish-attempt.json');
const rejectionLog = (dir) => path.join(dir, '.publish-rejections.jsonl');

// Same contract as the loop's runJsonChild: a failure envelope becomes an error carrying
// its code and the envelope itself.
function runPublisher(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [TOOL, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), {
          code: envelope?.code ?? error?.code ?? 'CHILD_FAILED', envelope,
        }));
        return;
      }
      resolve(envelope);
    });
  });
}

function relayDir(t, { players } = {}) {
  const dir = tmpQ3('holdem-274-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeSecurityFixtures(dir, {
    ...(players ? { players } : {}),
    handInProgress: { handNo: 2, holes: { p1: ['7c', '2d'] } },
  });
  return dir;
}

async function startRelay(t, dir) {
  const relay = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await relay.close(); } };
  t.after(close);
  return { ...relay, close };
}

// A machine row the relay already holds (annotations without one are refused as orphans),
// plus a sealed explanation waiting in the queue.
async function seedExplanation(t, dir, { text, evaluation = q3Evaluation(EPOCH) } = {}) {
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [evaluation] });
  await pipeline.flushMachinePublish(dir, {
    gameEpoch: EPOCH, executePublish: (args) => runPublisher(dir, args), trainingControl: tc,
  });
  const sealed = await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', text);
  assert.equal(sealed.ok, true);
  return { tc, evaluation };
}

const executeAgainst = (dir) => (args) => runPublisher(dir, args);

// The relay identity a verifying caller hands the publisher: the process named by lock.json
// (the in-process relay here), its start time, its port and the token it was proved with.
function relayBinding(dir) {
  const lock = readJson(path.join(dir, 'lock.json'));
  return { pid: lock.serverPid, startTime: serverProcessStartTime(lock.serverPid), port: lock.port, sessionToken: lock.sessionToken };
}

// --retire-rejected with the exact attempt it may resend and the relay it may resend it to.
function retireArgs(record, binding) {
  return ['--retire-rejected',
    '--expect-attempt-sha256', sha256Hex(JSON.stringify(record.body)),
    '--expect-game-epoch', record.expectedGameEpoch,
    '--relay-pid', String(binding.pid), '--relay-start-time', binding.startTime,
    '--relay-port', String(binding.port)];
}

function fakeRelay(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(raw);
      const { status, body, headers } = reply(raw);
      res.writeHead(status, headers ?? { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ port: server.address().port, requests });
    });
  });
}

const viewlessEnvelope = (dir, name, value) => {
  const file = path.join(dir, name);
  writeJson(file, value);
  return file;
};

test('the publisher keeps only an HTTP status and an allowlisted relay code, never relay text', async (t) => {
  const dir = tmpQ3('holdem-274-diag-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const SECRET = 'PRIVATE_CARD_As_Kh_and_token';
  const cases = [
    { name: 'listed code', status: 400, body: JSON.stringify({ ok: false, code: 'FORBIDDEN_LITERAL', message: SECRET }), want: [400, 'FORBIDDEN_LITERAL'] },
    { name: 'unlisted code', status: 409, body: JSON.stringify({ ok: false, code: `EVIL_${SECRET}`, message: SECRET }), want: [409, 'UNLISTED'] },
    { name: 'non-string code', status: 400, body: JSON.stringify({ ok: false, code: { text: SECRET } }), want: [400, 'NONE'] },
    { name: 'not JSON', status: 502, body: `<html>${SECRET}</html>`, want: [502, 'NONE'], headers: { 'Content-Type': 'text/html' } },
    { name: '200 without ok', status: 200, body: JSON.stringify({ ok: false, code: 'PERSIST_FAILED', echo: SECRET }), want: [200, 'PERSIST_FAILED'] },
  ];
  for (const row of cases) {
    const relay = await fakeRelay(t, () => ({ status: row.status, body: row.body, headers: row.headers }));
    writeJson(path.join(dir, 'lock.json'), { port: relay.port, sessionToken: TOKEN });
    fs.rmSync(attemptFile(dir), { force: true });
    const file = viewlessEnvelope(dir, 'review.json', { review: '검토 문구' });
    const error = await runPublisher(dir, ['--from', file]).then(() => null, (e) => e);
    assert.equal(error?.code, 'PUBLISH_REJECTED', row.name);
    assert.deepEqual([error.envelope.httpStatus, error.envelope.serverCode], row.want, row.name);
    // Exactly the closed top-level fields, plus the identity of the recorded request the failed
    // POST carried: its exact digest, publish id and epoch, nothing from the relay's answer.
    assert.deepEqual(Object.keys(error.envelope).sort(), ['attempt', 'code', 'httpStatus', 'message', 'ok', 'serverCode'], row.name);
    assert.equal(fs.existsSync(attemptFile(dir)), true, `${row.name} must keep the recorded attempt`);
    const record = JSON.parse(fs.readFileSync(attemptFile(dir), 'utf8'));
    const { attempt, ...closedEnvelope } = error.envelope;
    assert.deepEqual(Object.keys(attempt).sort(), ['bodySha256', 'expectedGameEpoch', 'publishId'], row.name);
    assert.deepEqual(attempt, {
      bodySha256: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(record.body)).digest('hex'),
      publishId: record.body.publishId,
      expectedGameEpoch: record.expectedGameEpoch,
    }, `${row.name}: the identity is exactly the recorded request`);
    assert.equal(JSON.stringify(closedEnvelope).includes(SECRET), false, `${row.name} leaked relay text`);
    assert.equal(JSON.stringify(closedEnvelope).includes(TOKEN), false, `${row.name} leaked the token`);
  }
});

test('a transport failure is PUBLISH_FAILED with no rejection fields, and keeps the attempt', async (t) => {
  const dir = tmpQ3('holdem-274-transport-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relay = await fakeRelay(t, () => ({ status: 200, body: '{"ok":true}' }));
  writeJson(path.join(dir, 'lock.json'), { port: relay.port, sessionToken: TOKEN });
  const down = http.createServer();
  await new Promise((resolve) => down.listen(0, '127.0.0.1', resolve));
  const deadPort = down.address().port;
  await new Promise((resolve) => down.close(resolve));
  writeJson(path.join(dir, 'lock.json'), { port: deadPort, sessionToken: TOKEN });
  const file = viewlessEnvelope(dir, 'review.json', { review: '검토 문구' });
  const error = await runPublisher(dir, ['--from', file]).then(() => null, (e) => e);
  assert.equal(error?.code, 'PUBLISH_FAILED');
  assert.equal('httpStatus' in error.envelope, false);
  assert.equal('serverCode' in error.envelope, false);
  assert.equal(fs.existsSync(attemptFile(dir)), true);
});

test('real relay: a leaking explanation is refused with 400 FORBIDDEN_LITERAL and nothing is applied', async (t) => {
  const dir = relayDir(t);
  const relay = await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  const snapshotBefore = fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8');
  await assert.rejects(
    pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc }),
    (error) => {
      assert.equal(error.code, 'PUBLISH_REJECTED');
      assert.deepEqual(
        [error.envelope.httpStatus, error.envelope.serverCode],
        [400, 'FORBIDDEN_LITERAL'],
      );
      return true;
    },
  );
  // Without a retire hook the failure is exactly what it was before: attempt kept, queue kept.
  assert.equal(fs.existsSync(attemptFile(dir)), true);
  assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation);
  assert.equal(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore);
  const served = await (await fetch(`http://127.0.0.1:${relay.port}/api/snapshot?token=${TOKEN}`)).json();
  assert.equal(JSON.stringify(served).includes('7c를'), false);
});

test('--retire-rejected retires an annotation-only attempt on durable evidence bound to the exact body', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
  }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const envelope = viewlessEnvelope(dir, 'retire.json', {
    trainingAnnotations: recorded.body.trainingAnnotations,
    annotationAuthority: recorded.annotationAuthority,
  });

  const out = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, relayBinding(dir))]);

  assert.equal(out.retired, true);
  assert.equal(out.applied, false);
  assert.deepEqual(out.rejection, {
    publishId: recorded.body.publishId,
    expectedGameEpoch: EPOCH,
    bodySha256: sha256Hex(JSON.stringify(recorded.body)),
    httpStatus: 400,
    serverCode: 'FORBIDDEN_LITERAL',
  });
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  const lines = fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].items, [{
    evaluationId: evaluation.evaluationId, field: 'explanation',
    valueSha256: recorded.annotationAuthority.items[0].valueSha256,
  }]);
  assert.equal(JSON.stringify(lines[0]).includes('7c'), false, 'the audit line must not carry the annotation text');
});

test('--retire-rejected never retires what the relay might still accept or what is not annotations alone', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: SAFE_TEXT });
  const auth = tc.loadAuthority(dir);
  const item = auth.items[evaluation.evaluationId];
  const queued = auth.annotationQueue[evaluation.evaluationId].explanation;
  const annotation = projectTrainingAnnotation({
    evaluationId: evaluation.evaluationId, payloadSha256: item.payloadSha256,
    field: 'explanation', status: 'ready', value: SAFE_TEXT,
  });
  const authority = {
    expectedGameEpoch: EPOCH,
    items: [{ evaluationId: evaluation.evaluationId, field: 'explanation', valueSha256: queued.valueSha256 }],
  };
  const body = (extra = {}) => ({
    publishId: 99,
    trainingAnnotations: [{
      ...annotation,
      annotationProof: { id: publicProofId(`${evaluation.evaluationId}:explanation`), valueSha256: annotation.valueSha256 },
    }],
    ...extra,
  });

  // (a) the relay accepts the exact body after all: that is a normal retry, not a retirement.
  fs.writeFileSync(attemptFile(dir), JSON.stringify({ body: { ...body(), publishId: readJson(path.join(dir, 'ui-snapshot.json')).publishId + 1 }, expectedGameEpoch: EPOCH, annotationAuthority: authority }));
  const file = viewlessEnvelope(dir, 'retire.json', { trainingAnnotations: body().trainingAnnotations, annotationAuthority: authority });
  const acceptedRecord = readJson(attemptFile(dir));
  const accepted = await runPublisher(dir, ['--from', file, ...retireArgs(acceptedRecord, relayBinding(dir))]);
  assert.equal(accepted.retired, undefined);
  assert.equal(accepted.applied, true);
  assert.equal(accepted.bodySha256, sha256Hex(JSON.stringify(acceptedRecord.body)), 'an accepted resend names the body it sent');
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);

  // (b) an orphan refusal (409, the machine row is not there) is ordering, not a verdict.
  const orphan = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const orphanAnnotation = projectTrainingAnnotation({
    evaluationId: orphan.evaluationId, payloadSha256: 'ab'.repeat(32),
    field: 'explanation', status: 'ready', value: SAFE_TEXT,
  });
  const orphanAuthority = { expectedGameEpoch: EPOCH, items: [{ evaluationId: orphan.evaluationId, field: 'explanation', valueSha256: orphanAnnotation.valueSha256 }] };
  const auth2 = tc.loadAuthority(dir);
  auth2.annotationQueue[orphan.evaluationId] = { explanation: { evaluationId: orphan.evaluationId, field: 'explanation', valueSha256: orphanAnnotation.valueSha256 } };
  writeJson(path.join(dir, 'training', '.training-authority.json'), auth2);
  const orphanBody = {
    publishId: readJson(path.join(dir, 'ui-snapshot.json')).publishId + 1,
    trainingAnnotations: [{ ...orphanAnnotation, annotationProof: { id: publicProofId(`${orphan.evaluationId}:explanation`), valueSha256: orphanAnnotation.valueSha256 } }],
  };
  fs.writeFileSync(attemptFile(dir), JSON.stringify({ body: orphanBody, expectedGameEpoch: EPOCH, annotationAuthority: orphanAuthority }));
  const orphanFile = viewlessEnvelope(dir, 'orphan.json', { trainingAnnotations: orphanBody.trainingAnnotations, annotationAuthority: orphanAuthority });
  const blocked = await runPublisher(dir, ['--from', orphanFile, ...retireArgs(readJson(attemptFile(dir)), relayBinding(dir))]).then(() => null, (e) => e);
  assert.equal(blocked?.code, 'PUBLISH_REJECTED');
  assert.deepEqual([blocked.envelope.httpStatus, blocked.envelope.serverCode], [409, 'ANNOTATION_ORPHAN']);
  assert.equal(fs.existsSync(attemptFile(dir)), true, 'a non-retirable refusal must keep the attempt');
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
  fs.rmSync(attemptFile(dir));

  // (c) a body that is more than annotations is never retired, even for a retirable code.
  const mixed = { ...orphanBody, review: '함께 실린 리뷰' };
  const leaking = projectTrainingAnnotation({
    evaluationId: evaluation.evaluationId, payloadSha256: item.payloadSha256,
    field: 'explanation', status: 'ready', value: LEAKING_TEXT,
  });
  mixed.trainingAnnotations = [{ ...leaking, annotationProof: { id: publicProofId(`${evaluation.evaluationId}:explanation`), valueSha256: leaking.valueSha256 } }];
  mixed.publishId = readJson(path.join(dir, 'ui-snapshot.json')).publishId + 1;
  const leakAuthority = { expectedGameEpoch: EPOCH, items: [{ evaluationId: evaluation.evaluationId, field: 'explanation', valueSha256: leaking.valueSha256 }] };
  const auth3 = tc.loadAuthority(dir);
  auth3.annotationQueue[evaluation.evaluationId] = { explanation: { evaluationId: evaluation.evaluationId, field: 'explanation', valueSha256: leaking.valueSha256 } };
  writeJson(path.join(dir, 'training', '.training-authority.json'), auth3);
  fs.writeFileSync(attemptFile(dir), JSON.stringify({ body: mixed, expectedGameEpoch: EPOCH, annotationAuthority: leakAuthority }));
  const mixedFile = viewlessEnvelope(dir, 'mixed.json', { trainingAnnotations: mixed.trainingAnnotations, annotationAuthority: leakAuthority });
  const mixedBefore = fs.readFileSync(attemptFile(dir), 'utf8');
  const mixedError = await runPublisher(dir, ['--from', mixedFile, ...retireArgs(readJson(attemptFile(dir)), relayBinding(dir))]).then(() => null, (e) => e);
  assert.equal(mixedError?.code, 'ATTEMPT_NOT_RETIRABLE', 'refused before anything is sent');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), mixedBefore);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
});

test('retirement needs the verified live relay: a dead relay, a replaced endpoint or a forged refusal retires nothing', async (t) => {
  const dir = relayDir(t);
  const relay = await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
  }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const attemptBytes = fs.readFileSync(attemptFile(dir), 'utf8');
  const envelope = viewlessEnvelope(dir, 'retire.json', {
    trainingAnnotations: recorded.body.trainingAnnotations, annotationAuthority: recorded.annotationAuthority,
  });
  const verified = relayBinding(dir);
  const lock = readJson(path.join(dir, 'lock.json'));
  const untouched = (label) => {
    assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), attemptBytes, `${label}: the attempt must stay exactly as it was`);
    assert.equal(fs.existsSync(rejectionLog(dir)), false, `${label}: no audit line`);
    assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation, `${label}: queue kept`);
  };

  // Without a verified binding the publisher refuses before reading anything.
  const unbound = await runPublisher(dir, ['--from', envelope, '--retire-rejected']).then(() => null, (e) => e);
  assert.equal(unbound?.code, 'RETIRE_BINDING_REQUIRED');
  untouched('no binding');

  // A forged relay answers the retirable refusal, the token kept, the endpoint swapped in lock.json.
  const forged = await fakeRelay(t, () => ({ status: 400, body: JSON.stringify({ ok: false, code: 'FORBIDDEN_LITERAL' }) }));
  writeJson(path.join(dir, 'lock.json'), { ...lock, port: forged.port });
  const swapped = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, verified)]).then(() => null, (e) => e);
  assert.equal(swapped?.code, 'RELAY_BINDING_CHANGED');
  assert.equal(forged.requests.length, 0, 'nothing was sent to the replaced endpoint');
  untouched('replaced endpoint');

  // The caller's binding names a different process start (a reused pid) — refused.
  writeJson(path.join(dir, 'lock.json'), lock);
  const reused = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, { ...verified, startTime: 'linux-v1:0:0' })]).then(() => null, (e) => e);
  assert.equal(reused?.code, 'RELAY_BINDING_CHANGED');
  untouched('different start time');

  // The bound relay is gone: its listener is no longer owned, so nothing is sent or retired.
  await relay.close();
  const down = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, verified)]).then(() => null, (e) => e);
  assert.ok(['RELAY_BINDING_CHANGED', 'RELAY_BINDING_UNVERIFIED'].includes(down?.code), down?.code);
  untouched('dead relay');

  // A bound relay that answers 400 with a code outside the retirable set is not a verdict.
  const odd = await fakeRelay(t, () => ({ status: 400, body: JSON.stringify({ ok: false, code: 'BAD_VIEWS' }) }));
  writeJson(path.join(dir, 'lock.json'), { ...lock, port: odd.port });
  const unretirable = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, { ...verified, port: odd.port })]).then(() => null, (e) => e);
  assert.equal(unretirable?.code, 'PUBLISH_REJECTED');
  assert.equal(unretirable.envelope.serverCode, 'BAD_VIEWS');
  assert.equal(fs.existsSync(attemptFile(dir)), true);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);

  // The bound relay's lock is replaced while it answers: the refusal arrives, but the binding
  // re-checked after the reply no longer holds, so nothing is retired.
  let swapOnReply = null;
  // The racing relay answers with a DIFFERENT retirable refusal than the one first observed.
  const racing = await fakeRelay(t, () => {
    writeJson(path.join(dir, 'lock.json'), { ...lock, port: swapOnReply });
    return { status: 409, body: JSON.stringify({ ok: false, code: 'ANNOTATION_CONFLICT', message: 'PRIVATE_As_Kh_text' }) };
  });
  swapOnReply = odd.port;
  writeJson(path.join(dir, 'lock.json'), { ...lock, port: racing.port });
  const raced = await runPublisher(dir, ['--from', envelope, ...retireArgs(readJson(attemptFile(dir)), { ...verified, port: racing.port })]).then(() => null, (e) => e);
  assert.equal(racing.requests.length, 1, 'the refusal was received');
  assert.equal(raced?.code, 'RELAY_BINDING_CHANGED');
  assert.equal(fs.existsSync(attemptFile(dir)), true);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
  // The retiring POST's sanitized answer travels with the binding failure, through the CLI
  // reply, and composes as the recheck beside the refusal observed first.
  assert.deepEqual(raced.envelope.rejection, { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' });
  assert.equal('recheckRejection' in raced.envelope, false);
  assert.equal(JSON.stringify(raced.envelope).includes('As_Kh'), false);
  assert.deepEqual(rejectionTupleOf(raced), { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' });
  const firstObserved = Object.assign(new Error('first'), { code: 'PUBLISH_REJECTED', envelope: { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' } });
  preserveInitialRejection(raced, firstObserved);
  assert.deepEqual([rejectionTupleOf(raced), recheckRejectionTupleOf(raced)], [{ httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }]);

  // The attempt belongs to a game epoch; a different game's relay may not retire it, and the
  // attempt is left in place for its own game.
  writeJson(path.join(dir, 'lock.json'), { ...lock, sessionToken: 'another-game' });
  const stale = await runPublisher(dir, ['--from', envelope, ...retireArgs(recorded, verified)]).then(() => null, (e) => e);
  assert.equal(stale?.code, 'ATTEMPT_CHANGED');
  assert.equal(fs.existsSync(attemptFile(dir)), true);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
});

test('training control drops queue entries only for evidence the publisher left for that exact body', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
  }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const retire = await runPublisher(dir, ['--from', viewlessEnvelope(dir, 'retire.json', {
    trainingAnnotations: recorded.body.trainingAnnotations, annotationAuthority: recorded.annotationAuthority,
  }), ...retireArgs(recorded, relayBinding(dir))]);
  const genuine = retire.rejection;

  for (const [label, forged] of [
    ['wrong digest', { ...genuine, bodySha256: 'ee'.repeat(32) }],
    ['wrong publishId', { ...genuine, publishId: genuine.publishId + 1 }],
    ['wrong epoch', { ...genuine, expectedGameEpoch: 'ff'.repeat(32) }],
    ['wrong code', { ...genuine, serverCode: 'ANNOTATION_ORPHAN', httpStatus: 409 }],
    ['not retirable', { ...genuine, serverCode: 'FORBIDDEN_LITERAL', httpStatus: 500 }],
    ['not an object', null],
  ]) {
    await assert.rejects(
      tc.retireRejectedAnnotations(dir, forged),
      (error) => error.code === 'REJECTION_EVIDENCE_INVALID' || error.code === 'REJECTION_EVIDENCE_MISSING',
      label,
    );
    assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation, `${label} dropped the entry`);
  }

  const settled = await tc.retireRejectedAnnotations(dir, genuine);
  assert.deepEqual(settled, { retired: 1, isolated: 0, skipped: 0 });
  const after = tc.loadAuthority(dir);
  assert.equal(after.annotationQueue[evaluation.evaluationId], undefined);
  const kept = after.items[evaluation.evaluationId].annotations.explanation;
  assert.equal(kept.status, 'ready', 'the sealed annotation stays on the item for audit');
  assert.equal(kept.published, false);
  assert.equal(kept.publishFailed, 'rejected');
  assert.deepEqual(
    { ...kept.rejection, at: undefined },
    { publishId: genuine.publishId, httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL', at: undefined },
  );
  // Idempotent: a second report of the same refusal changes nothing.
  assert.deepEqual(await tc.retireRejectedAnnotations(dir, genuine), { retired: 0, isolated: 0, skipped: 1 });
});

test('end to end: a refused explanation is retired, the queue is settled, and a later publish goes through in order', async (t) => {
  const dir = relayDir(t);
  const relay = await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  const posts = [];
  const executePublish = async (args) => {
    posts.push(args.filter((arg) => arg.startsWith('--')));
    return runPublisher(dir, args);
  };
  const retired = [];
  const retirePending = async (error) => {
    assert.equal(error.code, 'PUBLISH_REJECTED');
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish, trainingControl: tc, verifyRelay: async () => { posts.push(['verify-relay']); },
      relayBinding: () => relayBinding(dir),
      onRetired: (info) => retired.push(info),
    });
    return settled.retired === true || settled.published === true;
  };

  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish, trainingControl: tc, retirePending,
  });

  assert.equal(retired.length, 1);
  assert.deepEqual([retired[0].httpStatus, retired[0].serverCode, retired[0].dropped], [400, 'FORBIDDEN_LITERAL', 1]);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId], undefined);
  assert.deepEqual(posts.map((row) => row.join(' ')), ['--from', 'verify-relay',
    '--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port']);
  const served = await (await fetch(`http://127.0.0.1:${relay.port}/api/snapshot?token=${TOKEN}`)).json();
  assert.equal(served.trainingAnnotations.length, 0, 'the refused annotation must never reach the relay state');

  // The id the refused body held was never consumed; the next publish takes it, in order.
  const before = readJson(path.join(dir, 'ui-snapshot.json')).publishId;
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 2, evaluations: [second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish, trainingControl: tc });
  assert.equal(readJson(path.join(dir, 'ui-snapshot.json')).publishId, before + 1);
  assert.equal(tc.loadAuthority(dir).publishQueue[second.evaluationId], undefined);
});

test('a body of several annotations is not guessed at: each is isolated, the refused one is retired alone', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);

  const bodies = [];
  const executePublish = async (args) => {
    const out = await runPublisher(dir, args).catch((error) => { throw error; });
    return out;
  };
  const retirePending = async () => {
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish, trainingControl: tc, relayBinding: () => relayBinding(dir),
    });
    if (settled.retired || settled.published) {
      const log = fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      bodies.push(log[log.length - 1].items.length);
    }
    return settled.retired === true || settled.published === true;
  };
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish, trainingControl: tc, retirePending });

  assert.deepEqual(bodies, [2, 1], 'first the shared body, then the refused annotation alone');
  const after = tc.loadAuthority(dir);
  assert.equal(after.annotationQueue[first.evaluationId], undefined);
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true, 'the innocent annotation still reaches the relay');
  assert.equal(after.annotationQueue[second.evaluationId], undefined);
});

test('a pending refused explanation does not hold a machine publish hostage, and a non-retirable one does', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
  }).catch(() => {});
  assert.equal(fs.existsSync(attemptFile(dir)), true);
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 2, evaluations: [second] });

  // Without a retire hook the pending attempt blocks the machine row (and says why).
  await assert.rejects(
    pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc }),
    (error) => error.code === 'PUBLISH_REJECTED' && error.envelope.serverCode === 'FORBIDDEN_LITERAL',
  );
  assert.ok(tc.loadAuthority(dir).publishQueue[second.evaluationId], 'the machine row must stay queued');

  await pipeline.flushMachinePublish(dir, {
    gameEpoch: EPOCH,
    executePublish: executeAgainst(dir),
    trainingControl: tc,
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
        executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir),
      });
      return settled.retired === true;
    },
  });
  assert.equal(tc.loadAuthority(dir).publishQueue[second.evaluationId], undefined);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
});

// #274 lifetime contract (3): a refused single explanation A is the recorded attempt when a
// later explanation B is sealed. The next flush builds A+B, meets the pending A, retires it,
// and must then rebuild — publishing B alone within the same flush — rather than resend the
// A+B body whose authority the retirement just changed.
test('a refused explanation pending when another is queued: the flush retires it once, rebuilds, and publishes the other in the same flush without resending the stale body', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  const machineId = readJson(path.join(dir, 'ui-snapshot.json')).publishId;
  // A alone, refused and left as the recorded attempt.
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => assert.fail('A must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const pending = readJson(attemptFile(dir));
  assert.deepEqual(pending.body.trainingAnnotations.map((row) => row.evaluationId), [first.evaluationId]);
  // Then B is sealed: the next flush builds A+B and meets the pending A.
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const posts = [];
  const executePublish = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = {
      flags: args.filter((arg) => arg.startsWith('--')).join(' '),
      ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId),
      machine: (envelope?.training ?? []).length,
    };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  const retirements = [];
  const retirePending = async (error) => {
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish, trainingControl: tc, relayBinding: () => relayBinding(dir), onRetired: (info) => retirements.push(info),
    });
    return settled.retired === true || settled.published === true;
  };

  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish, trainingControl: tc, retirePending });

  // A+B met the pending A: A was retried (refused again), retired exactly once, and B went
  // alone with the id the refused body never consumed. The A+B body was not sent again.
  assert.deepEqual(posts.map((row) => [row.flags, row.result]), [
    ['--from', 'ATTEMPT_PENDING'],
    ['--from --retry', 'PUBLISH_REJECTED'],
    ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port', 'retired'],
    ['--from', `published:${machineId + 1}`],
  ]);
  assert.deepEqual(posts[0].ids, [first.evaluationId, second.evaluationId], 'the flush first built A+B');
  assert.deepEqual(posts[3].ids, [second.evaluationId], 'then B alone, rebuilt after the settlement');
  assert.equal(posts.every((row) => row.machine === 0), true, 'no machine row was replayed');
  assert.equal(posts.some((row) => row.result === 'STALE_ANNOTATION_AUTHORITY'), false, 'the stale A+B body was never submitted');
  assert.deepEqual(retirements.map((row) => [row.httpStatus, row.serverCode, row.dropped]), [[400, 'FORBIDDEN_LITERAL', 1]]);
  const after = tc.loadAuthority(dir);
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true, 'B reached the relay in this flush');
  assert.deepEqual(after.annotationQueue, {});
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.equal(snapshot.publishId, machineId + 1, 'exactly one publication followed the machine rows');
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId]);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1);
});

// #274 lifetime contract: a retirement is only worth its evidence if the training control can
// settle that evidence. An attempt whose value digests match the queue but whose annotation
// proof is wrong or missing would be refused by the relay (400 ANNOTATION_PROOF_MISMATCH) and
// then rejected by the settlement verifier. The publisher checks that eligibility before it
// sends: an explicit failure, no false retirement, attempt and queue exactly as they were.
test('a retirement is refused before anything is sent when its evidence could not be settled: a wrong or missing annotation proof keeps the attempt, the queue and the relay exactly', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const snapshotBefore = fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8');
  for (const [label, mutate] of [
    ['wrong proof id', (note) => { note.annotationProof.id = 'wrong'; }],
    ['wrong proof digest', (note) => { note.annotationProof.valueSha256 = 'ab'.repeat(32); }],
    ['missing proof', (note) => { delete note.annotationProof; }],
  ]) {
    const malformed = JSON.parse(JSON.stringify(recorded));
    mutate(malformed.body.trainingAnnotations[0]);
    fs.writeFileSync(attemptFile(dir), JSON.stringify(malformed));
    const bytes = fs.readFileSync(attemptFile(dir), 'utf8');
    const envelope = viewlessEnvelope(dir, 'retire.json', { trainingAnnotations: malformed.body.trainingAnnotations, annotationAuthority: malformed.annotationAuthority });
    const error = await runPublisher(dir, ['--from', envelope, ...retireArgs(malformed, relayBinding(dir))]).then(() => null, (e) => e);
    assert.equal(error?.code, 'ATTEMPT_NOT_RETIRABLE', label);
    assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes, `${label}: the attempt is kept exactly`);
    assert.equal(fs.existsSync(rejectionLog(dir)), false, `${label}: no audit line`);
    assert.equal(fs.existsSync(evidenceFile), false, `${label}: no evidence`);
    assert.equal(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'), snapshotBefore, `${label}: nothing was sent`);
    assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation, `${label}: queue kept`);
    await assert.rejects(pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir),
    }), { code: 'ATTEMPT_NOT_RETIRABLE' }, `${label}: the helper reports the same explicit failure`);
    assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes, label);
  }
  // Restored exactly, the record retires normally and its evidence settles.
  fs.writeFileSync(attemptFile(dir), JSON.stringify(recorded));
  const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
    executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir),
  });
  assert.deepEqual([settled.retired, settled.dropped], [true, 1]);
  assert.equal(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId], undefined);
  assert.equal(fs.existsSync(evidenceFile), false);
});

// #274 lifetime contract: the ordinary --retry that recovery runs must not undo the durability
// of a record standing beside unfinished retirement evidence. The record is kept as the same
// file (synced in place, never rewritten), an unsafe record is refused untouched, and the
// interrupted retirement still settles exactly once through the production flush.
test('an ordinary --retry beside unfinished retirement evidence keeps the durable record as the same file, refuses an unsafe record, and the interrupted retirement still settles once', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const bytes = fs.readFileSync(attemptFile(dir), 'utf8');
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const envelope = () => viewlessEnvelope(dir, 'retire.json', { trainingAnnotations: recorded.body.trainingAnnotations, annotationAuthority: recorded.annotationAuthority });
  // The retirement installs its evidence but cannot write its audit line: the attempt stays
  // beside the evidence (the interrupted shape recovery meets).
  fs.mkdirSync(rejectionLog(dir));
  const partial = await runPublisher(dir, ['--from', envelope(), ...retireArgs(recorded, relayBinding(dir))]).then(() => null, (e) => e);
  assert.equal(partial?.code, 'REJECTION_AUDIT_FAILED');
  assert.equal(fs.existsSync(evidenceFile), true, 'the evidence was installed');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes);
  const ino = fs.statSync(attemptFile(dir)).ino;
  // Recovery's ordinary retry resends that exact body (refused again): the record is the same
  // file with the same bytes afterwards — kept and synced, not replaced by an unsynced copy.
  const retried = await runPublisher(dir, ['--from', envelope(), '--retry']).then(() => null, (e) => e);
  assert.equal(retried?.code, 'PUBLISH_REJECTED');
  assert.deepEqual([retried.envelope.httpStatus, retried.envelope.serverCode], [400, 'FORBIDDEN_LITERAL']);
  assert.equal(fs.statSync(attemptFile(dir)).ino, ino, 'the same file');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes, 'the same bytes');
  assert.equal(fs.existsSync(evidenceFile), true, 'the evidence is still there for the retirement to finish');
  // An unsafe record (a second link to it) is refused by the ordinary retry as well, untouched.
  const outside = path.join(tmpQ3('holdem-274-outside-'), 'outside.json');
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  fs.writeFileSync(outside, bytes);
  fs.rmSync(attemptFile(dir));
  fs.linkSync(outside, attemptFile(dir));
  const unsafe = await runPublisher(dir, ['--from', envelope(), '--retry']).then(() => null, (e) => e);
  assert.equal(unsafe?.code, 'ATTEMPT_SYNC_FAILED');
  assert.equal(unsafe.envelope.auditCode, 'REJECTION_AUDIT_UNSAFE');
  assert.equal(fs.lstatSync(attemptFile(dir)).nlink, 2, 'the planted link is not replaced');
  assert.equal(fs.readFileSync(outside, 'utf8'), bytes, 'the outside file is untouched');
  fs.rmSync(attemptFile(dir));
  fs.writeFileSync(attemptFile(dir), bytes);
  // With the obstruction gone, the production flush retries the recorded body, retires it on
  // the same-body evidence (replaced), and settles it exactly once.
  fs.rmdirSync(rejectionLog(dir));
  const retirements = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
        executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir), onRetired: (info) => retirements.push(info),
      });
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  assert.deepEqual(retirements.map((row) => [row.httpStatus, row.serverCode, row.dropped]), [[400, 'FORBIDDEN_LITERAL', 1]]);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(fs.existsSync(evidenceFile), false);
  const after = tc.loadAuthority(dir);
  assert.equal(after.annotationQueue[evaluation.evaluationId], undefined);
  assert.equal(after.items[evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
});

// #274 lifetime contract: NO_ATTEMPT between a flush's two calls means the recorded attempt was
// settled meanwhile — here retired, with its queue settlement still waiting behind an ordinary
// holder of the training lock. The flush must reconcile that evidence before it rebuilds, and
// then publish B without the stale body.
test('NO_ATTEMPT on the retry: the attempt was retired meanwhile with its settlement pending — the flush reconciles the evidence before rebuilding and publishes B alone', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => assert.fail('A must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const pending = readJson(attemptFile(dir));
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  let releaseHold; let holder = null; let holdReady = false; let retiredMeanwhile = false;
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => releaseHold());
  const executePublish = async (args) => {
    if (args.includes('--retry') && !retiredMeanwhile) {
      retiredMeanwhile = true;
      // Between the flush's two calls another process retires A: an ordinary holder takes the
      // training lock first, so A's queue settlement cannot happen until it lets go.
      holder = tc.withLock(dir, async () => { holdReady = true; await holdGate; });
      while (!holdReady) await sleep(10);
      const elsewhere = await record(['--from', viewlessEnvelope(dir, 'retire-elsewhere.json', {
        trainingAnnotations: pending.body.trainingAnnotations, annotationAuthority: pending.annotationAuthority,
      }), ...retireArgs(pending, relayBinding(dir))]);
      assert.equal(elsewhere.retired, true);
      assert.equal(fs.existsSync(evidenceFile), true);
      setTimeout(releaseHold, 300);
    }
    return record(args);
  };
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish, trainingControl: tc,
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, { executePublish: record, trainingControl: tc, relayBinding: () => relayBinding(dir) });
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  await holder;
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(posts.map((row) => [row.flags, row.ids.length, row.result]), [
    ['--from', 2, 'ATTEMPT_PENDING'],
    ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port', 1, 'retired'],
    ['--from --retry', 2, 'NO_ATTEMPT'],
    ['--from', 1, `published:${snapshot.publishId}`],
  ], 'A+B met the pending A; A was retired elsewhere; the retry found no attempt; the evidence was settled and B alone was published');
  assert.deepEqual(posts[3].ids, [second.evaluationId]);
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected', 'A was settled from its evidence by the flush, before the rebuild');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true);
  assert.equal(fs.existsSync(evidenceFile), false);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId], 'retired A never reached the relay');
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1);
});

// #274: the publisher's command line. Without binding options every ordinary publish and retry
// works as before; a binding is accepted only as the complete, well-formed pair together with
// --retry; a bound retry refuses a record other than the one declared before anything is sent
// and proceeds against the declared one.
test('publisher CLI: no binding options is the ordinary contract; a partial or malformed binding is USAGE; a bound retry refuses another record unsent and proceeds against the declared one', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  // Ordinary publishes: a review envelope, then a pending annotation attempt and its plain retry.
  const review = viewlessEnvelope(dir, 'review.json', { review: '검토 문구' });
  const published = await runPublisher(dir, ['--from', review]);
  assert.equal(published.ok, true, 'an ordinary publish needs no binding');
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc }).catch(() => {});
  const recorded = readJson(attemptFile(dir));
  const bytes = fs.readFileSync(attemptFile(dir), 'utf8');
  const envelope = viewlessEnvelope(dir, 'retry.json', { trainingAnnotations: recorded.body.trainingAnnotations, annotationAuthority: recorded.annotationAuthority });
  const plain = await runPublisher(dir, ['--from', envelope, '--retry']).then(() => null, (e) => e);
  assert.equal(plain?.code, 'PUBLISH_REJECTED', 'an unbound retry still resends and is judged by the relay');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes);
  // A partial or malformed binding, or a binding without --retry, is refused as usage before anything is read.
  const sha = sha256Hex(JSON.stringify(recorded.body));
  for (const [label, args] of [
    ['digest only', ['--retry', '--expect-attempt-sha256', sha]],
    ['epoch only', ['--retry', '--expect-game-epoch', EPOCH]],
    ['malformed digest', ['--retry', '--expect-attempt-sha256', 'not-a-digest', '--expect-game-epoch', EPOCH]],
    ['malformed epoch', ['--retry', '--expect-attempt-sha256', sha, '--expect-game-epoch', 'xyz']],
    ['binding without --retry', ['--expect-attempt-sha256', sha, '--expect-game-epoch', EPOCH]],
  ]) {
    const usage = await runPublisher(dir, ['--from', envelope, ...args]).then(() => null, (e) => e);
    assert.equal(usage?.code, 'USAGE', label);
    assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes, `${label}: the record is untouched`);
  }
  // Bound to another record: refused unsent, the record untouched; bound to this one: resent and judged.
  const other = await runPublisher(dir, ['--from', envelope, '--retry', '--expect-attempt-sha256', 'ab'.repeat(32), '--expect-game-epoch', EPOCH]).then(() => null, (e) => e);
  assert.equal(other?.code, 'ATTEMPT_CHANGED');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes);
  const foreignEpoch = await runPublisher(dir, ['--from', envelope, '--retry', '--expect-attempt-sha256', sha, '--expect-game-epoch', 'ff'.repeat(32)]).then(() => null, (e) => e);
  assert.equal(foreignEpoch?.code, 'ATTEMPT_CHANGED');
  const bound = await runPublisher(dir, ['--from', envelope, '--retry', '--expect-attempt-sha256', sha, '--expect-game-epoch', EPOCH]).then(() => null, (e) => e);
  assert.equal(bound?.code, 'PUBLISH_REJECTED', 'the declared record is resent and judged by the relay');
  assert.deepEqual([bound.envelope.httpStatus, bound.envelope.serverCode], [400, 'FORBIDDEN_LITERAL']);
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), bytes, 'a refused resend keeps the record exactly');
  assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation);
});

// #274: the ordinary unresolved-attempt retry marks the queue entries of the body it captured,
// so its resend must be bound to that exact record. Here the caller captured refused A and is
// preempted; A is retired, B is sealed, and a transport failure leaves B as the recorded
// attempt. The resend refuses B unsent (ATTEMPT_CHANGED), nothing marks A, B stays intact and
// queued, and a later flush publishes B as itself.
test('an ordinary retry that captured A never sends or marks from a replacement B: the bound resend refuses B unsent, A stays retired, B is published later as itself', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => assert.fail('A must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  const recordedA = readJson(attemptFile(dir));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let allow; let captured = false; let retryArgs = null;
  const gate = new Promise((resolve) => { allow = resolve; });
  t.after(() => allow());
  // The caller captures A and is preempted before its resend runs.
  const pending = pipeline.retryUnresolvedTrainingAttempt(dir, {
    executePublish: async (args) => { captured = true; retryArgs = args; await gate; return runPublisher(dir, args); },
  });
  pending.catch(() => {});
  while (!captured) await sleep(10);
  // Meanwhile A is retired on evidence and settled …
  const retired = await pipeline.retireRejectedAnnotationAttempt(dir, { executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir) });
  assert.deepEqual([retired.retired, retired.dropped], [true, 1]);
  // … B is sealed, and a transport failure leaves B as the recorded attempt.
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const envelopeB = pipeline.writeTrainingEnvelope(dir, pipeline.annotationEnvelope(dir, { gameEpoch: EPOCH }), { kind: 'annotation' });
  const lockPath = path.join(dir, 'lock.json');
  const liveLock = fs.readFileSync(lockPath, 'utf8');
  const down = http.createServer();
  await new Promise((resolve) => down.listen(0, '127.0.0.1', resolve));
  const deadPort = down.address().port;
  await new Promise((resolve) => down.close(resolve));
  writeJson(lockPath, { ...JSON.parse(liveLock), port: deadPort });
  const transport = await runPublisher(dir, ['--from', envelopeB]).then(() => null, (e) => e.code);
  fs.writeFileSync(lockPath, liveLock);
  assert.equal(transport, 'PUBLISH_FAILED');
  const recordedB = fs.readFileSync(attemptFile(dir), 'utf8');
  assert.deepEqual(JSON.parse(recordedB).body.trainingAnnotations.map((row) => row.evaluationId), [second.evaluationId], 'B is the recorded attempt now');

  allow();
  const result = await pending.then(() => ({ ok: true }), (error) => ({ ok: false, code: error.code }));

  assert.deepEqual(result, { ok: false, code: 'ATTEMPT_CHANGED' }, 'the bound resend refuses the replacement');
  assert.ok(retryArgs.includes('--expect-attempt-sha256') && retryArgs.includes(sha256Hex(JSON.stringify(recordedA.body))) && retryArgs.includes('--expect-game-epoch') && retryArgs.includes(EPOCH), 'the resend declared the body it captured');
  assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), recordedB, 'B stays recorded exactly as it was, unsent');
  const after = tc.loadAuthority(dir);
  assert.deepEqual([after.items[first.evaluationId].annotations.explanation.published, after.items[first.evaluationId].annotations.explanation.publishFailed], [false, 'rejected'], 'A was never marked published');
  assert.ok(after.annotationQueue[second.evaluationId]?.explanation, 'B is still queued');
  const relayed = readJson(path.join(dir, 'ui-snapshot.json')).trainingAnnotations ?? {};
  assert.equal(Object.hasOwn(relayed, first.evaluationId) || Object.hasOwn(relayed, second.evaluationId), false, 'nothing reached the relay');
  // A mark for the retired A is refused even if a caller tried: it never reached the relay.
  await assert.rejects(tc.markAnnotationPublished(dir, first.evaluationId, 'explanation', recordedA.body.trainingAnnotations[0].valueSha256), { code: 'ANNOTATION_RETIRED' });
  assert.equal(tc.loadAuthority(dir).items[first.evaluationId].annotations.explanation.published, false);
  // The next flush resends the recorded B as itself (bound), and marks B — only B.
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  const settled = tc.loadAuthority(dir);
  assert.equal(settled.items[second.evaluationId].annotations.explanation.published, true);
  assert.equal(settled.items[first.evaluationId].annotations.explanation.published, false);
  assert.deepEqual(settled.annotationQueue, {});
  assert.deepEqual(Object.keys(readJson(path.join(dir, 'ui-snapshot.json')).trainingAnnotations ?? {}), [second.evaluationId]);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
});

// #274 lifetime contract (5), the helper's own contract: boundaries compose from the inside
// out, the outer boundary's original is the chronologically earlier refusal, the record is
// exactly two closed tuples, and nothing but sanitized status/code pairs is ever attached.
test('preserveInitialRejection: the chronologically first refusal wins across nested boundaries, the record stays two closed tuples, and the same boundary twice is idempotent', () => {
  const refusal = (httpStatus, serverCode, extra = {}) => Object.assign(new Error('relay'), { code: 'PUBLISH_REJECTED', envelope: { httpStatus, serverCode, message: 'PRIVATE_As_Kh_text' }, ...extra });
  const first = refusal(400, 'FORBIDDEN_LITERAL');
  const second = refusal(409, 'ANNOTATION_CONFLICT');
  const third = refusal(413, 'PAYLOAD_TOO_LARGE');
  const closed = (error) => [rejectionTupleOf(error), recheckRejectionTupleOf(error)];

  // The root witness: an inner boundary attached `second`; the outer boundary, whose original is
  // `first`, is the earlier refusal — it must not be lost behind the inner one.
  let later = Object.assign(new Error('os'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  preserveInitialRejection(later, second);
  assert.deepEqual(closed(later), [{ httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }, null]);
  preserveInitialRejection(later, first);
  assert.deepEqual(closed(later), [{ httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }]);
  // Bounded: a third, still earlier boundary keeps two tuples — its own first, and the
  // earliest later answer; the previous recheck is not a third field.
  preserveInitialRejection(later, third);
  assert.deepEqual(closed(later), [{ httpStatus: 413, serverCode: 'PAYLOAD_TOO_LARGE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }]);
  assert.deepEqual(Object.keys(later).filter((key) => /rejection/i.test(key)).sort(), ['recheckRejection', 'rejection']);
  // Idempotent: the same boundary applied again changes nothing, recheck included.
  preserveInitialRejection(later, third);
  assert.deepEqual(closed(later), [{ httpStatus: 413, serverCode: 'PAYLOAD_TOO_LARGE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }]);

  // The usual single boundary: a replacement failure with its own different refusal keeps the
  // original first and its own answer as the recheck; the same answer is no recheck.
  later = refusal(500, 'FORBIDDEN_LITERAL_UNAVAILABLE');
  preserveInitialRejection(later, first);
  assert.deepEqual(closed(later), [{ httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, { httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }]);
  // An original that already carries a recheck (a nonsemantic first answer, then a retry that
  // answered differently) keeps that earliest recheck when a later verification failure
  // replaces it — the record stays two tuples, both of them the ones observed first.
  const observed = Object.assign(new Error('retry'), { code: 'PUBLISH_REJECTED', envelope: { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' } });
  preserveInitialRejection(observed, refusal(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'));
  assert.deepEqual(closed(observed), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }]);
  const verification = Object.assign(new Error('os'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  preserveInitialRejection(verification, observed);
  assert.deepEqual(closed(verification), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'the already observed recheck survives the later wrapper');
  const another = refusal(409, 'ANNOTATION_CONFLICT');
  preserveInitialRejection(another, observed);
  assert.deepEqual(closed(another), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'an even later different answer does not displace the earliest recheck');
  // Nested: the original carries A and its earliest recheck B; the failure already carries an
  // inner boundary's first tuple C. The outer original is earlier than the inner chain: A stays
  // first and B — observed before C — stays the recheck.
  const inner = Object.assign(new Error('os'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  preserveInitialRejection(inner, refusal(409, 'ANNOTATION_CONFLICT'));
  assert.deepEqual(closed(inner), [{ httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }, null]);
  preserveInitialRejection(inner, observed);
  assert.deepEqual(closed(inner), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'the earliest recheck is preferred in the attached branch too');
  // Nested, same first tuple: an inner boundary attached A (and nothing after it); the outer
  // original is A with its earliest recheck B. The recheck is merged, once, and a recheck that
  // is already there is never displaced.
  const sameFirst = Object.assign(new Error('os'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  preserveInitialRejection(sameFirst, refusal(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'));
  assert.deepEqual(closed(sameFirst), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, null]);
  preserveInitialRejection(sameFirst, observed);
  assert.deepEqual(closed(sameFirst), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'the same first tuple still merges the earliest recheck the original observed');
  preserveInitialRejection(sameFirst, observed);
  assert.deepEqual(closed(sameFirst), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'idempotent');
  const laterObserved = Object.assign(new Error('retry'), { code: 'PUBLISH_REJECTED', envelope: { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' } });
  preserveInitialRejection(laterObserved, refusal(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'));
  preserveInitialRejection(sameFirst, laterObserved);
  assert.deepEqual(closed(sameFirst), [{ httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }], 'a recheck already there is not displaced by a later one');
  assert.deepEqual(Object.keys(sameFirst).filter((key) => /rejection/i.test(key)).sort(), ['recheckRejection', 'rejection']);
  // A publisher child's reply carrying the tuples is read the same way as an attached one.
  const fromChild = Object.assign(new Error('child'), { code: 'RELAY_BINDING_CHANGED', envelope: { ok: false, code: 'RELAY_BINDING_CHANGED', rejection: { httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }, recheckRejection: { httpStatus: 413, serverCode: 'PAYLOAD_TOO_LARGE' } } });
  assert.deepEqual(closed(fromChild), [{ httpStatus: 409, serverCode: 'ANNOTATION_CONFLICT' }, { httpStatus: 413, serverCode: 'PAYLOAD_TOO_LARGE' }]);
  assert.deepEqual(closed(Object.assign(new Error('x'), { code: 'RELAY_BINDING_CHANGED', envelope: { rejection: { httpStatus: 400, serverCode: 'EVIL_PRIVATE_As_Kh' } } })), [{ httpStatus: 400, serverCode: 'UNLISTED' }, null]);
  const same = refusal(400, 'FORBIDDEN_LITERAL');
  preserveInitialRejection(same, first);
  assert.deepEqual(closed(same), [{ httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, null]);
  // Only closed pairs travel: an unlisted code is UNLISTED, a message never moves, an original
  // without a tuple attaches nothing, and a non-object failure is returned as is.
  const odd = refusal(418, 'EVIL_PRIVATE_As_Kh');
  const carried = Object.assign(new Error('x'), { code: 'RETIRE_RESULT_UNBOUND' });
  preserveInitialRejection(carried, odd);
  assert.deepEqual(closed(carried), [{ httpStatus: 418, serverCode: 'UNLISTED' }, null]);
  assert.equal(JSON.stringify({ r: carried.rejection, c: carried.recheckRejection ?? null }).includes('As_Kh'), false);
  const plain = Object.assign(new Error('x'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
  preserveInitialRejection(plain, Object.assign(new Error('x'), { code: 'LOCKED' }));
  assert.deepEqual(closed(plain), [null, null]);
  assert.equal(preserveInitialRejection(null, first), null);
  assert.equal(preserveInitialRejection('text', first), 'text');
});

// #274 lifetime contract (5): the first closed refusal (status and allowlisted code) is kept
// when the recovery that follows it fails for its own reason, and kept apart from a different
// answer a recheck produced — on the error itself, so every outer logger sees both.
test('a recovery failure after a refusal keeps the first closed status/code beside its own code: relay verification failure, and a recheck that answers differently', async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const { tc, evaluation } = await seedExplanation(t, dir, { text: LEAKING_TEXT });
  const publisher = executeAgainst(dir);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: publisher, trainingControl: tc }).catch(() => {});
  const attemptBytes = fs.readFileSync(attemptFile(dir), 'utf8');
  const untouched = (label) => {
    assert.equal(fs.readFileSync(attemptFile(dir), 'utf8'), attemptBytes, `${label}: the attempt stays exactly as it was`);
    assert.equal(fs.existsSync(rejectionLog(dir)), false, `${label}: nothing was retired`);
    assert.equal(fs.existsSync(path.join(dir, '.publish-retirement.json')), false, `${label}: no evidence`);
    assert.ok(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId]?.explanation, `${label}: queue kept`);
  };
  const retireWith = (executePublish, verifyRelay) => async (error) => {
    assert.deepEqual([error.code, error.envelope.httpStatus, error.envelope.serverCode], ['PUBLISH_REJECTED', 400, 'FORBIDDEN_LITERAL']);
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish, trainingControl: tc, verifyRelay, relayBinding: () => relayBinding(dir),
    });
    return settled.retired === true || settled.published === true;
  };

  // (a) Relay verification fails before anything is resent: its code is the failure; the
  // first refusal travels with it and there is no recheck.
  const unverified = await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: publisher, trainingControl: tc,
    retirePending: retireWith(publisher, async () => { throw Object.assign(new Error('pid↔port'), { code: 'SERVER_LISTENER_UNAVAILABLE' }); }),
  }).then(() => null, (e) => e);
  assert.equal(unverified?.code, 'SERVER_LISTENER_UNAVAILABLE');
  assert.deepEqual(rejectionTupleOf(unverified), { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' });
  assert.equal(recheckRejectionTupleOf(unverified), null);
  assert.equal(JSON.stringify({ code: unverified.code, rejection: unverified.rejection }).includes('7c'), false);
  untouched('verification failure');

  // (b) The bound relay answers the recheck differently: its deny set cannot be built while the
  // retiring resend is in flight (500 FORBIDDEN_LITERAL_UNAVAILABLE, not retirable). The
  // publisher reports the recheck as it happened; the first refusal is kept apart from it.
  const players = path.join(dir, 'players.json');
  const playersBytes = fs.readFileSync(players);
  const rechecking = async (args) => {
    if (!args.includes('--retire-rejected')) return publisher(args);
    fs.rmSync(players);
    try { return await publisher(args); } finally { fs.writeFileSync(players, playersBytes); }
  };
  const rechecked = await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: rechecking, trainingControl: tc, retirePending: retireWith(rechecking, async () => {}),
  }).then(() => null, (e) => e);
  assert.equal(rechecked?.code, 'PUBLISH_REJECTED');
  assert.deepEqual([rechecked.envelope.httpStatus, rechecked.envelope.serverCode], [500, 'FORBIDDEN_LITERAL_UNAVAILABLE'], 'the recheck as the publisher reported it');
  assert.deepEqual(rejectionTupleOf(rechecked), { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' }, 'the first refusal');
  assert.deepEqual(recheckRejectionTupleOf(rechecked), { httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, 'the different recheck, apart');
  assert.equal(JSON.stringify({ rejection: rechecked.rejection, recheck: rechecked.recheckRejection }).includes('7c'), false);
  untouched('different recheck');

  // (c) Restored, the same path retires it on evidence and the attempt is gone.
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: publisher, trainingControl: tc, retirePending: retireWith(publisher, async () => {}) });
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(tc.loadAuthority(dir).annotationQueue[evaluation.evaluationId], undefined);
});

// #274 lifetime contract (3), the real race: a retirement of refused A whose queue settlement
// waits behind an ordinary training-lock holder, while a flush that had already built A+B from
// the still-unsettled queue tries to send it in that gap. The publisher refuses to judge any
// annotation body while A's retirement evidence is outstanding (nothing is sent, no attempt is
// recorded, no evidence is produced); the flush settles that evidence and must then rebuild
// and publish B in the same flush — never the stale body, never B left queued, never without
// bound.
test('race: a retirement settling behind an ordinary holder while another flush already built A+B — the stale body is refused unsent at the publish lock, B is rebuilt and published in that same flush', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => assert.fail('A must be refused'), (error) => assert.equal(error.code, 'PUBLISH_REJECTED'));
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (probe, label) => {
    for (let n = 0; n < 600; n += 1) { if (probe()) return; await sleep(10); }
    throw new Error(`gate timeout: ${label}`);
  };
  let allowA; let allowB; let releaseHold;
  const gateA = new Promise((resolve) => { allowA = resolve; });
  const gateB = new Promise((resolve) => { allowB = resolve; });
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => { allowA(); allowB(); releaseHold(); });
  let aReady = false; let bReady = false; let holdReady = false; let firstSend = true;
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  const options = { executePublish: record, trainingControl: tc, relayBinding: () => relayBinding(dir) };
  // A's retirement: verified, then held at the gate before it resends.
  const a = pipeline.retireRejectedAnnotationAttempt(dir, { ...options, verifyRelay: async () => { aReady = true; await gateA; } });
  // The other flush: it has built A+B from the still-unsettled queue and is held at its first send.
  const b = pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, trainingControl: tc,
    executePublish: async (args) => {
      if (firstSend) { firstSend = false; bReady = true; await gateB; }
      return record(args);
    },
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, options);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  a.catch(() => {}); b.catch(() => {});
  await until(() => aReady && bReady, 'both in flight');
  // An ordinary holder of the training lock (what a suspended consumer is): every settlement
  // that follows queues behind it.
  const holder = tc.withLock(dir, async () => { holdReady = true; await holdGate; });
  await until(() => holdReady, 'holder');
  // A is retired by the publisher (evidence installed, attempt removed); its queue settlement
  // now waits behind the holder.
  allowA();
  await until(() => fs.existsSync(evidenceFile) && !fs.existsSync(attemptFile(dir)), 'A retired on evidence');
  // In that gap the other flush tries to send A+B: refused at the publish lock while A's
  // evidence is outstanding — nothing sent, no attempt recorded, no evidence produced.
  allowB();
  await until(() => posts.some((row) => row.flags === '--from' && row.result === 'REJECTION_EVIDENCE_PENDING'), 'A+B refused at the publish lock');
  assert.equal(fs.existsSync(attemptFile(dir)), false, 'the refused A+B was never recorded');
  releaseHold();
  await holder;
  const [ra, rb] = await Promise.allSettled([a, b]);

  assert.equal(ra.status, 'fulfilled', JSON.stringify(ra));
  assert.deepEqual([ra.value.retired, ra.value.dropped], [true, 1], 'A retired once on its evidence');
  assert.equal(rb.status, 'fulfilled', `the flush completes: ${JSON.stringify(rb)}`);
  assert.deepEqual(posts.map((row) => [row.flags, row.ids.length, row.result]), [
    ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port', 1, 'retired'],
    ['--from', 2, 'REJECTION_EVIDENCE_PENDING'],
    ['--from', 1, `published:${readJson(path.join(dir, 'ui-snapshot.json')).publishId}`],
  ], 'A retired once; A+B refused unsent while the evidence was outstanding; B rebuilt and published after the settlement');
  assert.deepEqual(posts[2].ids, [second.evaluationId]);
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {}, 'B did not stay queued');
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(fs.existsSync(evidenceFile), false, 'the evidence was consumed by A\'s own settlement');
  const audit = fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1, 'only A was ever retired on evidence; the refused A+B produced none');
  assert.deepEqual(audit[0].items.map((row) => row.evaluationId), [first.evaluationId]);
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId], 'the refused explanation never reached the relay');
});

// R10 (Astra): a FRESH refusal of A+B, then a competing retirement of that exact body whose queue
// settlement waits behind an ordinary holder of the training lock. This flush's own retirement
// helper captured the record but finds no attempt when it comes to resend (settled elsewhere).
// The queue it built from has not changed yet — that is not "no progress": the flush settles the
// outstanding evidence through its own verification once the holder lets go, rebuilds, retires
// the refused note alone and publishes the innocent one, all within this same flush. No
// TRAINING_FLUSH_NO_PROGRESS, nothing latched, no value lost.
test('fresh refusal with a competing retirement settling behind a holder: the losing helper finds no attempt, and the same flush still settles the evidence, rebuilds and publishes the innocent annotation — no false no-progress', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  let releaseHold; let holder = null; let holdReady = false; let raced = false;
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => releaseHold());
  // The losing helper's publisher: before its retiring POST, the competitor retires the very
  // same record (evidence left on disk) while an ordinary holder of the training lock keeps the
  // competitor's queue settlement from happening.
  const losingExecute = async (args) => {
    if (args.includes('--retire-rejected') && !raced) {
      raced = true;
      holder = tc.withLock(dir, async () => { holdReady = true; await holdGate; });
      while (!holdReady) await sleep(10);
      const pending = readJson(attemptFile(dir));
      assert.deepEqual(pending.body.trainingAnnotations.map((note) => note.evaluationId), [first.evaluationId, second.evaluationId], 'the refused record is the A+B body');
      const elsewhere = await record(['--from', viewlessEnvelope(dir, 'retire-elsewhere.json', {
        trainingAnnotations: pending.body.trainingAnnotations, annotationAuthority: pending.annotationAuthority,
      }), ...retireArgs(pending, relayBinding(dir))]);
      assert.equal(elsewhere.retired, true);
      assert.equal(fs.existsSync(evidenceFile), true, 'the competitor left its evidence; its queue settlement waits behind the holder');
      assert.equal(fs.existsSync(attemptFile(dir)), false);
      setTimeout(releaseHold, 300);
    }
    return record(args);
  };
  const outcomes = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: record, trainingControl: tc,
    retirePending: async () => {
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
        executePublish: losingExecute, trainingControl: tc, relayBinding: () => relayBinding(dir),
      });
      outcomes.push(settled);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  await holder;

  assert.equal(outcomes[0]?.settledElsewhere, true, 'this flush\'s own helper found no attempt: settled elsewhere');
  assert.equal(outcomes.length, 2, 'the hook ran for the shared body (raced) and once more for the refused note alone');
  const summary = posts.map((row) => [row.flags.split(' ')[1] ?? 'fresh', row.ids.length, row.result]);
  assert.deepEqual(summary.slice(0, 3), [
    ['fresh', 2, 'PUBLISH_REJECTED'],
    ['--retire-rejected', 2, 'retired'],
    ['--retire-rejected', 2, 'NO_ATTEMPT'],
  ], 'A+B was refused fresh, retired elsewhere, and this flush\'s resend found no attempt');
  assert.equal(posts.filter((row) => row.ids.length === 2 && row.result === 'PUBLISH_REJECTED').length, 1, 'the refused A+B body was never built and sent again as it was');
  assert.equal(posts.some((row) => row.result === 'TRAINING_FLUSH_NO_PROGRESS' || row.result === 'STALE_ANNOTATION_AUTHORITY'), false);
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(posts.filter((row) => row.result.startsWith('published:')).map((row) => [row.ids, row.result]), [[[second.evaluationId], `published:${snapshot.publishId}`]], 'the innocent annotation was published alone, in this flush');
  assert.deepEqual(posts.filter((row) => row.result === 'retired' && row.ids.length === 1).map((row) => row.ids), [[first.evaluationId]], 'the refused note was then retired alone');
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true, 'the innocent annotation still reaches the relay');
  assert.equal(fs.existsSync(evidenceFile), false);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId], 'the refused note never reached the relay');
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 2, 'two audit rows: the shared body, then the refused note alone');
});

// R11 review (Astra F1): the flush's settlement budget bounds settlements that make NO
// progress, not progress itself. Four refused notes and one innocent in one queue: the batch
// is refused and isolated once (nothing leaves the queue — one unit of the budget), then each
// refused note is retired alone (a member leaves the queue each time — progress, the budget
// is whole again), and the innocent one is relayed. Real relay, publisher and training control.
test('a queue of several refused notes drains in one flush: the batch is isolated once, each refused note is retired, the innocent one is relayed — settlements that make progress never exhaust the no-progress budget', { timeout: 60_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const leaking = ['d-1-preflop-0', 'd-2-preflop-0', 'd-3-preflop-0', 'd-4-preflop-0'].map((id) => q3Evaluation(EPOCH, id));
  const innocent = q3Evaluation(EPOCH, 'd-5-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [...leaking, innocent] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  for (const evaluation of leaking) {
    assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  }
  assert.equal((await tc.sealAnnotation(dir, innocent.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const auditRows = () => (fs.existsSync(rejectionLog(dir)) ? fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const retired = [];
  const retirePending = async () => {
    const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
      executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir),
    });
    if (settled.retired) retired.push(auditRows().at(-1).items.length);
    return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
  };
  await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc, retirePending });

  assert.deepEqual(retired, [5, 1, 1, 1, 1], 'the whole batch isolated once, then each refused note retired alone — five settlements, one flush');
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {}, 'the queue is empty');
  for (const evaluation of leaking) {
    assert.equal(after.items[evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
    assert.notEqual(after.items[evaluation.evaluationId].annotations.explanation.published, true);
  }
  assert.equal(after.items[innocent.evaluationId].annotations.explanation.published, true, 'the innocent note reached the relay');
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [innocent.evaluationId], 'only the innocent note is on the relay');
  assert.equal(auditRows().length, 5);
  assert.equal(fs.existsSync(path.join(dir, '.publish-retirement.json')), false);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
});

// The other side of the same budget: a settlement that settles nothing — the relay keeps
// refusing, the hook claims to have settled, no member ever leaves the queue — is still finite.
// After MAX_SETTLEMENTS_PER_FLUSH (4) consecutive stalls the flush ends with
// TRAINING_FLUSH_NO_PROGRESS; nothing is dropped, marked or sent beyond that bound.
test('a settlement that settles nothing is finite: consecutive stalls end the flush with TRAINING_FLUSH_NO_PROGRESS, the queue and the attempt untouched', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const evaluation = q3Evaluation(EPOCH);
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [evaluation] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, evaluation.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  // From here every publish is refused, and the hook settles nothing while claiming it did.
  const refusing = await fakeRelay(t, () => ({ status: 400, body: JSON.stringify({ ok: false, code: 'FORBIDDEN_LITERAL' }) }));
  const lock = readJson(path.join(dir, 'lock.json'));
  writeJson(path.join(dir, 'lock.json'), { ...lock, port: refusing.port });
  let hookCalls = 0;
  const error = await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc,
    retirePending: async () => { hookCalls += 1; return true; },
  }).then(() => null, (e) => e);

  assert.equal(error?.code, 'TRAINING_FLUSH_NO_PROGRESS');
  assert.equal(hookCalls, 5, 'the budget of four consecutive stalls, then the fifth ends the flush');
  assert.equal(refusing.requests.length, hookCalls, 'one refused request per stall, none beyond the bound');
  const after = tc.loadAuthority(dir);
  assert.ok(after.annotationQueue[evaluation.evaluationId]?.explanation, 'nothing was dropped from the queue');
  assert.notEqual(after.items[evaluation.evaluationId].annotations.explanation.published, true, 'nothing was marked published');
  assert.equal(fs.existsSync(attemptFile(dir)), true, 'the refused attempt is kept');
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
});

// R11 review (Sol): a competing retirement that completed BEFORE this flush's retirement helper
// first read the record. The helper finds no record; an absent file proves nothing by itself, so
// it reconciles the competitor's evidence — verified, once the ordinary holder of the training
// lock lets go — and reports the body settled elsewhere. Nothing is resent for an absent record.
// The same flush then rebuilds, retires the refused note alone and publishes the innocent one.
test('a competing retirement completed before the helper\'s first read: the helper settles it from verified evidence instead of giving up, resends nothing, and the same flush still publishes the innocent note', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  let releaseHold; let holder = null; let holdReady = false; let raced = false;
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => releaseHold());
  const outcomes = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: record, trainingControl: tc,
    retirePending: async (error) => {
      if (!raced) {
        raced = true;
        // Before this helper reads anything: an ordinary holder takes the training lock, and
        // another process retires the refused record outright — evidence left, its queue
        // settlement unable to happen until the holder lets go.
        holder = tc.withLock(dir, async () => { holdReady = true; await holdGate; });
        while (!holdReady) await sleep(10);
        const pending = readJson(attemptFile(dir));
        const elsewhere = await record(['--from', viewlessEnvelope(dir, 'retire-elsewhere.json', {
          trainingAnnotations: pending.body.trainingAnnotations, annotationAuthority: pending.annotationAuthority,
        }), ...retireArgs(pending, relayBinding(dir))]);
        assert.equal(elsewhere.retired, true);
        assert.equal(fs.existsSync(attemptFile(dir)), false, 'the record is gone before the helper\'s first read');
        assert.equal(fs.existsSync(evidenceFile), true, 'the competitor\'s evidence is outstanding');
        setTimeout(releaseHold, 300);
      }
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
        executePublish: record, trainingControl: tc, relayBinding: () => relayBinding(dir),
        expectedAttempt: error.envelope?.attempt ?? null,
      });
      outcomes.push(settled);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });
  await holder;

  assert.equal(outcomes[0]?.settledElsewhere, true, 'settled elsewhere — from the verified evidence, not from the absent file');
  assert.equal(outcomes[0]?.retired, false);
  const summary = posts.map((row) => [row.flags.split(' ')[1] ?? 'fresh', row.ids.length, row.result]);
  assert.deepEqual(summary.slice(0, 2), [['fresh', 2, 'PUBLISH_REJECTED'], ['--retire-rejected', 2, 'retired']], 'A+B refused fresh, then retired elsewhere before the helper read');
  assert.equal(posts.filter((row) => row.result === 'NO_ATTEMPT').length, 0, 'nothing was resent for the absent record');
  assert.equal(posts.filter((row) => row.ids.length === 2 && row.result === 'PUBLISH_REJECTED').length, 1, 'the A+B body was never sent again as it was');
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(posts.filter((row) => row.result.startsWith('published:')).map((row) => [row.ids, row.result]), [[[second.evaluationId], `published:${snapshot.publishId}`]], 'the innocent note was published alone, in this flush');
  assert.deepEqual(posts.filter((row) => row.result === 'retired' && row.ids.length === 1).map((row) => row.ids), [[first.evaluationId]]);
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true);
  assert.equal(fs.existsSync(evidenceFile), false);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId]);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 2);
});

// R12 review (Astra F2): a competing retirement that COMPLETED before this flush's helper first
// read — attempt removed, private evidence consumed, queue disposed. Nothing survives for the
// helper to reconcile except the exact closed identity the publisher reported for the refused
// attempt (its body digest, publishId and epoch — captured from the actual failure, not made
// up). Matched under the training lock against the durable audit row and the durable queue
// disposition, that identity proves the retirement: the helper settles without sending
// anything, and the same flush publishes the note sealed meanwhile.
test('a competing retirement completed before the helper\'s first read is proven by the refused attempt\'s exact identity against the audit row and the queue disposition: no resend, and the same flush publishes the innocent note', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const posts = [];
  const record = async (args) => {
    const from = args.indexOf('--from');
    const envelope = from >= 0 && fs.existsSync(args[from + 1]) ? readJson(args[from + 1]) : null;
    const row = { flags: args.filter((arg) => arg.startsWith('--')).join(' '), ids: (envelope?.trainingAnnotations ?? []).map((note) => note.evaluationId) };
    try {
      const out = await runPublisher(dir, args);
      row.result = out.retired ? 'retired' : `published:${out.publishId}`;
      return out;
    } catch (error) {
      row.result = error.code;
      throw error;
    } finally {
      posts.push(row);
    }
  };
  let raced = false;
  let identity = null;
  const outcomes = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, executePublish: record, trainingControl: tc,
    retirePending: async (error) => {
      if (!raced) {
        raced = true;
        // The refused attempt's closed identity, from the actual publisher failure.
        identity = error.envelope?.attempt ?? null;
        assert.match(identity?.bodySha256 ?? '', /^[0-9a-f]{64}$/);
        assert.equal(identity.bodySha256, sha256Hex(JSON.stringify(readJson(attemptFile(dir)).body)), 'the identity names the recorded body');
        assert.equal(identity.expectedGameEpoch, EPOCH);
        // Another caller completes the whole retirement before this helper reads anything.
        const competitor = await pipeline.retireRejectedAnnotationAttempt(dir, {
          executePublish: record, trainingControl: tc, relayBinding: () => relayBinding(dir),
        });
        assert.equal(competitor.retired, true);
        assert.equal(fs.existsSync(attemptFile(dir)), false, 'the attempt is gone');
        assert.equal(fs.existsSync(evidenceFile), false, 'the evidence was consumed');
        // Meanwhile an innocent note is sealed.
        assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
      }
      const settled = await pipeline.retireRejectedAnnotationAttempt(dir, {
        executePublish: record, trainingControl: tc, relayBinding: () => relayBinding(dir),
        expectedAttempt: error.envelope?.attempt ?? null,
      });
      outcomes.push(settled);
      return settled.retired === true || settled.published === true || settled.settledElsewhere === true;
    },
  });

  assert.deepEqual(outcomes, [{ retired: false, settledElsewhere: true, completed: true }], 'the losing helper proved the completed retirement');
  const snapshot = readJson(path.join(dir, 'ui-snapshot.json'));
  assert.deepEqual(posts.map((row) => [row.flags.split(' ')[1] ?? 'fresh', row.ids, row.result]), [
    ['fresh', [first.evaluationId], 'PUBLISH_REJECTED'],
    ['--retire-rejected', [first.evaluationId], 'retired'],
    ['fresh', [second.evaluationId], `published:${snapshot.publishId}`],
  ], 'one refusal, one retirement (the competitor\'s), no resend, then the innocent note');
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(after.items[first.evaluationId].annotations.explanation.rejection?.publishId, identity.publishId);
  assert.equal(after.items[second.evaluationId].annotations.explanation.published, true);
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [second.evaluationId]);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1, 'exactly one retirement was audited');
});

// The proof is the identity against the durable traces, never bare absence: with the attempt
// gone and no evidence, a missing audit row, a mismatched identity (another publishId, another
// body, another game) or an undisposed queue settles nothing — nothing is sent, consumed or marked.
test('an absent attempt without evidence is never settled on bare absence: a missing audit row, a mismatched identity or an undisposed queue proves nothing — no resend, nothing consumed or marked', { timeout: 30_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  const refusal = await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => null, (error) => error);
  assert.equal(refusal?.code, 'PUBLISH_REJECTED');
  const identity = refusal.envelope.attempt;
  assert.match(identity?.bodySha256 ?? '', /^[0-9a-f]{64}$/);
  const pending = readJson(attemptFile(dir));
  assert.equal(identity.bodySha256, sha256Hex(JSON.stringify(pending.body)));
  const queueBefore = JSON.stringify(tc.loadAuthority(dir).annotationQueue);
  const neverSends = async () => { throw new Error('nothing may be sent for an absent record'); };
  const helper = (expectedAttempt) => pipeline.retireRejectedAnnotationAttempt(dir, {
    executePublish: neverSends, trainingControl: tc, relayBinding: () => relayBinding(dir), expectedAttempt,
  });
  // (a) The attempt is gone, no evidence, no audit row: the identity has nothing to prove against.
  const aside = path.join(dir, 'attempt-aside.json');
  fs.renameSync(attemptFile(dir), aside);
  assert.deepEqual(await helper(identity), { retired: false }, 'no audit row: not settled');
  assert.deepEqual(await tc.verifyCompletedRetirement(dir, identity), { settled: false, reason: 'AUDIT_MISSING' });
  assert.equal(JSON.stringify(tc.loadAuthority(dir).annotationQueue), queueBefore, 'the queue is untouched');
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
  // (b) The attempt is back and a competitor completes the retirement for real.
  fs.renameSync(aside, attemptFile(dir));
  const competitor = await pipeline.retireRejectedAnnotationAttempt(dir, { executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir) });
  assert.equal(competitor.retired, true);
  assert.equal(fs.existsSync(attemptFile(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, '.publish-retirement.json')), false);
  // A mismatched identity proves nothing: another publishId, another body, another game, a malformed one.
  for (const [label, wrong] of [
    ['another publishId', { ...identity, publishId: identity.publishId + 1 }],
    ['another body', { ...identity, bodySha256: 'ab'.repeat(32) }],
    ['another game', { ...identity, expectedGameEpoch: 'ff'.repeat(32) }],
    ['malformed', { bodySha256: 'not-a-digest', publishId: 'x', expectedGameEpoch: EPOCH }],
    ['none', null],
  ]) {
    assert.deepEqual(await helper(wrong), { retired: false }, label);
  }
  assert.equal((await tc.verifyCompletedRetirement(dir, { ...identity, bodySha256: 'ab'.repeat(32) })).settled, false);
  assert.equal((await tc.verifyCompletedRetirement(dir, { ...identity, expectedGameEpoch: 'ff'.repeat(32) })).reason, 'IDENTITY');
  // The exact identity does: it is proven against the audit row and the disposition, sending nothing.
  assert.deepEqual(await helper(identity), { retired: false, settledElsewhere: true, completed: true });
  const proven = await tc.verifyCompletedRetirement(dir, identity);
  assert.deepEqual(proven, { settled: true, publishId: identity.publishId, bodySha256: identity.bodySha256, items: 1 });
  const after = tc.loadAuthority(dir);
  assert.deepEqual(after.annotationQueue, {});
  assert.equal(after.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1);
});

// R13 review (Sol F1): the publish CLI itself reads the recorded attempt under publish.lock.d.
// A FIFO with no writer at that name must not hang it there: the bounded, preinspected,
// non-blocking reader refuses the entry with the record's durability classification
// (ATTEMPT_SYNC_FAILED, auditCode REJECTION_AUDIT_UNSAFE), nothing is sent, the entry is left,
// and the lock is released. The CLI is the owned child; the host observer bounds it.
test('POSIX: the publish CLI meets a FIFO without a writer at the attempt — fresh and bound retry fail promptly with the closed durability code, no POST, the entry kept, the publish lock released; a malformed regular record is still BAD_ATTEMPT', { skip: process.platform === 'win32' ? 'POSIX FIFO' : false, timeout: 40_000 }, async (t) => {
  const dir = relayDir(t);
  const relay = await fakeRelay(t, () => ({ status: 200, body: '{"ok":true}' }));
  writeJson(path.join(dir, 'lock.json'), { port: relay.port, sessionToken: TOKEN });
  const file = viewlessEnvelope(dir, 'review.json', { review: '검토 문구' });
  const fifo = attemptFile(dir);
  execFileSync('mkfifo', [fifo]);
  assert.equal(fs.lstatSync(fifo).isFIFO(), true);
  const bounded = (args) => new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [TOOL, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      resolve({ elapsedMs: Date.now() - started, killed: Boolean(error?.killed), envelope });
    });
  });
  for (const [label, args] of [
    ['fresh', ['--from', file]],
    ['bound retry', ['--from', file, '--retry', '--expect-attempt-sha256', 'ab'.repeat(32), '--expect-game-epoch', EPOCH]],
  ]) {
    const run = await bounded(args);
    assert.equal(run.killed, false, `${label}: the CLI finished on its own (${run.elapsedMs}ms)`);
    assert.ok(run.elapsedMs < 10_000, `${label}: prompt`);
    assert.equal(run.envelope?.ok, false, label);
    assert.equal(run.envelope?.code, 'ATTEMPT_SYNC_FAILED', `${label}: ${run.envelope?.code}`);
    assert.equal(run.envelope?.auditCode, 'REJECTION_AUDIT_UNSAFE', label);
    assert.equal(JSON.stringify(run.envelope).includes(dir), false, `${label}: no path`);
    assert.equal(fs.lstatSync(fifo).isFIFO(), true, `${label}: the entry is left in place`);
  }
  // The publish lock was released each time: the next publisher takes it at once (a lock still
  // held would answer LOCK_TIMEOUT, not the record's own classification below).
  assert.equal(relay.requests.length, 0, 'nothing was sent');
  assert.equal(fs.existsSync(path.join(dir, '.publish-retirement.json')), false);
  assert.equal(fs.existsSync(rejectionLog(dir)), false);
  // A regular file that is not JSON keeps the publisher's own classification and guarded repair.
  fs.unlinkSync(fifo);
  fs.writeFileSync(fifo, '{not json');
  const malformed = await runPublisher(dir, ['--from', file]).then(() => null, (e) => e);
  assert.equal(malformed?.code, 'BAD_ATTEMPT');
  assert.equal(fs.readFileSync(fifo, 'utf8'), '{not json', 'the malformed record is left for the guarded repair');
  assert.equal(relay.requests.length, 0);
});

// R16 review (Sol F1 / Astra F1): every "settled elsewhere" answer of the retirement helper is
// closed against the captured attempt's full identity — body digest, publishId, game epoch —
// and actual proof (surviving evidence of that identity, or its completed retirement from audit
// and disposition). Three owned fixtures:
//  (1) A refused and queued, its record moved aside; genuine outstanding evidence for ANOTHER
//      body B of the same game. Asked about A, the helper reconciles B on its merits but never
//      acknowledges A: A stays queued and unmarked, A's held bytes unchanged, nothing sent.
//  (2) The helper reads A; before the publisher looks, A is withdrawn without any settlement:
//      the publisher's NO_ATTEMPT proves nothing — a closed NO_ATTEMPT, no "settled elsewhere",
//      A still queued, nothing sent or marked. A is put back afterwards.
//  (3) The helper reads A; before the publisher looks, a competitor completes A's retirement
//      (evidence consumed, audit and disposition durable): the late NO_ATTEMPT is resolved by
//      exact proof for A and the innocent note sealed meanwhile is published fresh, once.
test('settled-elsewhere answers are closed against the captured identity: another body\'s evidence never acknowledges A; a withdrawn A is a closed NO_ATTEMPT; a completed A is proven exactly and the current note still publishes', { timeout: 60_000 }, async (t) => {
  const dir = relayDir(t);
  await startRelay(t, dir);
  const first = q3Evaluation(EPOCH, 'd-1-preflop-0');
  const second = q3Evaluation(EPOCH, 'd-2-preflop-0');
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [first, second] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  const neverSends = async () => { throw new Error('nothing may be sent'); };
  const evidenceFile = path.join(dir, '.publish-retirement.json');
  const queueState = () => JSON.stringify(tc.loadAuthority(dir).annotationQueue);

  // (1) A refused and queued, record held aside; genuine evidence for B outstanding.
  assert.equal((await tc.sealAnnotation(dir, first.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  const refusalA = await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => null, (error) => error);
  assert.equal(refusalA?.code, 'PUBLISH_REJECTED');
  const identityA = refusalA.envelope.attempt;
  const recordA = readJson(attemptFile(dir));
  assert.equal(identityA.bodySha256, sha256Hex(JSON.stringify(recordA.body)));
  const heldA = path.join(dir, 'held-A.json');
  fs.renameSync(attemptFile(dir), heldA);
  const heldBytes = fs.readFileSync(heldA);
  assert.equal((await tc.sealAnnotation(dir, second.evaluationId, 'explanation', LEAKING_TEXT)).ok, true);
  // B alone: its own envelope, refused by the real relay, then retired by the real publisher
  // with its queue settlement left outstanding (genuine evidence for B).
  const refusalAB = await pipeline.flushAnnotationPublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc })
    .then(() => null, (error) => error);
  assert.equal(refusalAB?.code, 'PUBLISH_REJECTED', 'the queue (A and B) was refused as a batch: its record is set aside too');
  const recordAB = readJson(attemptFile(dir));
  fs.renameSync(attemptFile(dir), path.join(dir, 'held-AB.json'));
  const noteB = recordAB.body.trainingAnnotations.find((note) => note.evaluationId === second.evaluationId);
  const itemB = recordAB.annotationAuthority.items.find((entry) => entry.evaluationId === second.evaluationId);
  assert.ok(noteB && itemB, 'B\'s note and authority item come from the real refused batch');
  const bOnly = viewlessEnvelope(dir, 'b-only.json', { trainingAnnotations: [noteB], annotationAuthority: { ...recordAB.annotationAuthority, items: [itemB] } });
  const refusalB = await runPublisher(dir, ['--from', bOnly]).then(() => null, (error) => error);
  assert.equal(refusalB?.code, 'PUBLISH_REJECTED');
  const recordB = readJson(attemptFile(dir));
  assert.deepEqual(recordB.body.trainingAnnotations.map((note) => note.evaluationId), [second.evaluationId]);
  assert.equal((await runPublisher(dir, ['--from', bOnly, ...retireArgs(recordB, relayBinding(dir))])).retired, true);
  assert.equal(fs.existsSync(evidenceFile), true, 'genuine evidence for B is outstanding');
  assert.equal(fs.existsSync(attemptFile(dir)), false, 'and A\'s record is absent (held aside)');
  const askedAboutA = await pipeline.retireRejectedAnnotationAttempt(dir, {
    executePublish: neverSends, trainingControl: tc, relayBinding: () => relayBinding(dir), expectedAttempt: identityA,
  });
  assert.deepEqual(askedAboutA, { retired: false }, 'B\'s evidence never acknowledges A');
  assert.equal(fs.existsSync(evidenceFile), false, 'B was reconciled on its own merits');
  const afterB = tc.loadAuthority(dir);
  assert.equal(afterB.annotationQueue[second.evaluationId], undefined, 'B: retired (its own disposition)');
  assert.equal(afterB.items[second.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.ok(afterB.annotationQueue[first.evaluationId]?.explanation, 'A: still queued');
  assert.equal(afterB.annotationQueue[first.evaluationId].explanation.solo, undefined);
  assert.equal(afterB.items[first.evaluationId].annotations.explanation.publishFailed, undefined, 'A: not marked');
  assert.equal(afterB.items[first.evaluationId].annotations.explanation.published, false, 'A: sealed, explicitly unpublished');
  assert.deepEqual(fs.readFileSync(heldA), heldBytes, 'A\'s held bytes are unchanged');
  assert.equal((await tc.verifyCompletedRetirement(dir, identityA)).settled, false, 'no completed proof for A');
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1, 'only B was ever audited');

  // (2) A put back; the helper reads it, then A is withdrawn before the publisher looks.
  fs.renameSync(heldA, attemptFile(dir));
  const posts = [];
  const recording = async (args) => {
    posts.push(args.filter((arg) => arg.startsWith('--')).join(' '));
    return runPublisher(dir, args);
  };
  const queueBefore = queueState();
  const withdrawn = await pipeline.retireRejectedAnnotationAttempt(dir, {
    executePublish: recording, trainingControl: tc, relayBinding: () => relayBinding(dir),
    verifyRelay: async () => { fs.renameSync(attemptFile(dir), heldA); },
  }).then((result) => ({ result }), (error) => ({ error }));
  assert.equal(withdrawn.error?.code, 'NO_ATTEMPT', `a closed NO_ATTEMPT, not a settlement: ${JSON.stringify(withdrawn)}`);
  assert.equal(withdrawn.result, undefined);
  assert.deepEqual(posts, ['--from --retire-rejected --expect-attempt-sha256 --expect-game-epoch --relay-pid --relay-start-time --relay-port'], 'the publisher looked once and found nothing');
  assert.equal(queueState(), queueBefore, 'A\'s queue entry is intact');
  assert.equal(tc.loadAuthority(dir).items[first.evaluationId].annotations.explanation.publishFailed, undefined, 'A: not marked');
  assert.equal(fs.existsSync(evidenceFile), false);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 1, 'nothing new was audited');
  assert.deepEqual(fs.readFileSync(heldA), heldBytes);

  // (3) A put back; the helper reads it, then a competitor completes A before the publisher looks.
  fs.renameSync(heldA, attemptFile(dir));
  posts.length = 0;
  const completed = await pipeline.retireRejectedAnnotationAttempt(dir, {
    executePublish: recording, trainingControl: tc, relayBinding: () => relayBinding(dir),
    verifyRelay: async () => {
      const competitor = await pipeline.retireRejectedAnnotationAttempt(dir, { executePublish: executeAgainst(dir), trainingControl: tc, relayBinding: () => relayBinding(dir) });
      assert.equal(competitor.retired, true, 'the competitor completed A');
      assert.equal(fs.existsSync(attemptFile(dir)), false);
      assert.equal(fs.existsSync(evidenceFile), false, 'and consumed its evidence');
    },
  });
  assert.deepEqual(completed, { retired: false, settledElsewhere: true, completed: true }, 'the late NO_ATTEMPT is resolved by exact proof for A');
  assert.equal(posts.filter((row) => row.includes('--retire-rejected')).length, 1, 'this helper\'s own publisher call was the one that found nothing');
  const afterA = tc.loadAuthority(dir);
  assert.equal(afterA.annotationQueue[first.evaluationId], undefined, 'A: retired by the competitor');
  assert.equal(afterA.items[first.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(afterA.items[first.evaluationId].annotations.explanation.rejection?.publishId, identityA.publishId);
  assert.equal(fs.readFileSync(rejectionLog(dir), 'utf8').trim().split('\n').length, 2, 'B, then A');
  // The current publication goes on: a fresh innocent note is published once.
  const third = q3Evaluation(EPOCH, 'd-3-preflop-0');
  await tc.acceptEvaluations(dir, { gameEpoch: EPOCH, owner: OWNER, handNo: 1, evaluations: [third] });
  await pipeline.flushMachinePublish(dir, { gameEpoch: EPOCH, executePublish: executeAgainst(dir), trainingControl: tc });
  assert.equal((await tc.sealAnnotation(dir, third.evaluationId, 'explanation', SAFE_TEXT)).ok, true);
  const published = [];
  await pipeline.flushAnnotationPublish(dir, {
    gameEpoch: EPOCH, trainingControl: tc,
    executePublish: async (args) => { const out = await runPublisher(dir, args); published.push(out.publishId); return out; },
    retirePending: async () => false,
  });
  assert.equal(published.length, 1, 'one fresh publication');
  assert.equal(tc.loadAuthority(dir).items[third.evaluationId].annotations.explanation.published, true);
  assert.deepEqual(tc.loadAuthority(dir).annotationQueue, {});
});
