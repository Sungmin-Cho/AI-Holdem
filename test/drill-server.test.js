import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startDrillServer } from '../tools/drill-server.js';
import { startDrill } from '../tools/drill-cli.js';
import { startServer } from '../server/server.js';
import { evaluationIdOf } from '../training/contracts.js';
import { readJsonl } from '../tools/training-store.js';
import { createMistakeBank } from '../tools/training-stores.js';
import { loadPreflopDataset } from '../tools/preflop-dataset.js';
import { lookup } from '../training/providers/preflop-json.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nextSchedule } from '../training/spaced-repetition.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_HREF = pathToFileURL(path.resolve(ROOT, '../tools/drill-server.js')).href;
const CLIENT = path.resolve(ROOT, '../server/drill-public/drill.js');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-dsrv-'));
}

function profileEvents(storeDir) {
  return readJsonl(path.join(storeDir, '.training', 'profile-events.jsonl'));
}

function sessionPath(storeDir) {
  return path.join(storeDir, '.training', 'drill-session.json');
}

function readSession(storeDir) {
  return JSON.parse(fs.readFileSync(sessionPath(storeDir), 'utf8'));
}

function writeSession(storeDir, session) {
  fs.mkdirSync(path.join(storeDir, '.training'), { recursive: true });
  fs.writeFileSync(sessionPath(storeDir), JSON.stringify(session));
}

function attemptKey(sessionId, questionId, attemptNo) {
  return `drill:${sessionId}:${questionId}:${attemptNo}`;
}

function digestOf(key) {
  return createHash('sha256').update(key).digest('hex');
}

function writePending(storeDir) {
  const session = readSession(storeDir);
  const attemptNo = session.index;
  const question = session.queue[attemptNo];
  const key = attemptKey(session.sessionId, question.questionId, attemptNo);
  const digest = digestOf(key);
  const dataset = loadPreflopDataset(path.resolve(ROOT, '../training/data/preflop-baseline-v1.json'));
  const strategy = lookup(dataset, question.prompt);
  const result = evaluateDrillAnswer(question, { action: 'fold' }, strategy);
  let srsPatch = null;
  if (question.candidateMistakeId) {
    const bank = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'mistakes.json'), 'utf8'));
    const before = bank.reviewState[question.candidateMistakeId];
    const at = new Date().toISOString();
    srsPatch = { mistakeId: question.candidateMistakeId, before, patch: {
      lastReviewedAt: at, attempts: before.attempts + 1,
      ...nextSchedule({ ...before, grade: result.grade, now: Date.parse(at) }),
    } };
  }
  session.pending = {
    answer: { action: 'fold' },
    result,
    srsPatch,
    profileEvent: {
      evaluationId: evaluationIdOf({
        gameEpoch: digest,
        decisionId: `d-${attemptNo + 1}-preflop-0`,
        providerId: 'local-preflop-baseline',
        providerVersion: '1.0.0',
      }),
      payloadSha256: digest,
      status: 'supported',
      street: 'preflop',
      spotKey: question.prompt.spotKey,
      handClass: question.prompt.handClass,
      grade: result.grade,
      forced: false,
      evLossBb: null,
      source: { id: strategy.source.id, version: strategy.source.version, contentSha256: strategy.source.contentSha256 },
      origin: 'drill',
      recommended: result.recommended,
      chosen: { action: 'fold' },
      studyRun: { ...session.studyRun, index: attemptNo },
    },
    applied: { srs: false, bank: false, profile: false },
    questionId: question.questionId,
    attemptNo,
  };
  session.pending.bankEvent = structuredClone(session.pending.profileEvent);
  writeSession(storeDir, session);
  return session;
}

async function api(port, token, pathname, { method = 'GET', body, raw, signal } = {}) {
  const url = new URL(pathname, `http://127.0.0.1:${port}`);
  // 토큰은 헤더 전용(P2-2 항목 7) — query token은 401이다.
  const headers = { 'x-drill-token': token };
  const init = { method, headers, signal };
  if (raw != null) {
    headers['Content-Type'] = 'application/json';
    init.body = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.killed) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }, 1000).unref();
  });
}

