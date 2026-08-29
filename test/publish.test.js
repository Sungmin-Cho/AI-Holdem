import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../server/server.js';
import { gameEpochOf } from '../publish-contract.js';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-pub-'));
}

const execFileAsync = promisify(execFile);

// The relay server runs in this process: a sync spawn would block its event loop and deadlock.
async function run(dir, args) {
  const { stdout } = await execFileAsync(process.execPath, [TOOL, ...args, '--game-dir', dir], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return JSON.parse(stdout.trim());
}

function turnFile(dir, envelope) {
  const file = path.join(dir, '.turn.json');
  fs.writeFileSync(file, JSON.stringify(envelope));
  return file;
}

function sampleTurn(overrides = {}) {
  return {
    ok: true,
    stateVersion: 3,
    events: [
      { seq: 0, visibility: 'public', type: 'hand_start', handNo: 1 },
      { seq: 1, visibility: 'actor:p1', type: 'deal_hole', playerId: 'p1', cards: ['As', 'Kd'] },
      { seq: 2, visibility: 'public', type: 'blinds_posted', sb: 25, bb: 50 },
    ],
    handOver: false,
    gameOver: false,
    view: { handNo: 1, toAct: 'p1', seats: [] },
    viewFor: 'user',
    next: {
      toAct: 'p1',
      kind: 'ai',
      decisionId: 'd-1-preflop-0',
      agentHandle: 'player-p1',
      summary: '요약 본문',
    },
    ...overrides,
  };
}

async function snapshotOf(port, token = 'tok') {
  const res = await fetch(`http://127.0.0.1:${port}/api/snapshot?token=${token}`);
  return res.json();
}

test('publish: actor:* 이벤트는 서버에 올라가지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    const snap = await snapshotOf(started.port);
    const types = snap.log.map((entry) => entry.type);
    assert.ok(types.includes('hand_start'));
    assert.ok(types.includes('blinds_posted'));
    assert.equal(types.includes('deal_hole'), false);
    assert.equal(JSON.stringify(snap).includes('As'), false);
  } finally {
    await started.close();
  }
});

test('publish: 요약은 UI로 새어 나가지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    const snap = await snapshotOf(started.port);
    assert.equal(JSON.stringify(snap).includes('요약 본문'), false);
  } finally {
    await started.close();
  }
});

test('publish: publishId를 스냅샷 기준으로 자동 증가시킨다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const first = await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    const second = await run(dir, ['--from', turnFile(dir, sampleTurn({ stateVersion: 4 }))]);
    assert.equal(second.publishId, first.publishId + 1);
    assert.equal(second.revision, first.revision + 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(persisted.publishId, second.publishId);
  } finally {
    await started.close();
  }
});

test('publish: 다음 행동자와 보낼 메시지를 stdout으로 돌려준다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    fs.writeFileSync(path.join(dir, 'reply-channel.txt'), 'SendMessage로 to:"main"에 보낸다.');
    const out = await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(out.next.agentHandle, 'player-p1');
    assert.equal(out.next.kind, 'ai');
    assert.ok(out.next.message.includes('요약 본문'));
    assert.ok(out.next.message.includes('SendMessage로 to:"main"에 보낸다.'));
    // 같은 본문을 두 번 돌려주면 딜러가 매 턴 두 배로 읽는다.
    assert.equal(out.next.summary, undefined);
  } finally {
    await started.close();
  }
});

test('publish: talk은 메시지로 게시된다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, sampleTurn()), '--talk', 'p2:좋은 패네요']);
    const snap = await snapshotOf(started.port);
    const talk = snap.log.find((entry) => entry.type === 'talk');
    assert.deepEqual(talk, { type: 'talk', playerId: 'p2', text: '좋은 패네요' });
  } finally {
    await started.close();
  }
});

