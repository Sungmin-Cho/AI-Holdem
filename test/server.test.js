import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { detailRefOf, projectTrainingSummary } from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-srv-'));
}

// M1: machine item의 identity는 D9 문법이고 detailRef는 그 identity에서 파생된다.
// 이 픽스처들의 주제는 토큰·digest·부모 교체이므로 identity만 계약에 맞춘다.
function detailFixtureIds(decisionId) {
  const evaluationId = evaluationIdOf({
    gameEpoch: 'ab'.repeat(32),
    decisionId,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
  return { evaluationId, ref: detailRefOf(evaluationId) };
}

test('UI는 레거시 talk를 렌더링하지 않고 narration은 유지한다', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'server/public/app.js'), 'utf8');
  assert.equal(source.includes("case 'talk'"), false);
  assert.match(source, /item\.type === 'talk'\) continue/);
  assert.match(source, /case 'narration'/);
});

test('UI는 ESM module로 로드되고 training formatter를 import한다', async () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'server/public/index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/app\.js">/);
  assert.match(html, /id="tab-training"/);
  const app = fs.readFileSync(path.join(process.cwd(), 'server/public/app.js'), 'utf8');
  assert.match(app, /from '\.\/training-format\.js'/);
  const gameDir = tmpDir();
  const srv = await start(gameDir, 'tok-mod');
  try {
    const page = await req(srv.port, '/index.html', { token: 'tok-mod' });
    assert.equal(page.status, 200);
    const js = await req(srv.port, '/training-format.js', { token: 'tok-mod' });
    assert.equal(js.status, 200);
    assert.match(js.text, /formatTrainingCard/);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

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

test('소비된 액션은 그 결정이 끝날 때까지만 재전달되고, 결정이 넘어가면 사라진다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-3-turn-1';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'check' });
    const first = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(first.json.action, 'check');

    // 응답을 못 받은 딜러가 같은 결정을 다시 물으면 그대로 다시 받는다
    const second = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 150 });
    assert.equal(second.status, 200);
    assert.equal(second.json.action, 'check');

    // 액션이 적용되어 다음 결정이 게시되면 옛 액션은 더 이상 없다
    await publish(srv.port, token, { publishId: 2, view: viewWith('d-3-turn-2') });
    const stale = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 150 });
    assert.equal(stale.json.timeout, true);
    assert.equal(stale.json.action, undefined);
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

