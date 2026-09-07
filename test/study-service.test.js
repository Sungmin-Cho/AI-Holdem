import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivatePath } from '../shared/platform-files.js';
import { startDrillServer } from '../tools/drill-server.js';
import { createOwnedTempDir, registerOwnedServer, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
test('REQ-010: drill health advertises an authenticated study capability', async () => {
  const storeDir = createOwnedTempDir('holdem-study-health');
  const drill = await startDrillServer({ storeDir, token: 'health-token' });
  registerOwnedServer(drill.server);
  try {
    const response = await fetch(`http://127.0.0.1:${drill.port}/api/health`, {
      headers: { 'x-drill-token': 'health-token' },
    });
    assert.equal(response.status, 200, 'study health must be an authenticated capability endpoint');
    assert.equal((await response.json()).capabilities.study, true);
  } finally { await drill.close(); }
});

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { skipOnWin32 } from './helpers/platform.js';
import { acquireOwnedLock, releaseOwnedLock, ownedProcessStartTime as processStartTime } from '../engine/state.js';
import { startDrill, nextQuestion, answerQuestion } from '../tools/drill-cli.js';
import { createProfileStore } from '../tools/training-stores.js';
import {
  descriptorPath,
  lockPath,
  service,
  wait,
  source,
  request,
  standalone,
  launch,
  until,
  readDescriptor,
  unfinishedRequest,
  assessmentEvent,
  replaceEvents,
} from './helpers/study-service-fixtures.mjs';

test('REQ-010: API authentication precedes incomplete body and training I/O', async (t) => {
  const { storeDir, port } = await standalone(t);
  fs.symlinkSync(path.join(storeDir, 'does-not-exist'), path.join(storeDir, '.training'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const headers of [{}, { 'x-drill-token': 'game-token' }]) {
    const result = await unfinishedRequest(port, '/api/start?token=study-http', headers);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'UNAUTHORIZED');
  }
  assert.equal(fs.lstatSync(path.join(storeDir, '.training')).isSymbolicLink(), true);
});

test('REQ-010: only header tokens authenticate every API route', async (t) => {
  const { port, token } = await standalone(t);
  for (const route of ['/api/health', '/api/summary', '/api/current', '/api/next', '/api/unknown']) {
    assert.equal((await request(port, undefined, `${route}?token=${token}`)).status, 401);
    assert.equal((await request(port, 'game-token', route)).status, 401);
  }
  assert.equal((await request(port, token, '/api/unknown')).status, 404);
});

test('REQ-010: mutations reject foreign origins and cross-site fetches before body', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  for (const headers of [{ origin: 'https://elsewhere.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await unfinishedRequest(port, '/api/start', { 'x-drill-token': token, ...headers });
    assert.equal(result.status, 403);
  }
  assert.equal(fs.existsSync(path.join(storeDir, '.training')), false);
  assert.equal((await request(port, token, '/api/heartbeat', {
    body: {}, headers: { origin: `http://127.0.0.1:${port}` },
  })).status, 200);
});

test('REQ-010: explicit static whitelist hides private files and serves shared reference', async (t) => {
  const { port } = await standalone(t);
  for (const route of ['/', '/drill.html', '/drill.js', '/drill.css', '/shared/reference.js']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200, route); await response.text();
  }
  for (const route of ['/package.json', '/.training/study-service.json', '/shared/study-contract.js',
    '/%2e%2e/tools/study-service.js', '/drill.html/extra', '/api/drill.html']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-drill-token': 'study-http' } });
    assert.equal(response.status, 404, route); assert.equal((await response.json()).ok, false);
  }
});

test('REQ-010: typed bounded selectors reject paths, clocks and coercions without writes', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  for (const change of [{ storeDir: '/tmp/other' }, { now: '2099-01-01' }, { seed: {} }, { mode: [] },
    { spotKey: {} }, { handClass: 22 }, { assessmentId: {} }, { idempotencyKey: 'x'.repeat(300) }]) {
    const result = await request(port, token, '/api/start', { body: { mode: 'free', idempotencyKey: 'key', ...change } });
    assert.equal(result.status, 400, JSON.stringify(change));
  }
  assert.equal(fs.existsSync(path.join(storeDir, '.training')), false);
  assert.equal((await request(port, token, '/api/heartbeat', { body: { now: 0 } })).status, 400);
});