test('publish --view-only: 이벤트 없이 뷰만 재게시한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    const before = (await snapshotOf(started.port)).log.length;
    await run(dir, ['--from', turnFile(dir, sampleTurn()), '--view-only']);
    const snap = await snapshotOf(started.port);
    assert.equal(snap.log.length, before);
    assert.equal(snap.view.handNo, 1);
  } finally {
    await started.close();
  }
});

async function runFailing(dir, args) {
  try {
    await execFileAsync(process.execPath, [TOOL, ...args, '--game-dir', dir], {
      encoding: 'utf8',
      timeout: 20000,
    });
  } catch (error) {
    return { code: error.code, json: JSON.parse(String(error.stdout ?? '').trim() || 'null') };
  }
  throw new Error('실패했어야 하는 호출이 성공했습니다');
}

async function deadPort() {
  const probe = await startServer({ gameDir: fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-probe-')), port: 0, token: 'x' });
  const port = probe.port;
  await probe.close();
  return port;
}

function writeLockJson(dir, port, token = 'tok') {
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port, sessionToken: token, startedAt: new Date().toISOString(),
  }));
}

test('publish: 게시에 실패해도 publish.lock을 남기지 않는다', async () => {
  const dir = tmpDir();
  writeLockJson(dir, await deadPort());
  const failed = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.code, 'PUBLISH_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'publish.lock.d')), false, '게시 락이 남았다');
});

test('publish: 죽은 보유자의 락은 회수하고, 살아 있는 보유자의 락은 뺏지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const lockDir = path.join(dir, 'publish.lock.d');

    // 죽은 pid → 회수하고 게시한다
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '2147480000');
    const reclaimed = await run(dir, ['--from', turnFile(dir, sampleTurn()), '--lock-wait-ms', '8000']);
    assert.equal(reclaimed.ok, true);
    assert.equal(fs.existsSync(lockDir), false, '자기 락을 정리하지 않았다');

    // 살아 있는 pid → 시간이 얼마나 지나든 뺏지 않는다
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    const refused = await runFailing(dir, ['--from', turnFile(dir, sampleTurn()), '--lock-wait-ms', '400']);
    assert.equal(refused.json.code, 'LOCK_TIMEOUT');
    assert.equal(fs.existsSync(lockDir), true, '남의 락을 지웠다');
    fs.rmSync(lockDir, { recursive: true });
  } finally {
    await started.close();
  }
});

test('publish: ok:false envelope는 게시하지 않고 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const rejected = { ok: false, code: 'VERSION_MISMATCH', message: 'stateVersion이 일치하지 않습니다.' };
    const failed = await runFailing(dir, ['--from', turnFile(dir, rejected)]);
    assert.equal(failed.json.code, 'BAD_ENVELOPE');
    assert.ok(failed.json.message.includes('VERSION_MISMATCH'), failed.json.message);
    assert.equal((await snapshotOf(started.port)).revision, 0, '거부된 envelope가 게시됐다');
  } finally {
    await started.close();
  }
});

test('publish: 빈 객체 envelope는 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const failed = await runFailing(dir, ['--from', turnFile(dir, {})]);
    assert.equal(failed.json.code, 'BAD_ENVELOPE');
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});

test('publish: 딜러가 다음 턴에 필요한 stateVersion·handNo를 돌려준다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const out = await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(out.stateVersion, 3);
    assert.equal(out.handNo, 1);
  } finally {
    await started.close();
  }
});

test('publish: 핸드 종료 제어 이벤트를 딜러에게 요약해 준다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const ended = sampleTurn({
      handOver: true,
      next: null,
      events: [
        { seq: 0, visibility: 'public', type: 'bust', playerId: 'p2' },
        { seq: 1, visibility: 'public', type: 'level_up', level: 1, sb: 50, bb: 100 },
        { seq: 2, visibility: 'actor:p1', type: 'deal_hole', playerId: 'p1', cards: ['As', 'Kd'] },
      ],
    });
    const out = await run(dir, ['--from', turnFile(dir, ended)]);
    assert.deepEqual(out.control.bust, ['p2']);
    assert.deepEqual(out.control.level_up, { level: 1, sb: 50, bb: 100 });
    assert.equal(JSON.stringify(out).includes('As'), false, '제어 요약에 홀카드가 섞였다');
  } finally {
    await started.close();
  }
});