async function spawnDrillServer(storeDir) {
  const readyFile = path.join(storeDir, 'ready.json');
  const scriptPath = path.join(storeDir, 'run-server.mjs');
  fs.writeFileSync(scriptPath, `
    import fs from 'node:fs';
    import { startDrillServer } from ${JSON.stringify(SERVER_HREF)};
    const started = await startDrillServer({
      storeDir: ${JSON.stringify(storeDir)},
      port: 0,
      token: 'tok-child',
    });
    process.on('SIGTERM', () => {
      started.close().finally(() => process.exit(0));
    });
    fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ port: started.port }));
    await new Promise(() => {});
  `);
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(readyFile)) {
    if (child.exitCode != null) {
      throw new Error(`drill server exited ${child.exitCode}: ${stderr}`);
    }
    if (Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`drill server ready timeout: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { port } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  return { child, port, token: 'tok-child' };
}

test('drill server uses its own token and game server does not serve drill.html', async () => {
  const storeDir = tmp();
  const gameDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'drill-tok' });
  const game = await startServer({ gameDir, port: 0, token: 'game-tok' });
  try {
    const denied = await fetch(`http://127.0.0.1:${drill.port}/api/next`);
    assert.equal(denied.status, 401);
    const started = await fetch(`http://127.0.0.1:${drill.port}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-drill-token': 'drill-tok' },
      body: JSON.stringify({ mode: 'free', seed: '1', idempotencyKey: 'k-existing' }),
    });
    assert.equal((await started.json()).ok, true);
    const page = await fetch(`http://127.0.0.1:${drill.port}/drill.html`);
    assert.equal(page.status, 200);
    const missing = await fetch(`http://127.0.0.1:${game.port}/drill.html`);
    assert.equal(missing.status, 404);
  } finally {
    await drill.close();
    await game.close();
  }
});

test('answer with no session returns 409 and the process survives', async () => {
  const storeDir = tmp();
  const { child, port, token } = await spawnDrillServer(storeDir);
  try {
    const res = await api(port, token, '/api/answer', { method: 'POST', body: { action: 'fold' } });
    assert.equal(res.status, 409);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'NO_SESSION');
    assert.equal(child.exitCode, null);
    const started = await api(port, token, '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'after-409' },
    });
    assert.equal(started.status, 200);
    assert.equal(started.json.ok, true);
    assert.equal(child.exitCode, null);
  } finally {
    await stopChild(child);
  }
});

test('bad JSON returns 400 and the process survives', async () => {
  const storeDir = tmp();
  const { child, port, token } = await spawnDrillServer(storeDir);
  try {
    const res = await api(port, token, '/api/start', { method: 'POST', raw: '{' });
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'BAD_JSON');
    assert.equal(child.exitCode, null);
    const started = await api(port, token, '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'after-400' },
    });
    assert.equal(started.status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    await stopChild(child);
  }
});

function rawOversizedRequest(port, { chunked, token = 'tok' }) {
  return new Promise((resolve, reject) => {
    let clientSocket = null;
    const headers = { 'Content-Type': 'application/json', 'x-drill-token': token };
    if (!chunked) headers['Content-Length'] = String(70 * 1024);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/start',
      headers,
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        const socketClosed = new Promise((res2) => {
          if (clientSocket == null || clientSocket.destroyed) { res2(true); return; }
          clientSocket.once('close', () => res2(true));
          setTimeout(() => res2(false), 2000);
        });
        socketClosed.then((closed) => resolve({ status: incoming.statusCode, json, closed }));
      });
    });
    req.on('socket', (socket) => { clientSocket = socket; });
    req.on('error', reject);
    if (chunked) {
      req.write('{"idempotencyKey":"');
      req.write('x'.repeat(70 * 1024));
      req.write('"}');
      req.end();
    } else {
      req.end();
    }
  });
}

test('Content-Length가 64KiB를 초과하면 JSON 413을 반환하고 소켓을 닫는다', async () => {
  const storeDir = tmp();
  const { child, port, token } = await spawnDrillServer(storeDir);
  try {
    const res = await rawOversizedRequest(port, { chunked: false, token });
    assert.equal(res.status, 413);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.closed, true, '413 응답 후 소켓이 파괴되어 닫혀야 한다 (무제한 drain 금지)');
    assert.equal(child.exitCode, null);
    const started = await api(port, token, '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'after-413' },
    });
    assert.equal(started.status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    await stopChild(child);
  }
});

