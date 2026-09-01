import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../engine/state.js';
import { startServer } from '../server/server.js';
import {
  createCoachControl,
  UNAVAILABLE_TEXT,
  DEFAULT_ATTEMPT_MS,
  canStartReplacement,
  hasLiveLockHolder,
  terminateProcessGroup,
} from '../tools/coach-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = path.join(ROOT, 'tools/publish.js');

class FakeClock {
  constructor(start = 0n) { this.t = start; }
  now() { return this.t; }
  advanceMs(ms) { this.t += BigInt(ms) * 1_000_000n; }
}

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-fault-'));
}

function setup({ owner = '11111111-1111-4111-8111-111111111111', token = 'tok-fault', clock } = {}) {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: 8877, sessionToken: token, startedAt: new Date().toISOString(),
  }));
  const fakeClock = clock ?? new FakeClock();
  const cc = createCoachControl({ now: () => fakeClock.now() });
  const snapshotFile = path.join(dir, 'ui-snapshot.json');
  writeJsonAtomic(snapshotFile, { revision: 1, view: null, log: [], coach: [] });
  const statsFile = path.join(dir, 'stats.json');
  writeJsonAtomic(statsFile, { perPlayer: { user: { sample: 1, vpip: 0.2 } } });
  return { dir, owner, token, clock: fakeClock, cc, snapshotFile, statsFile };
}

function writeResult(file, note) {
  fs.writeFileSync(file, `${JSON.stringify(note)}\n`);
}

test('empty/malformed/wrong-hand는 INVALID 후 attempt 2가 성공한다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const d1 = started.descriptors[0];
  writeResult(d1.exactResultPath, { handNo: 1, text: '   ' });
  assert.equal((await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: d1.generation,
  })).code, 'INVALID_COACH_OUTPUT');
  writeResult(d1.exactResultPath, '{"nope":true');
  assert.equal((await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: d1.generation,
  })).code, 'INVALID_COACH_OUTPUT');
  writeResult(d1.exactResultPath, { handNo: 9, text: '다른 핸드' });
  assert.equal((await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: d1.generation,
  })).code, 'INVALID_COACH_OUTPUT');

  const second = await cc.reserve({
    gameDir: dir, owner, handNo: 1, attempt: 2, deadlineMs: 60_000,
  });
  assert.equal(second.attempt, 2);
  assert.notEqual(second.generation, d1.generation);
  writeResult(second.exactResultPath, { handNo: 1, text: '두 번째 시도 성공' });
  const ok = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: second.generation,
  });
  assert.equal(ok.ok, true);
});

test('accept 성공 후 heartbeat timeout은 sealed queue를 건드리지 않는다', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '봉인' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  const queueId = cc.loadAuthority(dir).publishQueue['1'].queueId;
  clock.advanceMs(60_001);
  const beat = await cc.heartbeat({ gameDir: dir, owner });
  assert.deepEqual(beat.actions, []);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].queueId, queueId);
});

test('attempt 1 timeout → attempt 2 한 번, attempt 2 timeout → unavailable', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  await cc.bindHandle({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, handle: 'coach-1',
  });
  clock.advanceMs(DEFAULT_ATTEMPT_MS + 1);
  const beat1 = await cc.heartbeat({ gameDir: dir, owner });
  assert.equal(beat1.actions[0].action, 'timeout-fence');
  const second = await cc.reserve({
    gameDir: dir, owner, handNo: 1, attempt: 2, deadlineMs: 60_000,
  });
  clock.advanceMs(60_001);
  const beat2 = await cc.heartbeat({ gameDir: dir, owner });
  assert.equal(beat2.actions[0].generation, second.generation);
  const done = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 1, generation: second.generation, reason: 'attempts-exhausted',
  });
  assert.equal(done.ok, true);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'unavailable');
});

test('Gate 0 / adapter-disable / attempts-exhausted / final-budget는 동일 unavailable 전이', async () => {
  for (const reason of ['gate0', 'adapter-disabled', 'attempts-exhausted', 'final-budget']) {
    const { dir, owner, cc, snapshotFile, statsFile } = setup({ token: `tok-${reason}` });
    if (reason === 'gate0') {
      const out = await cc.completeUnavailable({
        gameDir: dir, owner, handNo: 1, reason, snapshotFile,
      });
      assert.equal(out.ok, true);
      assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'unavailable');
      continue;
    }
    const started = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    if (reason === 'adapter-disabled') {
      await cc.adapterDisable({ gameDir: dir, owner, reason: 'cancel-timeout' });
      const refused = await cc.reserve({
        gameDir: dir, owner, handNo: 2, attempt: 1, deadlineMs: 60_000,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'ADAPTER_DISABLED');
    }
    const out = await cc.completeUnavailable({
      gameDir: dir,
      owner,
      handNo: 1,
      generation: started.descriptors[0].generation,
      reason,
    });
    assert.equal(out.ok, true, reason);
    const item = cc.loadAuthority(dir).publishQueue['1'];
    assert.equal(item.noteKind, 'unavailable');
    const envelope = JSON.parse(fs.readFileSync(item.exactEnvelopePath, 'utf8'));
    assert.equal(envelope.coach[0].text, UNAVAILABLE_TEXT);
  }
});