test('publish --view-only: 이벤트는 빼되 안내 메시지는 싣는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    const before = (await snapshotOf(started.port)).log.length;
    await run(dir, ['--from', turnFile(dir, sampleTurn()), '--view-only', '--narration', '그 액션은 지금 둘 수 없습니다.']);
    const log = (await snapshotOf(started.port)).log;
    assert.equal(log.length, before + 1);
    assert.deepEqual(log.at(-1), { type: 'narration', text: '그 액션은 지금 둘 수 없습니다.' });
  } finally {
    await started.close();
  }
});

test('publish --talk-from: 따옴표가 든 한마디도 셸을 거치지 않고 게시된다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const talkFile = path.join(dir, '.talk.json');
    const text = `'; rm -rf ~ ;' "그래도" 콜`;
    fs.writeFileSync(talkFile, JSON.stringify({ playerId: 'p3', text }));
    await run(dir, ['--from', turnFile(dir, sampleTurn()), '--talk-from', talkFile]);
    const talk = (await snapshotOf(started.port)).log.find((entry) => entry.type === 'talk');
    assert.deepEqual(talk, { type: 'talk', playerId: 'p3', text });
  } finally {
    await started.close();
  }
});

test('publish: view는 있는데 사용자 관점 표식이 없으면 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const unmarked = { ok: true, events: [], view: { handNo: 1, myCards: ['As', 'Kd'] } };
    const failed = await runFailing(dir, ['--from', turnFile(dir, unmarked)]);
    assert.equal(failed.json.code, 'BAD_ENVELOPE');
    const snap = await snapshotOf(started.port);
    assert.equal(snap.revision, 0);
    assert.equal(JSON.stringify(snap).includes('As'), false);
  } finally {
    await started.close();
  }
});

test('publish: 게시에 성공한 뒤 대기만 실패하면 게시 결과를 잃지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  const envelope = turnFile(dir, {
    ...sampleTurn(),
    view: { handNo: 1, toAct: 'user', legal: { decisionId: 'd-1-preflop-2' } },
    viewFor: 'user',
    next: { toAct: 'user', kind: 'user', decisionId: 'd-1-preflop-2' },
  });
  // 게시는 성공하고 그 직후 서버가 사라지는 상황
  const pending = execFileAsync(process.execPath, [
    TOOL, '--from', envelope, '--game-dir', dir, '--wait', '--wait-ms', '3000',
  ], { encoding: 'utf8', timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await started.close();
  const { stdout } = await pending;
  const out = JSON.parse(stdout.trim());

  assert.equal(out.ok, true, '게시는 성공했는데 전체를 실패로 돌렸다');
  assert.equal(out.publishId, 1);
  assert.equal(out.stateVersion, 3);
  assert.ok(out.waitError, '대기 실패가 표시되지 않았다');
  assert.equal(out.userAction, undefined);
});

test('publish: 아카이브 미기록 경고를 딜러에게 전달한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const pending = sampleTurn({ handOver: true, next: null, archivePending: true });
    const out = await run(dir, ['--from', turnFile(dir, pending)]);
    assert.equal(out.archivePending, true);
  } finally {
    await started.close();
  }
});