test('REQ-010: current preserves committed progress and selected question context', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const started = await request(port, token, '/api/start', { body: { mode: 'free', seed: 's7',
    spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo', idempotencyKey: 'selected' } });
  assert.equal(started.status, 200);
  const current = (await request(port, token, '/api/current')).body;
  assert.equal(current.count, 1); assert.equal(current.question.prompt.handClass, 'AJo');
  const answer = { action: 'fold', sessionId: current.sessionId, questionId: current.question.questionId, attemptNo: 0 };
  assert.equal((await request(port, token, '/api/answer', { body: answer })).status, 200);
  const refreshed = (await request(port, token, '/api/current')).body;
  assert.equal(refreshed.index, 1); assert.equal(refreshed.sessionId, current.sessionId);
  assert.ok(refreshed.lastFeedback);
  assert.equal((await request(port, token, '/api/answer', { body: { ...answer, attemptNo: '0' } })).status, 400);
  assert.equal((await createProfileStore(storeDir).readEventSnapshot()).length, 1);
});

test('REQ-010: internal errors expose stable codes without paths or messages', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  fs.mkdirSync(path.join(storeDir, '.training'), { mode: 0o700 });
  fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), '{"schemaVersion":999}', { mode: 0o600 });
  const response = await request(port, token, '/api/summary');
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'UNSUPPORTED_PROFILE');
  assert.equal(JSON.stringify(response.body).includes(storeDir), false);
  assert.equal(JSON.stringify(response.body).includes('999'), false);
});

test('REQ-002: summary is origin-explicit and practice cannot alter game evidence', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const before = (await request(port, token, '/api/summary')).body.summary;
  const run = await startDrill(storeDir, { mode: 'free', idempotencyKey: 'practice-summary' });
  const question = await nextQuestion(storeDir);
  await answerQuestion(storeDir, { action: 'fold', sessionId: run.sessionId,
    questionId: question.question.questionId, attemptNo: 0 });
  const summary = (await request(port, token, '/api/summary')).body.summary;
  assert.deepEqual(summary.game, before.game);
  assert.equal(summary.practice.overall.supportedDecisions, 1);
  assert.equal(summary.practice.calibration.distributionAgreement, null);
  assert.deepEqual(summary.source, source);
  assert.equal(before.game.overall.allowedActionRate, null);
  for (const forbidden of ['processed', 'mixGroups', 'events', 'mastery', 'evLossBb', storeDir]) {
    assert.equal(JSON.stringify(summary).includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(summary).sort(), ['schemaVersion','source','game','practice','bank','goal','assessments','retests'].sort());
});

test('REQ-011: assessment summary omits question records and reports retest wait', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const run = await startDrill(storeDir, { mode: 'assessment', idempotencyKey: 'assessment-summary' });
  for (let index = 0; index < run.queue.length; index += 1) {
    await answerQuestion(storeDir, { action: 'fold', sessionId: run.sessionId,
      questionId: run.queue[index].questionId, attemptNo: index });
  }
  const summary = (await request(port, token, '/api/summary')).body.summary;
  assert.equal(summary.assessments.length, 1);
  const baseline = summary.assessments[0];
  assert.equal(baseline.id, run.studyRun.id); assert.equal(baseline.complete, true);
  assert.deepEqual(baseline.sourceIdentity, source);
  assert.equal(baseline.retest.eligible, false); assert.ok(baseline.retest.nextAvailableAt);
  assert.equal('questions' in baseline, false); assert.equal('retests' in baseline, false);
  const early = await request(port, token, '/api/start', { body: {
    mode: 'retest', assessmentId: baseline.id, idempotencyKey: 'early-retest',
  } });
  assert.equal(early.status, 409); assert.equal(early.body.code, 'RETEST_NOT_DUE');
  assert.equal(early.body.nextAvailableAt, baseline.retest.nextAvailableAt);
});