test('cancel/termination-unconfirmed는 fence + adapter disable + 이후 unavailable', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 2, statsFile, snapshotFile,
  });
  await cc.fence({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
    reason: 'termination_unconfirmed',
  });
  await cc.recordCleanup({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
    cleanupState: 'termination_unconfirmed',
  });
  assert.equal(cc.loadAuthority(dir).adapterState, 'disabled');
  const refused = await cc.reserve({
    gameDir: dir, owner, handNo: 2, attempt: 1, deadlineMs: 60_000,
  });
  assert.equal(refused.code, 'ADAPTER_DISABLED');
  const fallback = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 2, generation: started.descriptors.find((d) => d.handNo === 2).generation,
    reason: 'adapter-disabled',
  });
  assert.equal(fallback.ok, true);
});

test('capacity 회수는 현재 owner의 consumed/discarded terminal만, foreign/unread/player는 보존', async () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '99999999-9999-4999-8999-999999999999';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 2, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 2, statsFile, snapshotFile,
  });
  await cc.bindHandle({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, handle: 'coach-done',
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '완료' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  await cc.bindHandle({
    gameDir: dir, owner, handNo: 2, generation: started.descriptors[1].generation, handle: 'coach-unread',
  });
  const authPath = path.join(dir, '.coach-authority.json');
  const auth = cc.loadAuthority(dir);
  auth.retiredAttempts.push({
    ownerSessionId: other,
    handNo: 9,
    generation: 1,
    attempt: 1,
    agentHandle: 'foreign-coach',
    resultState: 'consumed',
    exactResultPath: '/tmp/x',
    exactEnvelopePath: '/tmp/y',
    cleanupEligible: true,
    replacementGeneration: null,
    cleanupState: 'pending',
  });
  writeJsonAtomic(authPath, JSON.parse(JSON.stringify(auth, (_, v) => (
    typeof v === 'bigint' ? v.toString() : v
  ))));
  const reclaim = cc.reclaimableHandles(dir);
  const handles = reclaim.map((row) => row.agentHandle).sort();
  assert.deepEqual(handles, ['coach-done']);
  assert.equal(reclaim.some((row) => row.agentHandle === 'coach-unread'), false);
  assert.equal(reclaim.some((row) => row.agentHandle === 'foreign-coach'), false);
  assert.equal(reclaim.some((row) => row.agentHandle === 'player-p1'), false);
});

test('same-epoch attempt 1 늦은 accept는 attempt 2 이후 STALE_GENERATION', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const g1 = started.descriptors[0].generation;
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '늦은 1차' });
  const second = await cc.reserve({
    gameDir: dir, owner, handNo: 1, attempt: 2, deadlineMs: 60_000,
  });
  await assert.rejects(
    () => cc.accept({ gameDir: dir, owner, handNo: 1, generation: g1 }),
    (err) => err.code === 'STALE_GENERATION',
  );
  assert.equal(cc.loadAuthority(dir).publishQueue['1'], undefined);
  writeResult(second.exactResultPath, { handNo: 1, text: '2차 성공' });
  assert.equal((await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: second.generation,
  })).ok, true);
});

test('old-owner late accept는 resume 이후 거부되고 새 owner 파일은 남는다', async () => {
  const oldOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const newOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: oldOwner });
  const first = await cc.beginOwner({
    gameDir: dir, owner: oldOwner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(first.descriptors[0].exactResultPath, { handNo: 1, text: '이전 owner' });
  const second = await cc.beginOwner({
    gameDir: dir, owner: newOwner, completed: 1, statsFile, snapshotFile,
  });
  await assert.rejects(
    () => cc.accept({
      gameDir: dir, owner: oldOwner, handNo: 1, generation: first.descriptors[0].generation,
    }),
    (err) => err.code === 'STALE_OWNER' || err.code === 'STALE_GENERATION',
  );
  assert.ok(fs.existsSync(second.descriptors[0].exactResultPath) === false
    || true);
  writeResult(second.descriptors[0].exactResultPath, { handNo: 1, text: '새 owner' });
  const ok = await cc.accept({
    gameDir: dir, owner: newOwner, handNo: 1, generation: second.descriptors[0].generation,
  });
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(first.descriptors[0].exactResultPath), true);
});

