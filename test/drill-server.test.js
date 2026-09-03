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
import { startServer } from '../server/server.js';
import { evaluationIdOf } from '../training/contracts.js';
import { readJsonl } from '../tools/training-store.js';

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
  session.pending = {
    answer: { action: 'fold' },
    result: {
      questionId: question.questionId,
      grade: 'mixed',
      frequency: 0.4,
      recommended: [],
      feedback: 'pending-fixture',
      providerVersion: '1.0.0',
    },
    srsPatch: null,
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
      grade: 'mixed',
      forced: false,
      evLossBb: null,
      source: { id: 'local-preflop-baseline', version: '1.0.0' },
    },
    applied: { srs: false, profile: false },
    questionId: question.questionId,
    attemptNo,
  };
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

test('body larger than 64KiB returns 413', async () => {
  const storeDir = tmp();
  const { child, port, token } = await spawnDrillServer(storeDir);
  try {
    const raw = JSON.stringify({ idempotencyKey: 'x'.repeat(64 * 1024) });
    assert.ok(Buffer.byteLength(raw) > 64 * 1024);
    const res = await api(port, token, '/api/start', { method: 'POST', raw });
    assert.equal(res.status, 413);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'PAYLOAD_TOO_LARGE');
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

test('chunked body over 64KiB returns JSON 413 without resetting the socket', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: drill.port,
        method: 'POST',
        path: '/api/start',
        headers: { 'Content-Type': 'application/json', 'x-drill-token': 'tok' },
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON */ }
          resolve({ status: incoming.statusCode, json, text });
        });
      });
      req.on('error', reject);
      req.write('{"idempotencyKey":"');
      req.write('x'.repeat(70 * 1024));
      req.write('"}');
      req.end();
    });
    assert.equal(res.status, 413);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.code, 'PAYLOAD_TOO_LARGE');
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

test('start while pending exists replays then continues; replay failure is 409', async () => {
  const storeDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'tok' });
  try {
    const first = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'pend-a' },
    });
    writePending(storeDir);
    const continued = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'pend-b' },
    });
    assert.equal(continued.status, 200);
    assert.notEqual(continued.json.sessionId, first.json.sessionId);
    assert.equal(profileEvents(storeDir).length, 1);

    writePending(storeDir);
    fs.writeFileSync(path.join(storeDir, '.training', 'profile.json'), JSON.stringify({ schemaVersion: 99 }));
    const failed = await api(drill.port, 'tok', '/api/start', {
      method: 'POST',
      body: { mode: 'free', seed: '1', idempotencyKey: 'pend-c' },
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.json?.code, 'PENDING_UNRESOLVED');
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