test('REQ-010: service is a real detached child with a single private two-capability descriptor', async (t) => {
  const { storeDir, handle, token, api, children } = await launch(t);
  assert.notEqual(handle.pid, process.pid); assert.equal(children.length, 1);
  assert.equal(processStartTime(handle.pid), handle.startTime);
  const descriptor = readDescriptor(storeDir);
  assert.equal(isPrivatePath(descriptorPath(storeDir)), true);
  assert.deepEqual(Object.keys(descriptor).filter((key) => /token/i.test(key)).sort(), ['controlToken', 'drillToken']);
  assert.match(descriptor.drillToken, /^[0-9a-f]{64}$/); assert.match(descriptor.controlToken, /^[0-9a-f]{64}$/);
  assert.notEqual(descriptor.drillToken, descriptor.controlToken); assert.equal(token, descriptor.drillToken);
  assert.equal('controlToken' in handle, false); assert.equal('drillToken' in handle, false);
  const inspected = await api.inspectStudyService(storeDir);
  assert.equal(inspected.status, 'running'); assert.equal(inspected.instanceId, handle.instanceId);
  assert.equal(JSON.stringify(inspected).includes(descriptor.controlToken), false);
  const health = await request(handle.port, token, '/api/health');
  assert.equal(health.body.instanceId, handle.instanceId); assert.equal(health.body.storeIdentity, handle.storeIdentity);
  assert.equal(JSON.stringify(health).includes(descriptor.controlToken), false);
});

test('REQ-010: concurrent ensure calls and relay reuse resolve one live store service', async (t) => {
  const storeDir = createOwnedTempDir('holdem-study-concurrent');
  const api = await service();
  const handles = await Promise.all(Array.from({ length: 5 }, () => api.ensureStudyService(storeDir, {
    onChild(child) { child.ref(); registerOwnedProcess(child, 'concurrent study child'); },
  })));
  t.after(() => api.stopStudyService(storeDir, { expectedInstanceId: handles[0].instanceId }));
  assert.equal(new Set(handles.map((handle) => handle.instanceId)).size, 1);
  assert.equal(new Set(handles.map((handle) => handle.studyUrl)).size, 1);
  assert.deepEqual(await api.ensureStudyService(storeDir), handles[0]);
});

test('REQ-010: browser capability cannot attach parents or stop the service', async (t) => {
  const { handle, token, storeDir } = await launch(t);
  for (const route of ['/internal/parent-attach', '/internal/shutdown']) {
    const denied = await unfinishedRequest(handle.port, route, { 'x-drill-token': token, 'x-study-control': token });
    assert.equal(denied.status, 401);
  }
  const descriptor = readDescriptor(storeDir);
  const invalidParent = await request(handle.port, null, '/internal/parent-attach', {
    headers: { 'x-study-control': descriptor.controlToken }, body: { pid: process.pid, startTime: processStartTime(process.pid) },
  });
  assert.equal(invalidParent.status, 409); assert.equal(invalidParent.body.code, 'PARENT_IDENTITY_MISMATCH');
  assert.equal((await request(handle.port, token, '/api/health')).status, 200);
});

test('REQ-010: actual loop-lock parent keeps service alive and release starts idle expiry', async (t) => {
  // A 300ms idle window against 50ms checkpoints is a model of in-process
  // proofs; on win32 one checkpoint is seconds of PowerShell, so the window
  // cannot be kept alive or measured at this scale.
  if (skipOnWin32(t, 'sub-second idle and heartbeat cadence is below the per-checkpoint proof cost on win32')) return;
  const storeDir = createOwnedTempDir('holdem-study-parent');
  const parent = acquireOwnedLock(storeDir, 'loop.lock.d');
  t.after(() => releaseOwnedLock(parent));
  const { handle, api } = await launch(t, { parentIdentity: { pid: parent.pid, startTime: parent.startTime },
    testOptions: { idleTimeoutMs: 300, checkpointMs: 50 } }, storeDir);
  await wait(650);
  assert.equal((await api.inspectStudyService(storeDir)).instanceId, handle.instanceId);
  releaseOwnedLock(parent);
  await until(() => !fs.existsSync(descriptorPath(storeDir)) && !fs.existsSync(lockPath(storeDir)));
  assert.equal(fs.existsSync(lockPath(storeDir)), false);
});