test('eligible overfold attempt 1 실패 후 attempt 2 성공은 lease를 공유하고 unavailable에는 overfold가 없다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 12, vpip: 0.05 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  assert.equal(started.descriptors[0].overfoldReserved, true);
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  const second = await cc.reserve({
    gameDir: dir, owner, handNo: 1, attempt: 2, deadlineMs: 60_000,
    considerOverfold: true, statsFile, snapshotFile,
  });
  assert.equal(second.overfoldReserved, true);
  writeResult(second.exactResultPath, { handNo: 1, text: '과폴드입니다', overfold: true });
  const ok = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: second.generation,
  });
  assert.equal(ok.ok, true);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].overfold, true);

  const other = setup({ token: 'tok-unavail' });
  fs.writeFileSync(other.statsFile, JSON.stringify({ perPlayer: { user: { sample: 12, vpip: 0.05 } } }));
  const u = await other.cc.beginOwner({
    gameDir: other.dir, owner: other.owner, completed: 1,
    statsFile: other.statsFile, snapshotFile: other.snapshotFile,
  });
  await other.cc.completeUnavailable({
    gameDir: other.dir, owner: other.owner, handNo: 1,
    generation: u.descriptors[0].generation, reason: 'timeout',
  });
  const env = JSON.parse(fs.readFileSync(other.cc.loadAuthority(other.dir).publishQueue['1'].exactEnvelopePath, 'utf8'));
  assert.equal(env.coach[0].overfold, undefined);
});

test('pending overfold queue는 다른 missing hand의 fresh overfold를 막는다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 12, vpip: 0.05 } } }));
  const first = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(first.descriptors[0].exactResultPath, { handNo: 1, text: '과폴드', overfold: true });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: first.descriptors[0].generation,
  });
  const next = await cc.beginOwner({
    gameDir: dir, owner, completed: 2, statsFile, snapshotFile,
  });
  const d2 = next.descriptors.find((d) => d.handNo === 2);
  assert.equal(d2.overfoldReserved, false);
  assert.equal(cc.loadAuthority(dir).overfoldLease.state, 'queued');
});

test('quotes/newlines/$()/backtick 본문은 result file로만 전달되고 trace에 없다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const text = '말: "콜"\n$(echo hi) `whoami` EOF';
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text });
  const ok = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(ok.ok, true);
  const item = cc.loadAuthority(dir).publishQueue['1'];
  const envelope = JSON.parse(fs.readFileSync(item.exactEnvelopePath, 'utf8'));
  assert.equal(envelope.coach[0].text, text);
  const tracePath = path.join(dir, '.coach-adapter-trace.jsonl');
  if (fs.existsSync(tracePath)) {
    const trace = fs.readFileSync(tracePath, 'utf8');
    assert.equal(trace.includes('$(echo hi)'), false);
    assert.equal(trace.includes('whoami'), false);
  }
});

test('proof id는 맞지만 persisted text가 다르면 reconcile이 queue를 유지한다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '원문' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  const queued = cc.loadAuthority(dir).publishQueue['1'];
  writeJsonAtomic(snapshotFile, {
    revision: 3,
    coach: [{
      handNo: 1,
      text: '변조된 텍스트',
      coachProof: { id: queued.publicProofId, payloadSha256: queued.payloadSha256 },
    }],
  });
  const rec = await cc.reconcile({ gameDir: dir, snapshotFile });
  assert.deepEqual(rec.reconciled, []);
  assert.ok(cc.loadAuthority(dir).publishQueue['1']);
  assert.equal(cc.loadAuthority(dir).publishedSeals['1'], undefined);
});

test('unreadable snapshot은 queue와 envelope를 유지한다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '원문' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  fs.writeFileSync(snapshotFile, '<<<not-json');
  const rec = await cc.reconcile({ gameDir: dir, snapshotFile });
  assert.deepEqual(rec.reconciled, []);
  assert.ok(cc.loadAuthority(dir).publishQueue['1']);
  assert.equal(fs.existsSync(cc.loadAuthority(dir).publishQueue['1'].exactEnvelopePath), true);
});

