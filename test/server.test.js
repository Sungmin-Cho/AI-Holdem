import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-srv-'));
}

async function start(gameDir, token = 'tok-test') {
  return startServer({ gameDir, port: 0, token });
}

async function closeOf(started) {
  if (started) await started.close();
}

async function req(port, pathname, { method = 'GET', token, queryToken, body, raw } = {}) {
  const url = new URL(pathname, `http://127.0.0.1:${port}`);
  if (token != null && method === 'GET') url.searchParams.set('token', token);
  if (queryToken != null) url.searchParams.set('token', queryToken);
  const headers = { Connection: 'close' };
  const init = { method, headers };
  if (raw != null) {
    headers['Content-Type'] = 'application/json';
    init.body = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(token != null && method !== 'GET' ? { token, ...body } : body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

function publish(port, token, body) {
  return req(port, '/api/publish', { method: 'POST', token, body });
}

function snapshot(port, token) {
  return req(port, '/api/snapshot', { token });
}

function action(port, token, body) {
  return req(port, '/api/action', { method: 'POST', token, body });
}

function waitAction(port, token, { expectDecisionId, timeoutMs = 200 } = {}) {
  const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
  if (expectDecisionId != null) q.set('expectDecisionId', expectDecisionId);
  return req(port, `/api/wait-action?${q}`, { token });
}

function ev(seq, type) {
  return { seq, visibility: 'public', type };
}

function viewWith(decisionId) {
  return { legal: { decisionId }, toAct: 'user', street: 'preflop' };
}

function parseSse(text) {
  const events = [];
  let id = null;
  const dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      id = null;
      return;
    }
    events.push({ id, data: JSON.parse(dataLines.join('\n')) });
    id = null;
    dataLines.length = 0;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') { flush(); continue; }
    if (line.startsWith(':') || line.startsWith('retry:')) continue;
    if (line.startsWith('id:')) { id = line.slice(3).trim(); continue; }
    if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); }
  }
  try { flush(); } catch { /* incomplete tail */ }
  return events;
}

function collectSse(url, { until, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reqHttp = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        settled = true;
        reject(new Error(`SSE ${res.statusCode}`));
        return;
      }
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reqHttp.destroy();
        reject(new Error(`SSE wait timeout: ${buf}`));
      }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        buf += chunk;
        let events = [];
        try { events = parseSse(buf); } catch { return; }
        if (until(events, buf)) {
          settled = true;
          clearTimeout(timer);
          reqHttp.destroy();
          resolve({ events, buf, status: res.statusCode, headers: res.headers });
        }
      });
    });
    reqHttp.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