test('REQ-010: authenticated heartbeat keeps orphan service alive then idle shutdown removes only owned files', async (t) => {
  if (skipOnWin32(t, 'sub-second idle and heartbeat cadence is below the per-checkpoint proof cost on win32')) return;
  const { storeDir, handle, token } = await launch(t, { testOptions: { idleTimeoutMs: 300, checkpointMs: 50 } });
  fs.writeFileSync(path.join(storeDir, 'state.json'), 'USER GAME SENTINEL');
  for (let i = 0; i < 4; i += 1) {
    await wait(150); assert.equal((await request(handle.port, token, '/api/heartbeat', { body: {} })).status, 200);
  }
  await until(() => !fs.existsSync(descriptorPath(storeDir)) && !fs.existsSync(lockPath(storeDir)));
  assert.equal(fs.existsSync(lockPath(storeDir)), false);
  assert.equal(fs.readFileSync(path.join(storeDir, 'state.json'), 'utf8'), 'USER GAME SENTINEL');
  await assert.rejects(fetch(`http://127.0.0.1:${handle.port}/api/health`));
});

test('REQ-010: live owner repairs missing and corrupt regular descriptor without credential rotation', async (t) => {
  const { storeDir, handle, api } = await launch(t);
  const original = readDescriptor(storeDir);
  fs.unlinkSync(descriptorPath(storeDir));
  assert.deepEqual(await api.ensureStudyService(storeDir), handle);
  assert.deepEqual(readDescriptor(storeDir), original);
  fs.writeFileSync(descriptorPath(storeDir), '{', { mode: 0o600 });
  assert.deepEqual(await api.ensureStudyService(storeDir), handle);
  assert.deepEqual(readDescriptor(storeDir), original);
});