test('publish: history 엔트리에 게시 시각이 남는다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    await publish(srv.port, token, { publishId: 1, view: viewWith('d-1-preflop-0'), events: [ev(0, 'hand_start')] });
    await publish(srv.port, token, { publishId: 2, events: [ev(1, 'action')] });
    const persisted = JSON.parse(fs.readFileSync(path.join(gameDir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(persisted.history.length, 2);
    for (const entry of persisted.history) {
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(Math.abs(Date.now() - Date.parse(entry.at)) < 60_000);
    }
    assert.ok(Date.parse(persisted.history[1].at) >= Date.parse(persisted.history[0].at));
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: 역순으로 도착해도 handNo 순으로 정렬되고 중복은 갱신된다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    // 백그라운드 코치가 핸드 순서와 다르게 완료되는 상황
    await publish(srv.port, token, { publishId: 1, coach: [{ handNo: 2, text: '두 번째' }] });
    await publish(srv.port, token, { publishId: 2, coach: [{ handNo: 1, text: '첫 번째' }] });
    let snap = await snapshot(srv.port, token);
    assert.deepEqual(snap.json.coach.map((note) => note.handNo), [1, 2]);

    // 같은 핸드가 다시 오면 덧붙지 않고 갱신된다
    await publish(srv.port, token, { publishId: 3, coach: [{ handNo: 1, text: '첫 번째(수정)' }] });
    snap = await snapshot(srv.port, token);
    assert.deepEqual(snap.json.coach.map((note) => note.handNo), [1, 2]);
    assert.equal(snap.json.coach[0].text, '첫 번째(수정)');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('publish: 저장에 실패하면 메모리 상태도 바뀌지 않는다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    await publish(srv.port, token, { publishId: 1, events: [ev(0, 'hand_start')] });
    const before = await snapshot(srv.port, token);

    // ui-snapshot.json 자리를 디렉터리로 막아 rename이 실패하게 만든다
    fs.rmSync(path.join(gameDir, 'ui-snapshot.json'));
    fs.mkdirSync(path.join(gameDir, 'ui-snapshot.json'));
    const failed = await publish(srv.port, token, { publishId: 2, events: [ev(1, 'action')] });
    assert.notEqual(failed.status, 200, '저장 실패인데 성공으로 응답했다');

    const after = await snapshot(srv.port, token);
    assert.equal(after.json.revision, before.json.revision, '저장 실패인데 메모리가 앞서 나갔다');
    assert.equal(after.json.log.length, before.json.log.length);

    // 같은 id 재시도가 "이미 처리됨"으로 조용히 넘어가면 안 된다
    fs.rmdirSync(path.join(gameDir, 'ui-snapshot.json'));
    const retried = await publish(srv.port, token, { publishId: 2, events: [ev(1, 'action')] });
    assert.equal(retried.status, 200);
    const healed = await snapshot(srv.port, token);
    assert.equal(healed.json.revision, before.json.revision + 1);
    assert.equal(healed.json.log.length, before.json.log.length + 1);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('wait-action: 같은 decisionId로 다시 물으면 소비된 액션을 재전달한다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-2-turn-4';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'raise', amount: 300 });

    const first = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(first.json.action, 'raise');

    // 딜러가 그 응답을 못 받았다면 같은 결정으로 다시 물어야 한다
    const again = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(again.json.timeout, undefined, '액션이 사라져 게임이 멈춘다');
    assert.equal(again.json.action, 'raise');
    assert.equal(again.json.amount, 300);

    // 다음 결정으로 넘어가면 옛 액션은 더 이상 전달되지 않는다
    await publish(srv.port, token, { publishId: 2, view: viewWith('d-2-turn-5') });
    const next = await waitAction(srv.port, token, { expectDecisionId: 'd-2-turn-5', timeoutMs: 150 });
    assert.equal(next.json.timeout, true);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('publish: 이미 지나간 publishId는 다시 적용하지 않는다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    await publish(srv.port, token, { publishId: 1, events: [ev(0, 'hand_start')] });
    await publish(srv.port, token, { publishId: 2, coach: [{ handNo: 1, text: '코치' }] });
    const before = await snapshot(srv.port, token);

    // 응답이 유실된 1번 게시를 뒤늦게 재시도하는 상황
    const stale = await publish(srv.port, token, { publishId: 1, events: [ev(0, 'hand_start')] });
    assert.equal(stale.status, 200);
    const after = await snapshot(srv.port, token);
    assert.equal(after.json.revision, before.json.revision, '지나간 게시가 다시 반영됐다');
    assert.equal(after.json.log.length, before.json.log.length);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('wait-action: 뷰가 다시 게시되면 소비된 액션은 재전달되지 않는다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-5-flop-2';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'raise', amount: 10 });
    const first = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });
    assert.equal(first.json.action, 'raise');

    // 불법 액션이라 엔진이 거부 → 같은 결정을 안내와 함께 재게시 → 다시 대기.
    // 여기서 그 액션이 또 오면 딜러는 거부·재게시를 무한 반복한다.
    await publish(srv.port, token, {
      publishId: 2, view: viewWith(decisionId),
      messages: [{ type: 'narration', text: '그 액션은 지금 둘 수 없습니다.' }],
    });
    const again = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 150 });
    assert.equal(again.json.timeout, true, '거부된 액션이 즉시 되돌아와 무한 루프가 된다');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: schema v2 authority만 있어도 proofless update는 COACH_PROOF_REQUIRED', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  fs.writeFileSync(path.join(gameDir, '.coach-authority.json'), JSON.stringify({
    schemaVersion: 2, legacyMigrationCompleted: false, publishQueue: {}, publishedSeals: {},
  }));
  const srv = await start(gameDir, token);
  try {
    const r = await publish(srv.port, token, { publishId: 1, coach: [{ handNo: 1, text: '증명 없는 노트' }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'COACH_PROOF_REQUIRED');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: v2 활성 후 proofless update는 COACH_PROOF_REQUIRED', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  fs.writeFileSync(path.join(gameDir, '.coach-authority.json'), JSON.stringify({
    schemaVersion: 2, legacyMigrationCompleted: true, publishQueue: {}, publishedSeals: {},
  }));
  const srv = await start(gameDir, token);
  try {
    const r = await publish(srv.port, token, { publishId: 1, coach: [{ handNo: 1, text: '증명 없는 노트' }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'COACH_PROOF_REQUIRED');
    const snap = await snapshot(srv.port, token);
    assert.deepEqual(snap.json.coach, []);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: proof digest mismatch는 전체를 거부한다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const r = await publish(srv.port, token, {
      publishId: 1,
      coach: [{
        handNo: 1,
        text: '실제 텍스트',
        coachProof: { id: 'a'.repeat(64), payloadSha256: 'b'.repeat(64) },
      }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'COACH_PROOF_MISMATCH');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: sticky-overfold가 incoming tuple을 바꾸면 COACH_SEMANTIC_CONFLICT', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const { payloadSha256 } = await import('../publish-contract.js');
    const first = {
      handNo: 4,
      text: '과폴드 누수',
      overfold: true,
    };
    const firstProof = payloadSha256({ ...first, unavailable: false });
    await publish(srv.port, token, {
      publishId: 1,
      coach: [{ ...first, coachProof: { id: 'c'.repeat(64), payloadSha256: firstProof } }],
    });
    const secondTuple = { handNo: 4, text: '수정된 코멘트', overfold: false, unavailable: false };
    const secondProof = payloadSha256(secondTuple);
    const r = await publish(srv.port, token, {
      publishId: 2,
      coach: [{
        handNo: 4,
        text: '수정된 코멘트',
        coachProof: { id: 'd'.repeat(64), payloadSha256: secondProof },
      }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'COACH_SEMANTIC_CONFLICT');
    const snap = await snapshot(srv.port, token);
    assert.equal(snap.json.coach[0].text, '과폴드 누수');
    assert.equal(snap.json.coach[0].overfold, true);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('coach: 같은 handNo를 갱신해도 과폴드 표식은 지워지지 않는다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    await publish(srv.port, token, { publishId: 1, coach: [{ handNo: 4, text: '과폴드 누수', overfold: true }] });
    await publish(srv.port, token, { publishId: 2, coach: [{ handNo: 4, text: '수정된 코멘트' }] });
    const snap = await snapshot(srv.port, token);
    assert.equal(snap.json.coach.length, 1);
    assert.equal(snap.json.coach[0].text, '수정된 코멘트');
    assert.equal(snap.json.coach[0].overfold, true, '과폴드 사용 기록이 사라져 코멘트가 또 나간다');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('wait-action: view-only 재게시는 액션 처리 확인이 아니므로 재전달을 유지한다', async () => {
  const gameDir = tmpDir();
  const token = 'tok-test';
  const srv = await start(gameDir, token);
  try {
    const decisionId = 'd-6-river-1';
    await publish(srv.port, token, { publishId: 1, view: viewWith(decisionId) });
    await action(srv.port, token, { decisionId, action: 'call' });
    await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 500 });

    // 딜러가 죽고 resume이 view-only로 같은 상태를 재게시한 상황
    await publish(srv.port, token, { publishId: 2, view: viewWith(decisionId), viewOnly: true });
    const again = await waitAction(srv.port, token, { expectDecisionId: decisionId, timeoutMs: 300 });
    assert.equal(again.json.action, 'call', 'resume 재게시가 미확인 액션을 지웠다');
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('training-detail GET is token-first and digest-checked', async () => {
  const { createHash } = await import('node:crypto');
  const gameDir = tmpDir();
  const token = 'tok-detail';
  const { evaluationId, ref } = detailFixtureIds('d-1-preflop-0');
  const payload = { schemaVersion: 1, rangeMatrix: { cells: [] } };
  const raw = JSON.stringify(payload);
  const detailSha256 = createHash('sha256').update(raw).digest('hex');
  const summary = projectTrainingSummary({ evaluationId, detailRef: ref, detailSha256 });
  fs.mkdirSync(path.join(gameDir, 'training', 'details'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'training', 'details', `${ref}.json`), raw);
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), JSON.stringify({
    revision: 1,
    training: [summary],
  }));
  const srv = await start(gameDir, token);
  try {
    const denied = await req(srv.port, `/api/training-detail?ref=${ref}`);
    assert.equal(denied.status, 401);
    const ok = await req(srv.port, `/api/training-detail?ref=${ref}`, { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    fs.writeFileSync(path.join(gameDir, 'training', 'details', `${ref}.json`), '{"tampered":true}');
    const bad = await req(srv.port, `/api/training-detail?ref=${ref}`, { token });
    assert.equal(bad.status, 404);
  } finally {
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});

test('training-detail GET parent-swap is rejected', async () => {
  const { createHash } = await import('node:crypto');
  const gameDir = tmpDir();
  const token = 'tok-swap';
  const { evaluationId, ref } = detailFixtureIds('d-2-preflop-0');
  const payload = { schemaVersion: 1, rangeMatrix: { cells: [] } };
  const raw = JSON.stringify(payload);
  const detailSha256 = createHash('sha256').update(raw).digest('hex');
  const summary = projectTrainingSummary({ evaluationId, detailRef: ref, detailSha256 });
  const detailsDir = path.join(gameDir, 'training', 'details');
  fs.mkdirSync(detailsDir, { recursive: true });
  fs.writeFileSync(path.join(detailsDir, `${ref}.json`), raw);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-detail-outside-'));
  fs.writeFileSync(path.join(outside, `${ref}.json`), raw);
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), JSON.stringify({
    revision: 1,
    training: [summary],
  }));
  const srv = await start(gameDir, token);
  const origOpen = fs.openSync;
  let swapHookRan = false;
  fs.openSync = (p, flags, mode) => {
    if (String(p) === path.join(detailsDir, `${ref}.json`)) {
      swapHookRan = true;
      fs.openSync = origOpen;
      fs.renameSync(detailsDir, `${detailsDir}.real`);
      fs.symlinkSync(outside, detailsDir);
    }
    return origOpen(p, flags, mode);
  };
  try {
    const swapped = await req(srv.port, `/api/training-detail?ref=${ref}`, { token });
    assert.equal(swapped.status, 404);
    assert.equal(swapped.json?.ok, false);
    assert.equal(swapped.json?.code, 'NOT_FOUND');
    assert.equal(swapHookRan, true);
  } finally {
    fs.openSync = origOpen;
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('training-detail GET without a token performs 0 fs accesses', async () => {
  const { createHash } = await import('node:crypto');
  const gameDir = tmpDir();
  const token = 'tok-nofs';
  const { evaluationId, ref } = detailFixtureIds('d-3-preflop-0');
  const payload = { schemaVersion: 1, rangeMatrix: { cells: [] } };
  const raw = JSON.stringify(payload);
  const detailSha256 = createHash('sha256').update(raw).digest('hex');
  const summary = projectTrainingSummary({ evaluationId, detailRef: ref, detailSha256 });
  fs.mkdirSync(path.join(gameDir, 'training', 'details'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'training', 'details', `${ref}.json`), raw);
  fs.writeFileSync(path.join(gameDir, 'ui-snapshot.json'), JSON.stringify({
    revision: 1,
    training: [summary],
  }));
  const srv = await start(gameDir, token);
  const names = [
    'openSync', 'open', 'readFileSync', 'readFile', 'lstatSync', 'statSync',
    'fstatSync', 'existsSync', 'accessSync', 'readdirSync', 'realpathSync', 'readSync',
  ];
  const orig = {};
  const calls = [];
  for (const name of names) {
    orig[name] = fs[name];
    if (typeof fs[name] !== 'function') continue;
    fs[name] = (...args) => {
      calls.push({ name, path: typeof args[0] === 'string' ? args[0] : args[0] });
      return orig[name](...args);
    };
  }
  try {
    const denied = await req(srv.port, `/api/training-detail?ref=${ref}`);
    assert.equal(denied.status, 401);
    assert.equal(denied.json?.code, 'UNAUTHORIZED');
    assert.deepEqual(calls, []);
  } finally {
    for (const name of names) {
      if (orig[name] !== undefined) fs[name] = orig[name];
    }
    await closeOf(srv);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});