test('publish: 죽은 락을 두 게시자가 동시에 회수해도 둘 다 남는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    // 게시 도중 급사해 남은 락: 디렉터리 + 죽은 pid
    const lockDir = path.join(dir, 'publish.lock.d');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '2147480000');

    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    fs.writeFileSync(a, JSON.stringify(sampleTurn()));
    fs.writeFileSync(b, JSON.stringify({ ...sampleTurn(), coach: [{ handNo: 1, text: '코치 노트' }] }));

    // 회수 경쟁은 타이밍 창이 좁다 — 여러 라운드로 확률을 올린다.
    for (let round = 0; round < 5; round += 1) {
      if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'pid'), '2147480000');
      }
      const results = await Promise.all([
        run(dir, ['--from', a, '--lock-wait-ms', '15000']),
        run(dir, ['--from', b, '--lock-wait-ms', '15000']),
      ]);
      for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(fs.existsSync(lockDir), false, '락이 남았다');
    }

    const snap = await snapshotOf(started.port);
    assert.equal(snap.revision, 10, '회수 경쟁에서 게시가 유실됐다');
    assert.equal(snap.coach.length, 1, '코치는 handNo로 갱신되어야 한다');
  } finally {
    await started.close();
  }
});

test('publish: 실패 메시지에 세션 토큰이 들어가지 않는다', async () => {
  const dir = tmpDir();
  // 유효하지만 죽은 포트여야 readLock을 통과해 실제 fetch 실패 경로를 탄다.
  writeLockJson(dir, await deadPort(), 'SECRET_SENTINEL_TOKEN');
  const failed = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
  assert.equal(failed.json.code, 'PUBLISH_FAILED', '의도한 실패 경로가 아니다');
  assert.equal(JSON.stringify(failed.json).includes('SECRET_SENTINEL_TOKEN'), false, '토큰이 출력에 실렸다');
});

test('publish: lock.json이 객체가 아니면 NO_LOCK으로 거부한다', async () => {
  const dir = tmpDir();
  for (const bad of ['null', '"문자열"', '[]', '{"port":0,"sessionToken":"t"}']) {
    fs.writeFileSync(path.join(dir, 'lock.json'), bad);
    const failed = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(failed.json.code, 'NO_LOCK', `${bad} → ${failed.json.code}`);
  }
});

test('publish --retry: 실패한 게시를 같은 publishId로 다시 보내 중복도 유실도 없게 한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const file = turnFile(dir, sampleTurn());
    const first = await run(dir, ['--from', file]);

    // 서버는 처리했는데 응답이 딜러에 닿지 않은 상황: 시도 기록이 남아 있다.
    const body = { publishId: first.publishId, view: sampleTurn().view, events: [{ seq: 0, visibility: 'public', type: 'hand_start', handNo: 1 }] };
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body,
      expectedGameEpoch: gameEpochOf('tok'),
    }));
    const retried = await run(dir, ['--from', file, '--retry']);
    const snap = await snapshotOf(started.port);
    assert.equal(retried.publishId, 1, '재시도가 새 id를 썼다');
    assert.equal(snap.revision, 1, '같은 게시가 두 번 반영됐다');
    assert.equal(snap.log.filter((entry) => entry.type === 'hand_start').length, 1, '이벤트가 중복됐다');
  } finally {
    await started.close();
  }
});

test('publish --retry: 서버에 닿지 못했던 게시는 재시도로 이벤트까지 살아난다', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: await deadPort(), sessionToken: 'tok',
  }));
  const file = turnFile(dir, sampleTurn());
  await runFailing(dir, ['--from', file]);

  // 같은 포트로 서버를 올리고 재시도하면 원래 이벤트가 그대로 실려야 한다.
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));
  const started = await startServer({ gameDir: dir, port: lock.port, token: 'tok' });
  try {
    await run(dir, ['--from', file, '--retry']);
    const snap = await snapshotOf(started.port);
    assert.equal(snap.log.filter((entry) => entry.type === 'hand_start').length, 1, '이벤트가 유실됐다');
    assert.equal(snap.log.some((entry) => entry.type === 'deal_hole'), false);
  } finally {
    await started.close();
  }
});

function userTurn() {
  return sampleTurn({
    view: { handNo: 1, toAct: 'user', legal: { decisionId: 'd-1-preflop-2' } },
    viewFor: 'user',
    next: { toAct: 'user', kind: 'user', decisionId: 'd-1-preflop-2' },
  });
}