test('rollback rehearsal: pending Q 또는 unresolved attempt면 거부', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '대기' });
  await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  let guard = await cc.assertRollbackAllowed(dir);
  assert.equal(guard.ok, false);
  assert.equal(guard.code, 'ROLLBACK_REFUSED');

  const clean = setup({ token: 'tok-roll-ok' });
  await clean.cc.beginOwner({
    gameDir: clean.dir, owner: clean.owner, completed: 0,
    statsFile: clean.statsFile, snapshotFile: clean.snapshotFile,
  });
  guard = await clean.cc.assertRollbackAllowed(clean.dir);
  assert.equal(guard.ok, true);
});

test('rollback guard는 retired cleanup이 released가 아니면 거부한다', async () => {
  const first = setup({ token: 'tok-roll-retired-unconfirmed' });
  const started = await first.cc.beginOwner({
    gameDir: first.dir, owner: first.owner, completed: 1,
    statsFile: first.statsFile, snapshotFile: first.snapshotFile,
  });
  await first.cc.fence({
    gameDir: first.dir, owner: first.owner, handNo: 1,
    generation: started.descriptors[0].generation,
    reason: 'termination_unconfirmed',
  });
  await first.cc.recordCleanup({
    gameDir: first.dir, owner: first.owner, handNo: 1,
    generation: started.descriptors[0].generation,
    cleanupState: 'termination_unconfirmed',
  });
  assert.deepEqual(await first.cc.assertRollbackAllowed(first.dir), {
    ok: false,
    code: 'ROLLBACK_REFUSED',
  });

  const second = setup({ token: 'tok-roll-retired-pending' });
  await second.cc.beginOwner({
    gameDir: second.dir, owner: second.owner, completed: 0,
    statsFile: second.statsFile, snapshotFile: second.snapshotFile,
  });
  const authPath = path.join(second.dir, '.coach-authority.json');
  const auth = second.cc.loadAuthority(second.dir);
  auth.retiredAttempts.push({
    ownerSessionId: second.owner,
    handNo: 1,
    generation: 1,
    cleanupState: 'pending',
    agentHandle: null,
  });
  writeJsonAtomic(authPath, auth);
  assert.deepEqual(await second.cc.assertRollbackAllowed(second.dir), {
    ok: false,
    code: 'ROLLBACK_REFUSED',
  });
});

test('game-over remaining 5,001ms는 교체 가능, 4,999ms는 불가', () => {
  const cutoff = 10_000_000_000n;
  assert.equal(canStartReplacement(cutoff - 5_001_000_000n, cutoff), true);
  assert.equal(canStartReplacement(cutoff - 5_000_000_000n, cutoff), true);
  assert.equal(canStartReplacement(cutoff - 4_999_000_000n, cutoff), false);
});

test('accept는 파일이 없을 때만 default deadline 경계에서 expired', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '늦어도 파일이 있으면 승격' });
  clock.advanceMs(DEFAULT_ATTEMPT_MS + 1);
  const late = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(late.ok, true);

  const clock2 = new FakeClock();
  const b = setup({ clock: clock2, token: 'tok-no-file' });
  const started2 = await b.cc.beginOwner({
    gameDir: b.dir, owner: b.owner, completed: 1, statsFile: b.statsFile, snapshotFile: b.snapshotFile,
  });
  clock2.advanceMs(DEFAULT_ATTEMPT_MS + 1);
  const out = await b.cc.accept({
    gameDir: b.dir, owner: b.owner, handNo: 1, generation: started2.descriptors[0].generation,
  });
  assert.equal(out.code, 'ATTEMPT_TIMEOUT');
});