test('chunked body가 64KiB를 초과하면 JSON 413을 반환하고 소켓을 닫는다', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const res = await rawOversizedRequest(drill.port, { chunked: true });
    assert.equal(res.status, 413);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.closed, true, '413 응답 후 소켓이 파괴되어 닫혀야 한다 (무제한 drain 금지)');
    const started = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'after-chunked-413' },
    });
    assert.equal(started.status, 200);
  } finally {
    await drill.close();
  }
});

test('/api/start without idempotencyKey returns 400', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const res = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'USAGE');
  } finally {
    await drill.close();
  }
});

test('duplicate answer submit returns the same response and applies profile once', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const started = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'dup-http' },
    });
    assert.equal(started.status, 200);
    assert.match(started.json.sessionId, UUID_RE);
    const nxt = await api(drill.port, 'tok', '/api/next');
    const body = {
      action: 'fold',
      sessionId: started.json.sessionId,
      questionId: nxt.json.question.questionId,
      attemptNo: nxt.json.attemptNo,
    };
    const first = await api(drill.port, 'tok', '/api/answer', { method: 'POST', body });
    const second = await api(drill.port, 'tok', '/api/answer', { method: 'POST', body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.result, first.json.result);
    assert.equal(profileEvents(storeDir).length, 1);
  } finally {
    await drill.close();
  }
});

test('lost answer response retry is idempotent', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const started = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'lost-ans' },
    });
    const nxt = await api(drill.port, 'tok', '/api/next');
    const body = {
      action: 'fold',
      sessionId: started.json.sessionId,
      questionId: nxt.json.question.questionId,
      attemptNo: nxt.json.attemptNo,
    };
    const first = await api(drill.port, 'tok', '/api/answer', { method: 'POST', body });
    const retry = await api(drill.port, 'tok', '/api/answer', { method: 'POST', body });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json.result, first.json.result);
    assert.equal(retry.json.ok, true);
    assert.equal(profileEvents(storeDir).length, 1);
  } finally {
    await drill.close();
  }
});

test('delayed retry from a previous sessionId returns 409', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const first = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'sess-a' },
    });
    const nxt = await api(drill.port, 'tok', '/api/next');
    const second = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'sess-b' },
    });
    assert.notEqual(second.json.sessionId, first.json.sessionId);
    const stale = await api(drill.port, 'tok', '/api/answer', {
      method: 'POST',
      body: {
        action: 'fold',
        sessionId: first.json.sessionId,
        questionId: nxt.json.question.questionId,
        attemptNo: nxt.json.attemptNo ?? 0,
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json?.code, 'STALE_QUESTION');
    assert.equal(profileEvents(storeDir).length, 0);
  } finally {
    await drill.close();
  }
});

test('start preserves pending with 409 until explicit recovery applies bank, profile and SRS exactly once', async () => {
  const storeDir = tmp();
  const bank = createMistakeBank(storeDir);
  const source = {
    id: 'local-preflop-baseline', version: '1.0.0',
    contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
  };
  const candidate = await bank.collect({
    evaluationId: evaluationIdOf({ gameEpoch: 'ab'.repeat(32), decisionId: 'd-9-preflop-0', providerId: source.id, providerVersion: source.version }),
    payloadSha256: 'cd'.repeat(32), status: 'supported', street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA', grade: 'off-policy',
    forced: false, evLossBb: null, source, origin: 'game',
  });
  const originalEvidence = await bank.listEvidence({ origin: 'game' });
  const bytes = () => Object.fromEntries(['drill-session.json', 'profile.json', 'profile-events.jsonl', 'mistakes.json'].map((name) => {
    const file = path.join(storeDir, '.training', name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
  }));
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const first = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'mistake-review', seed: '1', idempotencyKey: 'pend-a' },
    });
    const captured = writePending(storeDir);
    const before = bytes();
    const blocked = await api(drill.port, 'tok', '/api/start', {
      method: 'POST', body: { mode: 'free', seed: '1', idempotencyKey: 'pend-b' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'PENDING_UNRESOLVED');
    assert.deepEqual(bytes(), before);
    const recovered = await api(drill.port, 'tok', '/api/next');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.index, 1);
    const retried = await api(drill.port, 'tok', '/api/answer', {
      method: 'POST', body: { action: 'fold', sessionId: captured.sessionId,
        questionId: captured.queue[0].questionId, attemptNo: 0 },
    });
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.json.result, captured.pending.result);
    assert.equal(profileEvents(storeDir).length, 1);
    assert.deepEqual(await bank.listEvidence({ origin: 'game' }), originalEvidence);
    assert.equal((await bank.listEvidence({ origin: 'practice' })).length, 1);
    assert.equal((await bank.list()).find((item) => item.mistakeId === candidate.item.mistakeId).attempts, 1);
    const continued = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'pend-b' },
    });
    assert.equal(continued.status, 200);
    assert.notEqual(continued.json.sessionId, first.json.sessionId);
    assert.equal(profileEvents(storeDir).length, 1);

    writePending(storeDir);
    fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
    const unresolved = bytes();
    const failed = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'pend-c' },
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.json?.code, 'PENDING_UNRESOLVED');
    assert.deepEqual(bytes(), unresolved);
    const retryFailed = await api(drill.port, 'tok', '/api/next');
    assert.equal(retryFailed.status, 409);
    assert.equal(retryFailed.json.code, 'PENDING_UNRESOLVED');
    assert.deepEqual(bytes(), unresolved);
    const session = readSession(storeDir);
    assert.ok(session.pending);
    assert.equal(session.sessionId, continued.json.sessionId);
  } finally {
    await drill.close();
  }
});