async function waitForPublishedDecision(port, decisionId) {
  for (let i = 0; i < 100; i += 1) {
    const snap = await snapshotOf(port);
    if (snap.view?.legal?.decisionId === decisionId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('뷰가 게시되지 않았습니다');
}

test('publish --wait: 사용자 차례면 게시와 액션 수신을 한 호출에서 끝낸다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const pending = run(dir, ['--from', turnFile(dir, userTurn()), '--wait', '--wait-ms', '5000']);
    await waitForPublishedDecision(started.port, 'd-1-preflop-2');
    await fetch(`http://127.0.0.1:${started.port}/api/action?token=tok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId: 'd-1-preflop-2', action: 'raise', amount: 300 }),
    });
    const out = await pending;
    assert.deepEqual(out.userAction, { decisionId: 'd-1-preflop-2', action: 'raise', amount: 300 });
  } finally {
    await started.close();
  }
});

test('publish --wait: 사용자가 조용하면 timeout으로 돌아온다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const out = await run(dir, ['--from', turnFile(dir, userTurn()), '--wait', '--wait-ms', '150']);
    assert.deepEqual(out.userAction, { timeout: true });
  } finally {
    await started.close();
  }
});

test('publish --wait-only: 재게시 없이 대기만 한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    await run(dir, ['--from', turnFile(dir, userTurn())]);
    const before = await snapshotOf(started.port);
    const out = await run(dir, ['--from', turnFile(dir, userTurn()), '--wait-only', '--wait-ms', '150']);
    const after = await snapshotOf(started.port);
    assert.equal(after.revision, before.revision);
    assert.equal(after.log.length, before.log.length);
    assert.deepEqual(out.userAction, { timeout: true });
    assert.equal(out.publishId, undefined);
  } finally {
    await started.close();
  }
});

test('publish --wait: AI 차례에는 기다리지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const out = await run(dir, ['--from', turnFile(dir, sampleTurn()), '--wait', '--wait-ms', '9000']);
    assert.equal(out.userAction, undefined);
    assert.equal(out.next.kind, 'ai');
  } finally {
    await started.close();
  }
});

test('publish: 동시 실행에서도 두 게시가 모두 남는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    fs.writeFileSync(a, JSON.stringify(sampleTurn()));
    fs.writeFileSync(b, JSON.stringify({ ...sampleTurn(), coach: [{ handNo: 1, text: '코치 노트' }] }));
    await Promise.all([run(dir, ['--from', a]), run(dir, ['--from', b])]);
    const snap = await snapshotOf(started.port);
    assert.equal(snap.revision, 2);
    assert.equal(snap.coach.length, 1);
  } finally {
    await started.close();
  }
});

test('publish: 미해소 재시도 기록이 있으면 새 게시를 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    // 턴 게시 A가 실패해 기록이 남은 상태
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body: { publishId: 1, view: { handNo: 1 }, events: [{ seq: 0, visibility: 'public', type: 'hand_start', handNo: 1 }] },
      expectedGameEpoch: gameEpochOf('tok'),
    }));
    // 백그라운드 코치가 그 기록을 덮어쓰면 A의 --retry가 남의 본문을 보내게 된다
    const coach = path.join(dir, 'coach.json');
    fs.writeFileSync(coach, JSON.stringify({ coach: [{ handNo: 1, text: '코치' }] }));
    const blocked = await runFailing(dir, ['--from', coach]);
    assert.equal(blocked.json.code, 'ATTEMPT_PENDING');
    const kept = JSON.parse(fs.readFileSync(path.join(dir, '.publish-attempt.json'), 'utf8'));
    assert.equal(kept.body.publishId, 1, '남의 게시가 기록을 덮어썼다');
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});

test('publish: step envelope인 척하는 빈 게시는 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    for (const bad of [{ events: [] }, { ok: true, events: [] }, { ok: true, next: null }]) {
      const failed = await runFailing(dir, ['--from', turnFile(dir, bad)]);
      assert.equal(failed.json.code, 'BAD_ENVELOPE', JSON.stringify(bad));
    }
    assert.equal((await snapshotOf(started.port)).revision, 0, '거부됐는데 publishId를 소비했다');
  } finally {
    await started.close();
  }
});

test('publish: 재시도 기록이 깨졌으면 새 게시를 만들지 않고 BAD_ATTEMPT로 멈춘다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    for (const bad of ['{}', '{"body":null}', '{"body":{}}', '{"body":{"publishId":"1"}}']) {
      fs.writeFileSync(path.join(dir, '.publish-attempt.json'), bad);
      const failed = await runFailing(dir, ['--from', turnFile(dir, sampleTurn()), '--retry']);
      assert.equal(failed.json.code, 'BAD_ATTEMPT_VERSION', bad);
    }
    const epoch = gameEpochOf('tok');
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      expectedGameEpoch: epoch,
      body: { publishId: '1' },
    }));
    const badBody = await runFailing(dir, ['--from', turnFile(dir, sampleTurn()), '--retry']);
    assert.equal(badBody.json.code, 'BAD_ATTEMPT');
    assert.equal((await snapshotOf(started.port)).revision, 0, '깨진 기록으로 게시가 나갔다');
  } finally {
    await started.close();
  }
});

test('publish --print-game-epoch: sessionToken 해시만 출력한다', async () => {
  const dir = tmpDir();
  writeLockJson(dir, 8877, 'tok-epoch');
  const out = await run(dir, ['--print-game-epoch']);
  assert.equal(out.ok, true);
  assert.equal(out.gameEpoch, gameEpochOf('tok-epoch'));
  assert.equal(JSON.stringify(out).includes('tok-epoch'), false);
});

test('publish: unsupported schema는 HTTP/attempt/publishId 전에 fail closed', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    fs.writeFileSync(path.join(dir, '.coach-authority.json'), JSON.stringify({ schemaVersion: 1 }));
    const failed = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(failed.json.code, 'UNSUPPORTED_COACH_AUTHORITY');
    assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});

test('publish: old-epoch attempt는 send 없이 지우고 새 게시를 막지 않는다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body: { publishId: 99, view: { handNo: 9 } },
      expectedGameEpoch: '0'.repeat(64),
    }));
    const out = await run(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(out.ok, true);
    assert.equal(out.publishId, 1);
    assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
  } finally {
    await started.close();
  }
});

test('publish: coachAuthority exact match는 게시 후 reconcile로 tombstone이 된다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const { createCoachControl } = await import('../tools/coach-control.js');
    const cc = createCoachControl();
    const snapshotFile = path.join(dir, 'ui-snapshot.json');
    const statsFile = path.join(dir, 'stats.json');
    fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
    if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify({ coach: [] }));
    const owner = '11111111-1111-4111-8111-111111111111';
    const begun = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    fs.writeFileSync(begun.descriptors[0].exactResultPath, JSON.stringify({
      handNo: 1, text: '무난한 폴드입니다.',
    }));
    const accepted = await cc.accept({
      gameDir: dir, owner, handNo: 1, generation: begun.descriptors[0].generation,
    });
    assert.equal(accepted.ok, true);
    const envelope = cc.loadAuthority(dir).publishQueue['1'].exactEnvelopePath;
    const out = await run(dir, ['--from', envelope]);
    assert.equal(out.ok, true);
    const snap = await snapshotOf(started.port);
    assert.equal(snap.coach[0].text, '무난한 폴드입니다.');
    assert.ok(snap.coach[0].coachProof);
    const auth = cc.loadAuthority(dir);
    assert.equal(auth.publishQueue['1'], undefined);
    assert.ok(auth.publishedSeals['1']);
  } finally {
    await started.close();
  }
});

test('publish --retry: matching authority라도 변조된 coach body는 STALE_COACH_AUTHORITY', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const { createCoachControl } = await import('../tools/coach-control.js');
    const { payloadSha256, publicProofId } = await import('../publish-contract.js');
    const cc = createCoachControl();
    const snapshotFile = path.join(dir, 'ui-snapshot.json');
    const statsFile = path.join(dir, 'stats.json');
    fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
    if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify({ coach: [] }));
    const owner = '11111111-1111-4111-8111-111111111111';
    const begun = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    fs.writeFileSync(begun.descriptors[0].exactResultPath, JSON.stringify({
      handNo: 1, text: '원문 노트',
    }));
    await cc.accept({
      gameDir: dir, owner, handNo: 1, generation: begun.descriptors[0].generation,
    });
    const queued = cc.loadAuthority(dir).publishQueue['1'];
    const fakeTuple = { handNo: 1, text: '변조', overfold: false, unavailable: false };
    const fakeDigest = payloadSha256(fakeTuple);
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body: {
        publishId: 1,
        coach: [{
          handNo: 1,
          text: '변조',
          coachProof: { id: publicProofId(queued.queueId), payloadSha256: fakeDigest },
        }],
      },
      expectedGameEpoch: gameEpochOf('tok'),
      coachAuthority: {
        expectedGameEpoch: gameEpochOf('tok'),
        queueId: queued.queueId,
        handNo: 1,
        generation: queued.generation,
        exactEnvelopePath: queued.exactEnvelopePath,
        payloadSha256: queued.payloadSha256,
      },
    }));
    const failed = await runFailing(dir, ['--from', queued.exactEnvelopePath, '--retry']);
    assert.equal(failed.json.code, 'STALE_COACH_AUTHORITY');
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});

test('publish: matching coach attempt는 다른 hand 게시에도 ATTEMPT_PENDING', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const { createCoachControl } = await import('../tools/coach-control.js');
    const cc = createCoachControl();
    const snapshotFile = path.join(dir, 'ui-snapshot.json');
    const statsFile = path.join(dir, 'stats.json');
    fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
    if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify({ coach: [] }));
    const owner = '11111111-1111-4111-8111-111111111111';
    const begun = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    fs.writeFileSync(begun.descriptors[0].exactResultPath, JSON.stringify({
      handNo: 1, text: '대기 중 코치',
    }));
    await cc.accept({
      gameDir: dir, owner, handNo: 1, generation: begun.descriptors[0].generation,
    });
    const queued = cc.loadAuthority(dir).publishQueue['1'];
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body: { publishId: 3, coach: [{ handNo: 1, text: '대기 중 코치' }] },
      expectedGameEpoch: gameEpochOf('tok'),
      coachAuthority: {
        expectedGameEpoch: gameEpochOf('tok'),
        queueId: queued.queueId,
        handNo: 1,
        generation: queued.generation,
        exactEnvelopePath: queued.exactEnvelopePath,
        payloadSha256: queued.payloadSha256,
      },
    }));
    const blocked = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(blocked.json.code, 'ATTEMPT_PENDING');
    const kept = JSON.parse(fs.readFileSync(path.join(dir, '.publish-attempt.json'), 'utf8'));
    assert.equal(kept.coachAuthority.queueId, queued.queueId);
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});

test('publish: queue digest mismatch coach attempt는 STALE_COACH_AUTHORITY이고 publishId를 안 쓴다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const envelope = path.join(dir, 'coach-env.json');
    fs.writeFileSync(envelope, JSON.stringify({
      coach: [{ handNo: 1, text: 'x' }],
      coachAuthority: {
        expectedGameEpoch: gameEpochOf('tok'),
        queueId: 'missing',
        handNo: 1,
        generation: 1,
        exactEnvelopePath: envelope,
        payloadSha256: 'a'.repeat(64),
      },
    }));
    fs.writeFileSync(path.join(dir, '.coach-authority.json'), JSON.stringify({
      schemaVersion: 2,
      gameEpoch: gameEpochOf('tok'),
      publishQueue: {},
      publishedSeals: {},
    }));
    const failed = await runFailing(dir, ['--from', envelope]);
    assert.equal(failed.json.code, 'STALE_COACH_AUTHORITY');
    assert.equal((await snapshotOf(started.port)).revision, 0);
    assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
  } finally {
    await started.close();
  }
});

test('publish: cutoff 이후 review와 view-only는 되고 새 turn은 막힌다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const { createCoachControl } = await import('../tools/coach-control.js');
    const cc = createCoachControl();
    const snapshotFile = path.join(dir, 'ui-snapshot.json');
    const statsFile = path.join(dir, 'stats.json');
    fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
    if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify({ coach: [] }));
    const owner = '11111111-1111-4111-8111-111111111111';
    await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    const host = {
      stopNewPlayTimePublishers() {},
      listLivePublishers() { return []; },
      async terminateLive() { return { confirmed: true }; },
      hasLiveLockHolder() { return false; },
    };
    const cut = await cc.finalizeCutoff({
      gameDir: dir, owner, completed: 1, snapshotFile, statsFile, host,
    });
    assert.equal(cut.ok, true, JSON.stringify(cut));
    const review = path.join(dir, 'review.json');
    fs.writeFileSync(review, JSON.stringify({ review: '# 리뷰' }));
    const reviewed = await run(dir, ['--from', review]);
    assert.equal(reviewed.ok, true);
    const viewOnly = await run(dir, ['--from', turnFile(dir, sampleTurn()), '--view-only']);
    assert.equal(viewOnly.ok, true);
    const blocked = await runFailing(dir, ['--from', turnFile(dir, sampleTurn())]);
    assert.equal(blocked.json.code, 'PLAYTIME_PUBLISH_STOPPED');
  } finally {
    await started.close();
  }
});

test('publish: 만료된 --deadline-monotonic-ns는 전송 없이 DEADLINE_EXPIRED', async () => {
  const dir = tmpDir();
  writeLockJson(dir, await deadPort());
  const failed = await runFailing(dir, [
    '--from', turnFile(dir, sampleTurn()),
    '--deadline-monotonic-ns', '1',
  ]);
  assert.equal(failed.json.code, 'DEADLINE_EXPIRED');
  assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false);
});

test('publish --retry: .turn.json이 거부 envelope여도 기록된 본문으로 해소된다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    fs.writeFileSync(path.join(dir, '.publish-attempt.json'), JSON.stringify({
      body: { publishId: 1, view: { handNo: 1 }, events: [{ seq: 0, visibility: 'public', type: 'hand_start', handNo: 1 }] },
      expectedGameEpoch: gameEpochOf('tok'),
    }));
    // step이 거부되며 .turn.json을 에러 envelope로 덮어쓴 상태
    const rejected = turnFile(dir, { ok: false, code: 'VERSION_MISMATCH', message: '…' });
    const out = await run(dir, ['--from', rejected, '--retry']);
    assert.equal(out.publishId, 1);
    assert.equal((await snapshotOf(started.port)).log.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '.publish-attempt.json')), false, '기록이 해소되지 않았다');
  } finally {
    await started.close();
  }
});

test('publish: 속이 빈 step envelope는 거부한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const partials = [
      { ok: true, view: {}, viewFor: 'user' },
      { ok: true, view: { handNo: 1 }, viewFor: 'user', stateVersion: '3' },
      { ok: true, view: { handNo: 1 }, viewFor: 'user', stateVersion: 3, handOver: 'no' },
    ];
    for (const bad of partials) {
      const failed = await runFailing(dir, ['--from', turnFile(dir, bad)]);
      assert.equal(failed.json.code, 'BAD_ENVELOPE', JSON.stringify(bad));
    }
    assert.equal((await snapshotOf(started.port)).revision, 0);
  } finally {
    await started.close();
  }
});