test('REQ-010: unsafe descriptor symlink is preserved and owner self-stops without a competitor', async (t) => {
  const { storeDir, handle, api } = await launch(t, { testOptions: { checkpointMs: 100 } });
  const foreign = path.join(storeDir, 'foreign.json'); fs.writeFileSync(foreign, 'FOREIGN');
  fs.unlinkSync(descriptorPath(storeDir)); fs.symlinkSync(foreign, descriptorPath(storeDir));
  let spawns = 0;
  await assert.rejects(api.ensureStudyService(storeDir, { onChild() { spawns += 1; } }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal(spawns, 0);
  await until(() => !fs.existsSync(lockPath(storeDir)));
  assert.equal(fs.lstatSync(descriptorPath(storeDir)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
  await assert.rejects(fetch(`http://127.0.0.1:${handle.port}/api/health`));
});

test('REQ-010: hard-linked or nonprivate descriptors fail closed without modifying foreign bytes', async (t) => {
  for (const kind of ['hardlink', 'mode']) await t.test(kind, async (t) => {
    // chmod changes nothing about privacy on Windows, where the ACL is the
    // boundary and the Windows ACL tests hold that contract instead.
    if (kind === 'mode' && skipOnWin32(t, 'mode bits carry no privacy on win32; the ACL proof does')) return;
    const { storeDir, api } = await launch(t, { testOptions: { checkpointMs: 100 } });
    const foreign = path.join(storeDir, 'foreign-descriptor');
    const before = fs.readFileSync(descriptorPath(storeDir));
    if (kind === 'hardlink') fs.linkSync(descriptorPath(storeDir), foreign);
    else fs.chmodSync(descriptorPath(storeDir), 0o644);
    await assert.rejects(api.ensureStudyService(storeDir), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
    await until(() => !fs.existsSync(lockPath(storeDir)));
    assert.deepEqual(fs.readFileSync(descriptorPath(storeDir)), before);
    if (kind === 'hardlink') assert.deepEqual(fs.readFileSync(foreign), before);
  });
});

test('REQ-010: mismatched descriptor process identity cannot authorize stop or registration', async (t) => {
  // On win32 the owner's checkpoint repairs the forged descriptor before a
  // client proof can read it, so the forged one never gets to be refused.
  if (skipOnWin32(t, 'the owner repairs a forged descriptor before a client proof reads it on win32')) return;
  const { storeDir, handle, api } = await launch(t, { testOptions: { checkpointMs: 200 } });
  const descriptor = readDescriptor(storeDir);
  fs.writeFileSync(descriptorPath(storeDir), JSON.stringify({ ...descriptor, pid: process.pid, startTime: processStartTime(process.pid) }));
  await assert.rejects(api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal(processStartTime(process.pid) !== null, true);
  await until(() => readDescriptor(storeDir).pid === handle.pid);
  await assert.rejects(api.stopStudyService(storeDir, { expectedInstanceId: randomUUID() }), { code: 'STUDY_IDENTITY_MISMATCH' });
  assert.equal((await api.inspectStudyService(storeDir)).instanceId, handle.instanceId);
});

test('REQ-010: explicit restart rotates both credentials and old capabilities return 401', async (t) => {
  const first = await launch(t);
  const old = readDescriptor(first.storeDir);
  const stopped = await first.api.stopStudyService(first.storeDir, { expectedInstanceId: first.handle.instanceId });
  assert.equal(stopped.stopped, true);
  const second = await launch(t, {}, first.storeDir);
  const fresh = readDescriptor(first.storeDir);
  assert.notEqual(fresh.instanceId, old.instanceId); assert.notEqual(fresh.drillToken, old.drillToken);
  assert.notEqual(fresh.controlToken, old.controlToken);
  assert.equal((await request(second.handle.port, old.drillToken, '/api/health')).status, 401);
  assert.equal((await request(second.handle.port, null, '/internal/shutdown', {
    body: {}, headers: { 'x-study-control': old.controlToken },
  })).status, 401);
});

test('REQ-010: startup rejects unsafe root and training containment before spawning', async () => {
  const api = await service();
  const root = createOwnedTempDir('holdem-study-root');
  const foreign = createOwnedTempDir('holdem-study-foreign');
  const link = path.join(root, 'store-link'); fs.symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
  let spawns = 0;
  await assert.rejects(api.ensureStudyService(link, { onChild() { spawns += 1; } }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  fs.symlinkSync(foreign, path.join(root, '.training'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.ensureStudyService(root, { onChild() { spawns += 1; } }), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
  assert.equal(spawns, 0); assert.deepEqual(fs.readdirSync(foreign), []);
});


test('REQ-011: future assessment scores remain unavailable in summaries', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const event = await assessmentEvent(storeDir);
  event.appliedAt = '2099-01-02T00:00:00.000Z';
  event.studyRun.startedAt = '2099-01-01T00:00:00.000Z';
  replaceEvents(storeDir, [event]);
  const summary = (await request(port, token, '/api/summary')).body.summary;
  assert.equal(summary.practice.overall.allowedActionRate, null);
  assert.equal(summary.practice.overall.supportedDecisions, 0);
  assert.equal(summary.assessments[0].reason, 'FUTURE_EVIDENCE');
  assert.equal(summary.assessments[0].result.allowedActionRate, null);
  assert.equal(summary.assessments[0].retest.eligible, false);
});

test('REQ-002: unknown reference tuples are preserved as unverified and cannot become candidates', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const event = await assessmentEvent(storeDir);
  event.mixObservation.sourceIdentity.contentSha256 = 'f'.repeat(64);
  replaceEvents(storeDir, [event]);
  const summary = (await request(port, token, '/api/summary')).body.summary;
  assert.deepEqual(summary.source, source);
  assert.equal(summary.practice.overall.allowedActionRate, null);
  assert.equal(summary.practice.coverage.unverifiedDecisions, 1);
  assert.deepEqual(summary.practice.candidates, []);
  assert.equal(summary.assessments[0].sourceIdentity.contentSha256, 'f'.repeat(64));
  assert.equal(summary.assessments[0].reason, 'UNVERIFIED_SOURCE');
});

test('REQ-002: source-claimed arbitrary pair text is never exposed as a summary goal', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const event = await assessmentEvent(storeDir);
  event.grade = 'off-policy';
  event.mixObservation.spotKey = '/private/user/hidden-token';
  event.mixObservation.handClass = 'opponent private cards';
  replaceEvents(storeDir, [event]);
  const result = await request(port, token, '/api/summary');
  assert.equal(JSON.stringify(result.body).includes('/private/user/hidden-token'), false);
  assert.equal(JSON.stringify(result.body).includes('opponent private cards'), false);
  assert.equal(result.status, 500);
});

test('REQ-011: public assessment history is bounded and excludes raw question evidence', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const base = await assessmentEvent(storeDir);
  const events = Array.from({ length: 110 }, (_, index) => ({ ...structuredClone(base),
    evaluationId: `${index.toString(16).padStart(64, '0')}:d-1-preflop-0:local-preflop-baseline@1.0.0`,
    payloadSha256: index.toString(16).padStart(64, '0'), studyRun: { ...base.studyRun, id: randomUUID() },
  }));
  fs.unlinkSync(path.join(storeDir, '.training', 'profile.json'));
  replaceEvents(storeDir, events);
  const result = await request(port, token, '/api/summary');
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.assessments.length, 100);
  assert.ok(result.body.summary.practice.candidates.length <= 10);
  for (const key of ['evaluationId', 'payloadSha256', 'questions', 'seenPairs', 'processed', 'mixGroups']) {
    assert.equal(JSON.stringify(result.body).includes(`"${key}"`), false, key);
  }
  assert.ok(JSON.stringify(result.body).length < 150_000);
});

test('REQ-002: summary rejects an invalid canonical pair before writing a derived profile', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const event = await assessmentEvent(storeDir);
  event.mixObservation.handClass = 'invalid';
  replaceEvents(storeDir, [event]);
  fs.unlinkSync(path.join(storeDir, '.training', 'profile.json'));
  assert.equal((await request(port, token, '/api/summary')).status, 500);
  assert.equal(fs.existsSync(path.join(storeDir, '.training', 'profile.json')), false);
});

test('REQ-002: summary preserves the profile reader preflop-only learning boundary', async (t) => {
  const { storeDir, port, token } = await standalone(t);
  const event = await assessmentEvent(storeDir);
  event.evaluationId = event.evaluationId.replace('-preflop-', '-flop-');
  event.street = 'flop';
  event.skillKey = 'postflop.flop';
  event.grade = 'off-policy';
  replaceEvents(storeDir, [event]);
  fs.unlinkSync(path.join(storeDir, '.training', 'profile.json'));
  const summary = (await request(port, token, '/api/summary')).body.summary;
  assert.equal(summary.practice.overall.supportedDecisions, 0);
  assert.equal(summary.practice.overall.allowedActionRate, null);
  assert.deepEqual(summary.assessments, []);
  assert.equal(summary.goal.origin, 'default');
});

test('REQ-010: non-UTC parent and service preserve the existing process identity format', async () => {
  const storeDir = createOwnedTempDir('holdem-study-parent-timezone');
  const serviceHref = new URL('../tools/study-service.js', import.meta.url).href;
  const stateHref = new URL('../engine/state.js', import.meta.url).href;
  const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e',
    `import { ensureStudyService,stopStudyService } from ${JSON.stringify(serviceHref)};
     import { acquireOwnedLock,releaseOwnedLock } from ${JSON.stringify(stateHref)};
     const parent=acquireOwnedLock(process.argv[1],'loop.lock.d');let owned,handle;
     try {
       handle=await ensureStudyService(process.argv[1],{parentIdentity:{pid:parent.pid,startTime:parent.startTime},
         testOptions:{idleTimeoutMs:150,checkpointMs:50},onChild(child){owned=child;child.ref();}});
       await new Promise(resolve=>setTimeout(resolve,350));
       const stopped=await stopStudyService(process.argv[1],{expectedInstanceId:handle.instanceId});
       process.stdout.write(JSON.stringify({stopped:stopped.stopped}));
     } finally {
       releaseOwnedLock(parent);
       if(owned && owned.exitCode===null && owned.signalCode===null) {
         owned.kill('SIGTERM');await new Promise(resolve=>owned.once('exit',resolve));
       }
     }`, storeDir,
  ], { env: { ...process.env, TZ: 'Asia/Seoul', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore','pipe','pipe'] }), 'non-UTC study client');
  const result = await new Promise((resolve) => {
    let output='', error='';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('close', (code) => resolve({ code, output, error }));
  });
  assert.equal(result.code, 0, `study child must preserve its parent timezone identity\n${result.error}`);
  assert.deepEqual(JSON.parse(result.output), { stopped: true });
  assert.equal(fs.existsSync(descriptorPath(storeDir)), false);
});

test('REQ-010: a canonical service is reused and attached by a parent in another timezone', async (t) => {
  const { storeDir, handle, token } = await launch(t);
  const serviceHref = new URL('../tools/study-service.js', import.meta.url).href;
  const stateHref = new URL('../engine/state.js', import.meta.url).href;
  const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e',
    `import { ensureStudyService } from ${JSON.stringify(serviceHref)};
     import { acquireOwnedLock,releaseOwnedLock } from ${JSON.stringify(stateHref)};
     import { createHash } from 'node:crypto';
     const parent=acquireOwnedLock(process.argv[1],'loop.lock.d');
     try {
       const handle=await ensureStudyService(process.argv[1],{parentIdentity:{pid:parent.pid,startTime:parent.startTime}});
       process.stdout.write(JSON.stringify({pid:handle.pid,instanceId:handle.instanceId,startTime:handle.startTime,
         urlHash:createHash('sha256').update(handle.studyUrl).digest('hex')}));
     } finally { releaseOwnedLock(parent); }`, storeDir,
  ], { env: { ...process.env, TZ: 'Asia/Seoul', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore','pipe','pipe'] }), 'cross-timezone reuse client');
  const result = await new Promise((resolve) => {
    let output=''; child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0);
  const reused=JSON.parse(result.output);
  assert.equal(reused.pid, handle.pid); assert.equal(reused.instanceId, handle.instanceId);
  assert.equal(reused.startTime, handle.startTime); assert.match(reused.startTime, /^(?:utc-v1:|win32-v1:)/);
  assert.equal(reused.urlHash, createHash('sha256').update(handle.studyUrl).digest('hex'));
  assert.equal((await request(handle.port, token, '/api/health')).status, 200);
});

test('REQ-010: malformed or legacy private lock wire stays unknown before PID liveness', async () => {
  const api = await service();
  for (const raw of ['99999999\nutc-v2\nSun Sep  6 00:00:00 2026',
    '99999999\nutc-v1\nSun Sep 06 00:00:00 2026', '99999999\nSun Sep  6 00:00:00 2026']) {
    const storeDir = createOwnedTempDir('holdem-study-wire');
    fs.mkdirSync(lockPath(storeDir), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(storeDir, '.training'), 0o700);
    fs.writeFileSync(path.join(lockPath(storeDir), 'pid'), raw, { mode: 0o600 });
    await assert.rejects(api.inspectStudyService(storeDir), { code: 'STUDY_DESCRIPTOR_CORRUPT' });
    assert.equal(fs.readFileSync(path.join(lockPath(storeDir), 'pid'), 'utf8'), raw);
  }
});