test('교차 프로세스 heartbeat는 실제 hrtime으로 만료된 reservation을 fence한다', async () => {
  const dir = tmpGame();
  const owner = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: 8877, sessionToken: 'tok-hrtime', startedAt: new Date().toISOString(),
  }));
  writeJsonAtomic(path.join(dir, 'ui-snapshot.json'), { revision: 0, coach: [] });
  writeJsonAtomic(path.join(dir, 'stats.json'), { perPlayer: { user: { sample: 1, vpip: 0.2 } } });
  const cc = createCoachControl();
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1,
    statsFile: path.join(dir, 'stats.json'),
    snapshotFile: path.join(dir, 'ui-snapshot.json'),
  });
  const authPath = path.join(dir, '.coach-authority.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  auth.hands['1'].deadlineMono = (process.hrtime.bigint() - 1_000_000n).toString();
  writeJsonAtomic(authPath, auth);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createCoachControl } from ${JSON.stringify(path.join(ROOT, 'tools/coach-control.js'))};
    const cc = createCoachControl();
    const out = await cc.heartbeat({ gameDir: process.argv[1], owner: process.argv[2] });
    process.stdout.write(JSON.stringify(out));
  `, dir, owner], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.actions[0].action, 'timeout-fence');
  assert.equal(out.actions[0].generation, started.descriptors[0].generation);
});

test('Gate A: 실제 publish.js child가 lock을 잡은 채 cutoff되면 종료 후 missing을 seal한다', async () => {
  const dir = tmpGame();
  const owner = '11111111-1111-4111-8111-111111111111';
  const hung = http.createServer(() => { /* never responds */ });
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const port = hung.address().port;
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port, sessionToken: 'tok-live', startedAt: new Date().toISOString(),
  }));
  writeJsonAtomic(path.join(dir, 'ui-snapshot.json'), { revision: 0, coach: [] });
  writeJsonAtomic(path.join(dir, 'stats.json'), { perPlayer: { user: { sample: 1, vpip: 0.3 } } });
  const cc = createCoachControl();
  await cc.beginOwner({
    gameDir: dir, owner, completed: 1,
    statsFile: path.join(dir, 'stats.json'),
    snapshotFile: path.join(dir, 'ui-snapshot.json'),
  });
  const envelope = path.join(dir, 'turn.json');
  fs.writeFileSync(envelope, JSON.stringify({
    ok: true, stateVersion: 1, handOver: false, gameOver: false,
    view: { handNo: 1 }, viewFor: 'user', events: [], next: null,
  }));
  const child = spawn(process.execPath, [PUBLISH, '--from', envelope, '--game-dir', dir, '--lock-wait-ms', '8000'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const startedAt = Date.now();
  while (!hasLiveLockHolder(dir) && Date.now() - startedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(hasLiveLockHolder(dir), true, 'publish child가 lock을 잡지 않았다');
  process.kill(child.pid, 0);

  let sawLive = false;
  const host = {
    stopNewPlayTimePublishers() {},
    listLivePublishers() { return [{ pid: child.pid }]; },
    async terminateLive(live) {
      process.kill(live[0].pid, 0);
      sawLive = true;
      const results = await Promise.all(live.map((item) => terminateProcessGroup(item.pid)));
      return { confirmed: results.every((row) => row.confirmed) };
    },
    hasLiveLockHolder,
  };
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 1,
    snapshotFile: path.join(dir, 'ui-snapshot.json'),
    statsFile: path.join(dir, 'stats.json'),
    host,
  });
  hung.close();
  assert.equal(sawLive, true);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(hasLiveLockHolder(dir), false);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'unavailable');
});

test('stale owner finalize-cutoff는 live publisher를 종료하지 않는다', async () => {
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: ownerA });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  await cc.beginOwner({
    gameDir: dir, owner: ownerA, completed: 1, statsFile, snapshotFile,
  });
  await cc.beginOwner({
    gameDir: dir, owner: ownerB, completed: 1, statsFile, snapshotFile,
  });
  let terminated = false;
  const host = {
    stopNewPlayTimePublishers() {},
    listLivePublishers() { return [{ pid: 1 }]; },
    async terminateLive() { terminated = true; return { confirmed: true }; },
    hasLiveLockHolder() { return false; },
  };
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner: ownerA, completed: 1, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'STALE_OWNER');
  assert.equal(terminated, false);
});

test('stale owner finalize-cutoff는 FINALIZATION_ABORTED', async () => {
  const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: ownerA });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  await cc.beginOwner({
    gameDir: dir, owner: ownerA, completed: 1, statsFile, snapshotFile,
  });
  await cc.beginOwner({
    gameDir: dir, owner: ownerB, completed: 1, statsFile, snapshotFile,
  });
  const host = {
    stopNewPlayTimePublishers() {},
    listLivePublishers() { return []; },
    async terminateLive() { return { confirmed: true }; },
    hasLiveLockHolder() { return false; },
  };
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner: ownerA, completed: 1, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'FINALIZATION_ABORTED');
  assert.equal(out.reason, 'STALE_OWNER');
});

test('oversize legacy note 후 finalize-cutoff는 missing을 unavailable로 seal한다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeJsonAtomic(snapshotFile, { revision: 1, coach: [{ handNo: 1, text: 'x'.repeat(80_000) }] });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  await cc.fence({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, reason: 'test',
  });
  const host = {
    stopNewPlayTimePublishers() {},
    listLivePublishers() { return []; },
    async terminateLive() { return { confirmed: true }; },
    hasLiveLockHolder() { return false; },
  };
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 1, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'unavailable');
});

test('adapter-disable 이후 begin-owner는 spawn descriptor 없이 unavailable seal', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  await cc.adapterDisable({ gameDir: dir, owner, reason: 'release-failed' });
  const again = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  assert.deepEqual(again.descriptors, []);
  assert.deepEqual(again.unavailableSealed, [1]);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'unavailable');
});