test('publish → snapshot → SSE after-replay 갭 없음', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const r1 = await publish(srv.port, token, {
      publishId: 1,
      view: { n: 1 },
      events: [ev(1, 'hand_start')],
      messages: [{ type: 'narration', text: '시작' }],
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.revision, 1);

    const r2 = await publish(srv.port, token, {
      publishId: 2,
      view: { n: 2 },
      events: [ev(2, 'street')],
    });
    assert.equal(r2.json.revision, 2);

    const snap = await snapshot(srv.port, token);
    assert.equal(snap.status, 200);
    assert.equal(snap.json.revision, 2);
    assert.equal(snap.json.view.n, 2);
    assert.equal(snap.json.log.length, 3);
    assert.equal(snap.json.log[0].type, 'hand_start');
    assert.equal(snap.json.log[1].type, 'narration');
    assert.equal(snap.json.log[2].type, 'street');
    assert.equal(snap.json.history, undefined);
    assert.equal(snap.json.publishId, undefined);

    const viewOnly = await publish(srv.port, token, { publishId: 3, view: { n: 3 } });
    assert.equal(viewOnly.json.revision, 3);
    const snap2 = await snapshot(srv.port, token);
    assert.equal(snap2.json.log.length, 3);
    assert.equal(snap2.json.view.n, 3);

    const sse = await collectSse(
      `http://127.0.0.1:${srv.port}/api/events?token=${token}&after=1`,
      { until: (events) => events.some((e) => Number(e.id) === 2) },
    );
    assert.match(sse.buf, /retry:\s*3000/);
    const ids = sse.events.map((e) => Number(e.id));
    assert.equal(ids.includes(1), false);
    assert.ok(ids.includes(2));
    const rev2 = sse.events.find((e) => Number(e.id) === 2);
    assert.equal(rev2.data.events[0].type, 'street');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('publishId 중복은 같은 revision 반환(로그 중복 없음)', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const body = {
      publishId: 7,
      view: { k: 1 },
      events: [ev(1, 'blinds_posted')],
      messages: [{ type: 'talk', playerId: 'p1', text: '하이' }],
    };
    const a = await publish(srv.port, token, body);
    const b = await publish(srv.port, token, body);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.revision, 1);
    assert.equal(b.json.revision, 1);
    const snap = await snapshot(srv.port, token);
    assert.equal(snap.json.revision, 1);
    assert.equal(snap.json.log.length, 2);
    assert.equal(snap.json.log.filter((item) => item.type === 'blinds_posted').length, 1);
    assert.equal(snap.json.log.filter((item) => item.type === 'talk').length, 1);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('action: decisionId 불일치 409, 일치 시 wait-action이 소비', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-1-preflop-0';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });

    const stale = await action(srv.port, token, { decisionId: 'd-stale', action: 'fold' });
    assert.equal(stale.status, 409);

    const waiting = waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 2000 });
    const posted = await action(srv.port, token, { decisionId, action: 'raise', amount: 200 });
    assert.equal(posted.status, 200);
    const got = await waiting;
    assert.equal(got.status, 200);
    assert.equal(got.json.timeout, undefined);
    assert.equal(got.json.decisionId, decisionId);
    assert.equal(got.json.action, 'raise');
    assert.equal(got.json.amount, 200);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('토큰 없음 401, 바디 65KB 413', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const health = await req(srv.port, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });

    const noSnap = await req(srv.port, '/api/snapshot');
    assert.equal(noSnap.status, 401);
    const wrong = await req(srv.port, '/api/snapshot', { token: 'nope' });
    assert.equal(wrong.status, 401);
    const noPub = await req(srv.port, '/api/publish', { method: 'POST', body: { publishId: 1, view: {} } });
    assert.equal(noPub.status, 401);
    const noAct = await req(srv.port, '/api/action', { method: 'POST', body: { decisionId: 'd-1', action: 'fold' } });
    assert.equal(noAct.status, 401);

    const huge = 'x'.repeat(65 * 1024);
    const tooBig = await req(srv.port, '/api/publish', {
      method: 'POST',
      queryToken: token,
      raw: huge,
    });
    assert.equal(tooBig.status, 413);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('타임아웃 설정: server.timeout===0, keepAliveTimeout>=75000, headersTimeout>=80000', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    assert.equal(srv.server.timeout, 0);
    assert.ok(srv.server.keepAliveTimeout >= 75000);
    assert.ok(srv.server.headersTimeout >= 80000);
    const addr = srv.server.address();
    assert.equal(addr.address, '127.0.0.1');
    const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'lock.json'), 'utf8'));
    assert.equal(lock.serverPid, process.pid);
    assert.equal(lock.port, srv.port);
    assert.equal(lock.sessionToken, token);
    assert.ok(typeof lock.startedAt === 'string' && lock.startedAt.length > 0);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('서버 재시작: ui-snapshot.json에서 revision·log·coach까지 복원', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  let a;
  let b;
  try {
    a = await start(gameDir, token);
    const posted = await publish(a.port, token, {
      publishId: 1,
      view: { street: 'flop' },
      events: [ev(1, 'hand_start')],
      messages: [{ type: 'narration', text: '핸드 시작' }],
      coach: [{ handNo: 1, text: '좋은 폴드였습니다.' }],
    });
    assert.equal(posted.json.revision, 1);
    const before = await snapshot(a.port, token);
    await a.close();
    a = null;

    b = await start(gameDir, token);
    const after = await snapshot(b.port, token);
    assert.equal(after.json.revision, before.json.revision);
    assert.deepEqual(after.json.log, before.json.log);
    assert.deepEqual(after.json.coach, before.json.coach);
    assert.deepEqual(after.json.view, before.json.view);
    assert.equal(after.json.coach[0].text, '좋은 폴드였습니다.');
  } finally {
    await closeOf(a);
    await closeOf(b);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('review 게시 → snapshot 보존 → 서버 재시작 후 복원', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const review = '# 리뷰\n과정은 좋았습니다.';
  let a;
  let b;
  try {
    a = await start(gameDir, token);
    await publish(a.port, token, {
      publishId: 1,
      view: { gameOver: true, result: 'win' },
      review,
    });
    const before = await snapshot(a.port, token);
    assert.equal(before.json.review, review);
    await a.close();
    a = null;

    b = await start(gameDir, token);
    const after = await snapshot(b.port, token);
    assert.equal(after.json.review, review);
    assert.equal(after.json.view.result, 'win');
    assert.equal(after.json.revision, before.json.revision);
  } finally {
    await closeOf(a);
    await closeOf(b);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('깊이 1 덮어쓰기: 같은 decisionId로 두 번 POST → 마지막 값만 소비', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-2-flop-3';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    const first = await action(srv.port, token, { decisionId, action: 'fold' });
    const second = await action(srv.port, token, { decisionId, action: 'call', amount: 50 });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const got = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(got.json.action, 'call');
    assert.equal(got.json.amount, 50);
    assert.notEqual(got.json.action, 'fold');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('소비 직후의 두 번째 wait-action은 timeout', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-3-turn-1';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'check' });
    const first = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(first.json.action, 'check');
    const second = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 150 });
    assert.equal(second.status, 200);
    assert.equal(second.json.timeout, true);
    assert.equal(second.json.action, undefined);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('슬롯 decisionId ≠ expectDecisionId면 소비하지 않고 timeout', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-4-river-0';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'fold' });
    const mismatch = await waitAction(srv.port, token, { expectDecisionId: 'd-OTHER', timeoutMs: 150 });
    assert.equal(mismatch.json.timeout, true);
    const matched = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(matched.json.timeout, undefined);
    assert.equal(matched.json.action, 'fold');
    assert.equal(matched.json.decisionId, decisionId);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});