test('lost start response with the same idempotencyKey returns the existing session', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const first = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'start-lost' },
    });
    const retry = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '9', idempotencyKey: 'start-lost' },
    });
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.sessionId, first.json.sessionId);
    assert.equal(retry.json.count, first.json.count);
    assert.match(first.json.sessionId, UUID_RE);
  } finally {
    await drill.close();
  }
});

test('drill client sends sessionId, questionId, attemptNo and handles 409', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.match(src, /idempotencyKey/);
  assert.match(src, /sessionId/);
  assert.match(src, /questionId/);
  assert.match(src, /attemptNo/);
  assert.match(src, /409/);
});

function trainingBytes(storeDir) {
  return Object.fromEntries(['drill-session.json', 'profile.json', 'profile-events.jsonl', 'mistakes.json'].map((name) => {
    const file = path.join(storeDir, '.training', name);
    return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
  }));
}

test('HTTP rejects unoffered actions and sizes as 400 with unchanged practice evidence', async (t) => {
  for (const answer of [{ action: 'check' }, { action: 'call' }, { action: 'raise', sizeBb: 8.5 }]) await t.test(JSON.stringify(answer), async () => {
    const storeDir = tmp();
    const session = await startDrill(storeDir, { mode: 'free', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AA' });
    const drill = await startDrillServer({ storeDir, port: 0, token: 'offered-actions' });
    try {
      const before = trainingBytes(storeDir);
      const response = await api(drill.port, drill.token, '/api/answer', { method: 'POST', body: {
        ...answer, sessionId: session.sessionId, questionId: session.queue[0].questionId, attemptNo: 0,
      } });
      assert.equal(response.status, 400);
      assert.equal(response.json.code, 'INVALID_DRILL_ANSWER');
      assert.deepEqual(trainingBytes(storeDir), before);
    } finally { await drill.close(); }
  });
});

test('HTTP maps known invalid modes to 400 while internal errors remain 500', async () => {
  const storeDir = tmp();
  await startDrill(storeDir, { mode: 'free' });
  const drill = await startDrillServer({ storeDir, port: 0, token: 'mode-errors' });
  try {
    const before = trainingBytes(storeDir);
    const invalid = await api(drill.port, drill.token, '/api/start', { method: 'POST', body: { mode: 'invalid-mode', idempotencyKey: 'bad-mode' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'INVALID_DRILL_MODE');
    assert.deepEqual(trainingBytes(storeDir), before);
    fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
    const corrupted = trainingBytes(storeDir);
    const internal = await api(drill.port, drill.token, '/api/start', { method: 'POST', body: { mode: 'free', idempotencyKey: 'internal-error' } });
    assert.equal(internal.status, 500);
    assert.equal(internal.json.code, 'UNSUPPORTED_PROFILE');
    assert.deepEqual(trainingBytes(storeDir), corrupted);
  } finally { await drill.close(); }
});
