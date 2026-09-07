import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { loadState, saveState, withMutation, withNamedLock, writeHandArchive, readHand, isReclaimable, acquireOwnedLock, readOwnedLock, releaseOwnedLock, processStartTime, ownedProcessStartTime, parseOwnedLockIdentity, writeJsonAtomic } from '../engine/state.js';
import { spawnSleeper, skipOnWin32 } from './helpers/platform.js';

function tmpDir() { return createOwnedTempDir('holdem-state'); }

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
}

test('writeJsonAtomic replaces an existing dest', () => {
  const d = tmpDir();
  const file = path.join(d, 'lock.json');
  writeJsonAtomic(file, { n: 1 });
  writeJsonAtomic(file, { n: 2, extra: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2, extra: true });
});
test('save는 stateVersion을 올리고 load로 왕복된다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0, foo: '가' });
  const s = loadState(d);
  assert.equal(s.stateVersion, 1);
  assert.equal(s.foo, '가');
});
test('withMutation에서 fn이 throw하면 상태 무변경', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0, v: 1 });
  assert.throws(() => withMutation(d, s => { s.v = 2; throw new Error('boom'); }));
  assert.equal(loadState(d).v, 1);
});
test('죽은 소유자의 mutex는 회수되고 커밋이 성공한다', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, '.mutex'));
  fs.writeFileSync(path.join(d, '.mutex', 'pid'), '999999999');
  saveState(d, { stateVersion: 0 });
  const r = withMutation(d, s => ({ state: { ...s, ok: true }, response: null }));
  assert.equal(r.state.ok, true);
  assert.equal(loadState(d).ok, true);
});
test('아카이브 파일명은 4자리 패딩', () => {
  const d = tmpDir();
  writeHandArchive(d, { handNo: 1, foo: 'bar' });
  const file = path.join(d, 'hands', 'hand-0001.json');
  assert.ok(fs.existsSync(file));
  assert.equal(path.basename(file), 'hand-0001.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { handNo: 1, foo: 'bar' });
  assert.deepEqual(readHand(d, 1), { handNo: 1, foo: 'bar' });
  assert.equal(fs.existsSync(path.join(d, 'hands', 'hand-1.json')), false);
});

const fastLock = { retryMs: 10, timeoutMs: 80 };

test('빈 pid 파일 mutex는 즉시 강탈되지 않는다', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'pid'), '');
  saveState(d, { stateVersion: 0 });
  assert.throws(
    () => withMutation(d, s => ({ state: { ...s, stolen: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  assert.ok(fs.existsSync(mutex));
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), '');
  assert.equal(loadState(d).stolen, undefined);
});

test('신선한 pid-없는 mutex는 강탈되지 않는다', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  saveState(d, { stateVersion: 0 });
  assert.throws(
    () => withMutation(d, s => ({ state: { ...s, stolen: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  assert.ok(fs.existsSync(mutex));
  assert.equal(fs.existsSync(path.join(mutex, 'pid')), false);
  assert.equal(loadState(d).stolen, undefined);
});

test('살아있는 소유자의 mutex는 timeout 후 LOCKED', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'pid'), String(process.pid));
  saveState(d, { stateVersion: 0 });
  const started = Date.now();
  assert.throws(
    () => withMutation(d, s => ({ state: { ...s, stolen: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= fastLock.timeoutMs - 20,
    `LOCKED too soon: ${elapsed}ms`,
  );
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid));
  assert.equal(loadState(d).stolen, undefined);
});

test('stale 디렉터리는 판정한 그 락일 때만 삭제 대상이다', () => {
  const stale = { dev: 1n, ino: 10n, mtimeMs: 0, pid: 999999999 };
  assert.equal(isReclaimable(stale, stale), true);
  // 판정과 재확인 사이에 생긴 교체본: inode가 다르다
  assert.equal(isReclaimable(stale, { dev: 1n, ino: 11n, mtimeMs: Date.now(), pid: null }), false);
  // 같은 inode지만 그 사이 소유자가 자기 pid를 기록했다
  assert.equal(isReclaimable(stale, { dev: 1n, ino: 10n, mtimeMs: Date.now(), pid: process.pid }), false);
  // pid-없는 신선한 락(mkdir→pid 기록 창)은 삭제 대상이 아니다
  assert.equal(isReclaimable(stale, { dev: 1n, ino: 10n, mtimeMs: Date.now(), pid: null }), false);
  const pidless = { dev: 1n, ino: 10n, mtimeMs: Date.now(), pid: null };
  assert.equal(isReclaimable(pidless, pidless), false);
  assert.equal(isReclaimable(stale, null), false);
  assert.equal(isReclaimable(null, stale), false);
});

test('회수는 rename 부산물 없이 제자리 삭제로만 이루어진다', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, '.mutex'));
  fs.writeFileSync(path.join(d, '.mutex', 'pid'), '999999999');
  saveState(d, { stateVersion: 0 });
  const r = withMutation(d, s => ({ state: { ...s, ok: true }, response: null }));
  assert.equal(r.state.ok, true);
  // 이전 구현은 회수·해제 시 `.mutex.<pid>.<hrtime>.stale` aside를 만들었다.
  // 살아있는 락을 rename으로 밀어내는 경로가 사라졌음을 잔여물 부재로 고정한다.
  const leftovers = fs.readdirSync(d).filter(name => name.startsWith('.mutex'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith('pid.reclaim.') || /^\.mutex\.\d+\.[0-9a-f]{8}\.tmp$/.test(n)), []);
});

test('회수는 비재귀다 — 예상 밖 파일이 있으면 락 디렉터리를 지우지 않는다', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'pid'), '999999999');
  fs.writeFileSync(path.join(mutex, 'extra'), 'x');
  saveState(d, { stateVersion: 0 });
  assert.throws(
    () => withMutation(d, s => ({ state: { ...s, stolen: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  // rmdir는 비어 있지 않은 디렉터리를 절대 지우지 않는다(ENOTEMPTY) — pid를 기록한
  // 살아있는 교체 락이 통째로 쓸려나갈 수 없음을 같은 경로로 고정한다.
  assert.ok(fs.existsSync(mutex));
  assert.equal(fs.readFileSync(path.join(mutex, 'extra'), 'utf8'), 'x');
  assert.equal(loadState(d).stolen, undefined);
});

test('staleness를 넘긴 pid-없는 mutex는 회수된다', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  const past = (Date.now() - 60_000) / 1000;
  fs.utimesSync(mutex, past, past);
  saveState(d, { stateVersion: 0 });
  const r = withMutation(d, s => ({ state: { ...s, ok: true }, response: null }), fastLock);
  assert.equal(r.state.ok, true);
  assert.equal(loadState(d).ok, true);
  assert.equal(fs.existsSync(mutex), false);
});

test('owned lock: 살아 있는 소유자는 6초가 지나도 회수되지 않는다', async () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  // mtime을 과거로 밀어도 (utimesSync) 두 번째 acquire는 LOCKED
  const lockDir = path.join(dir, 'loop.lock.d');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);
  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
  releaseOwnedLock(h);
});

test('owned lock: pid 재사용(startTime 불일치)은 dead로 판정되고 회수된다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  // 살아 있는 pid(자기 자신)를 기록하되 startTime을 조작한다
  const historical = process.platform === 'win32' ? 'win32-v1\n2001-01-01T00:00:00.0000000Z' : 'utc-v1\nMon Jan  1 00:00:00 2001';
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n${historical}`);
  const seen = readOwnedLock(dir, 'loop.lock.d');
  assert.equal(seen.alive, false); // 시그널 금지 판정의 근거
  assert.equal(seen.status, 'dead');
  const h = acquireOwnedLock(dir, 'loop.lock.d'); // 회수 후 선점 성공
  assert.equal(h.pid, process.pid); // 회수 후 선점한 락은 진짜 나 자신의 identity를 기록한다
  assert.equal(h.startTime, ownedProcessStartTime(process.pid));
  releaseOwnedLock(h);
});

test('owned lock: 죽은 pid는 회수된다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), '99999999\n어떤-시각');
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  assert.equal(h.pid, process.pid);
  assert.equal(h.startTime, ownedProcessStartTime(process.pid));
  releaseOwnedLock(h);
});

test('readOwnedLock: 락 없음 → null, 자기 자신 → alive true·startTime 일치', () => {
  const dir = tmpDir();
  assert.equal(readOwnedLock(dir, 'loop.lock.d'), null);
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  const seen = readOwnedLock(dir, 'loop.lock.d');
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.alive, true);
  assert.equal(seen.status, 'alive');
  assert.equal(seen.startTime, ownedProcessStartTime(process.pid));
  assert.equal(seen.startTime, h.startTime);
  releaseOwnedLock(h);
});

test('readOwnedLock: 기존 빈 lock 디렉터리는 부재가 아니라 unknown이다', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'loop.lock.d'));
  assert.deepEqual(readOwnedLock(dir, 'loop.lock.d'), {
    pid: null,
    startTime: null,
    alive: false,
    status: 'unknown',
  });
});

test('owned lock: 오래된 pid-less unknown 기록도 shared acquire가 회수하지 않는다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);

  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
  assert.equal(fs.existsSync(lockDir), true);
  assert.deepEqual(fs.readdirSync(lockDir), []);
});

test('owned lock: 오래된 malformed unknown 기록도 shared acquire가 원문을 보존한다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  const malformed = `${process.pid}\n${processStartTime(process.pid)}\nextra`;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), malformed);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);

  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
  assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), malformed);
});

test('1줄 legacy owned 기록은 pid 생존과 무관하게 unknown이라 shared acquire가 회수하지 않는다', () => {
  const alive = tmpDir();
  const aliveLockDir = path.join(alive, 'loop.lock.d');
  fs.mkdirSync(aliveLockDir);
  fs.writeFileSync(path.join(aliveLockDir, 'pid'), String(process.pid));
  assert.throws(() => acquireOwnedLock(alive, 'loop.lock.d'), /LOCKED/);

  const dead = tmpDir();
  const deadLockDir = path.join(dead, 'loop.lock.d');
  fs.mkdirSync(deadLockDir);
  fs.writeFileSync(path.join(deadLockDir, 'pid'), '99999999');
  assert.throws(() => acquireOwnedLock(dead, 'loop.lock.d'), /LOCKED/);
  assert.equal(fs.readFileSync(path.join(deadLockDir, 'pid'), 'utf8'), '99999999');
});

test('owned lock 디렉터리에 pid 외 파일이 생겨도 fail-closed: 외부 파일을 지우지 않고 LOCKED', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  fs.writeFileSync(path.join(lockDir, 'extra'), 'x');
  releaseOwnedLock(h); // pid 파일만 지우고 rmdir는 ENOTEMPTY로 삼켜진다 — 디렉터리·잡파일은 남는다
  assert.ok(fs.existsSync(lockDir));
  assert.equal(fs.readFileSync(path.join(lockDir, 'extra'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(lockDir, 'pid')), false);
  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
  assert.equal(fs.readFileSync(path.join(lockDir, 'extra'), 'utf8'), 'x');
});

test('processStartTime: 존재하지 않는 pid는 null', () => {
  assert.equal(processStartTime(99999999), null);
});

test('owned lock: 자신의 startTime을 알 수 없으면 락을 만들지 않고 LOCKED가 아닌 구분되는 에러로 실패한다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  assert.throws(
    () => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: () => null }),
    (err) => err.code === 'IDENTITY_UNAVAILABLE' && err.code !== 'LOCKED',
  );
  assert.equal(fs.existsSync(lockDir), false); // mkdir 자체가 실행되지 않는다
});

test('owned lock: 살아있는 기록 소유자의 read-time startTime을 알 수 없으면 회수하지 않는다(unknown, fail-closed)', async () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  const child = spawnSleeper(5_000);
  await new Promise(resolve => child.once('spawn', resolve));
  const identity = ownedProcessStartTime(child.pid);
  const separator = identity.indexOf(':');
  const recorded = `${child.pid}\n${identity.slice(0, separator)}\n${identity.slice(separator + 1)}`;
  fs.writeFileSync(path.join(lockDir, 'pid'), recorded);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);
  const startTimeOf = (pid) => (pid === child.pid ? null : processStartTime(pid));
  try {
    const seen = readOwnedLock(dir, 'loop.lock.d', { processStartTime: startTimeOf });
    assert.equal(seen.alive, false); // 긍정 증명 없이는 시그널을 authorize하지 않는다
    assert.equal(seen.status, 'unknown'); // destructive caller가 dead와 구분할 공개 근거
    assert.throws(
      () => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: startTimeOf }),
      /LOCKED/,
    ); // unknown은 회수하지 않는다
    assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), recorded); // 기록 보존
  } finally {
    await terminateChild(child);
  }
});

test('readOwnedLock: malformed 기록은 존재하는 unknown 락으로 보고 alive를 authorize하지 않는다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n${processStartTime(process.pid)}\n잡줄`);
  assert.deepEqual(readOwnedLock(dir, 'loop.lock.d'), {
    pid: null,
    startTime: null,
    alive: false,
    status: 'unknown',
  });
});

test('readOwnedLock: 1줄 레거시 기록은 존재하는 unknown owned 락으로 구분한다', () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  assert.deepEqual(readOwnedLock(dir, 'loop.lock.d'), {
    pid: process.pid,
    startTime: null,
    alive: false,
    status: 'unknown',
  });
});

test('owned lock: pid 파일 하나만, 정확히 버전이 명시된 3줄', () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  const lockDir = path.join(dir, 'loop.lock.d');
  assert.deepEqual(fs.readdirSync(lockDir), ['pid']);
  const content = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8');
  const separator = h.startTime.indexOf(':');
  assert.equal(content, `${process.pid}\n${h.startTime.slice(0, separator)}\n${h.startTime.slice(separator + 1)}`);
  assert.deepEqual(parseOwnedLockIdentity(content), { pid: h.pid, startTime: h.startTime });
  assert.equal(parseOwnedLockIdentity(content + '\n'), null);
  releaseOwnedLock(h);
});

test('releaseOwnedLock: 디렉터리가 교체되면(inode 불일치) 교체본을 보존한다', () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.unlinkSync(path.join(lockDir, 'pid'));
  fs.rmdirSync(lockDir);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), '12345\n대체-소유자-시각');
  releaseOwnedLock(h); // 자기 identity(inode) 불일치 → 조용히 반환, 교체본은 그대로
  assert.ok(fs.existsSync(lockDir));
  assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), '12345\n대체-소유자-시각');
});

test('releaseOwnedLock: 같은 디렉터리 inode의 owner 기록이 교체돼도 교체본을 보존한다', () => {
  const dir = tmpDir();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  const lockDir = path.join(dir, 'loop.lock.d');
  fs.writeFileSync(path.join(lockDir, 'pid'), '12345\n대체-소유자-시각');
  releaseOwnedLock(h);
  assert.ok(fs.existsSync(lockDir));
  assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), '12345\n대체-소유자-시각');
});


for (const [ownerTz, readerTz] of [['Asia/Seoul', 'UTC'], ['UTC', 'America/Los_Angeles']]) {
  test(`owned identity stays alive across timezones: ${ownerTz} to ${readerTz}`, { timeout: 10_000 }, async (t) => {
    const dir = createOwnedTempDir('holdem-owned-tz');
    const stateUrl = new URL('../engine/state.js', import.meta.url).href;
    const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', `
      import { acquireOwnedLock, releaseOwnedLock } from ${JSON.stringify(stateUrl)};
      const handle = acquireOwnedLock(${JSON.stringify(dir)}, 'loop.lock.d');
      process.on('SIGTERM', () => { releaseOwnedLock(handle); process.exit(0); });
      process.send({ ready: true });
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, TZ: ownerTz }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), 'timezone owner');
    t.after(() => terminateChild(child));
    const [ready] = await once(child, 'message');
    assert.equal(ready.ready, true);
    const before = fs.readFileSync(path.join(dir, 'loop.lock.d', 'pid'));
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readOwnedLock, acquireOwnedLock } from ${JSON.stringify(stateUrl)};
      const seen = readOwnedLock(${JSON.stringify(dir)}, 'loop.lock.d');
      let acquisition = 'not-attempted';
      if (seen.status === 'alive') {
        try { acquireOwnedLock(${JSON.stringify(dir)}, 'loop.lock.d'); acquisition = 'acquired'; }
        catch (error) { acquisition = error.code ?? error.message; }
      }
      console.log(JSON.stringify({ seen, acquisition }));
    `], { env: { ...process.env, TZ: readerTz, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000 }));
    assert.equal(result.seen.status, 'alive', 'a timezone change must not make a live owner reclaimable');
    assert.equal(result.seen.pid, child.pid);
    assert.equal(result.acquisition, 'LOCKED');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'loop.lock.d', 'pid')), before);
  });
}


test('live unversioned and unknown-version lifetime identities are protected without writes', () => {
  for (const stamp of [processStartTime(process.pid), ownedProcessStartTime(process.pid), 'utc-v2:Sun Sep  6 00:00:00 2026', 'utc-v1:not-a-timestamp']) {
    const dir = createOwnedTempDir('holdem-owned-legacy');
    const lock = path.join(dir, 'loop.lock.d');
    fs.mkdirSync(lock);
    const raw = `${process.pid}\n${stamp}`;
    fs.writeFileSync(path.join(lock, 'pid'), raw);
    assert.equal(readOwnedLock(dir, 'loop.lock.d').status, 'unknown');
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), raw);
  }
});


test('owned identity rejects malformed canonical dates and preserves legacy query output', () => {
  const plain = processStartTime(process.pid);
  assert.ok(plain && !plain.startsWith('utc-v1:'));
  assert.match(ownedProcessStartTime(process.pid), process.platform === 'win32' ? /^win32-v1:/ : /^utc-v1:/);
  assert.equal(processStartTime(process.pid), plain);
  for (const stamp of ['Sun Feb 30 00:00:00 2026', 'Sun Sep  6 24:00:00 2026', 'Mon Sep  6 00:00:00 2026']) {
    const dir = tmpDir(); const lock = path.join(dir, 'loop.lock.d'); fs.mkdirSync(lock);
    const raw = `${process.pid}\nutc-v1\n${stamp}`; fs.writeFileSync(path.join(lock, 'pid'), raw);
    assert.equal(readOwnedLock(dir, 'loop.lock.d').status, 'unknown');
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), raw);
  }
});


test('noncanonical zero-padded day cannot make a live owned identity reclaimable', () => {
  const dir = tmpDir(); const lock = path.join(dir, 'loop.lock.d'); fs.mkdirSync(lock);
  const raw = `${process.pid}\nutc-v1\nSun Sep 06 00:00:00 2026`;
  fs.writeFileSync(path.join(lock, 'pid'), raw);
  {
    assert.deepEqual(parseOwnedLockIdentity(`${process.pid}\nutc-v1\nSun Sep  6 00:00:00 2026`), { pid: process.pid, startTime: 'utc-v1:Sun Sep  6 00:00:00 2026' });
    assert.equal(parseOwnedLockIdentity(raw), null);
    assert.equal(readOwnedLock(dir, 'loop.lock.d').status, 'unknown', 'equivalent noncanonical spelling must not prove owner death');
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), /LOCKED/);
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), raw);
  }
});

// #148: 회수자가 죽은 락을 판정·검증한 뒤 pid를 지우기 직전, 동료가 그 락을 완전히 회수하고
// 자기 락을 세운다. 회수자는 동료의 산 락을 파괴해서는 안 된다.
function reclaimTheftHooks() {
  let peerAcquired = false;
  let peerIno = null;
  let calls = 0;
  const hooks = {
    beforeUnlinkPid(dir) {
      calls += 1;
      if (calls > 1) return;
      try { fs.unlinkSync(path.join(dir, 'pid')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { fs.rmdirSync(dir); } catch (e) { if (e.code === 'ENOTEMPTY') return; throw e; }
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      peerIno = fs.statSync(dir, { bigint: true }).ino;
      peerAcquired = true;
    },
  };
  return { hooks, get calls() { return calls; }, get peerAcquired() { return peerAcquired; }, get peerIno() { return peerIno; } };
}

test('T1: 회수자는 검증과 unlink 사이에 동료가 세운 산 락을 파괴하지 않는다', () => {
  const d = tmpDir();
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'pid'), '2147480000');
  saveState(d, { stateVersion: 0 });
  const sim = reclaimTheftHooks();
  let error = null;
  try {
    withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks: sim.hooks });
  } catch (e) { error = e; }
  assert.ok(sim.calls >= 1, 'hook never reached');
  if (sim.peerAcquired) {
    assert.equal(error?.code, 'LOCKED', `stole the peer lock: ${error ? error.code : 'acquired'}`);
    assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid), 'peer pid destroyed');
    assert.equal(fs.statSync(mutex, { bigint: true }).ino, sim.peerIno, 'peer lock directory replaced');
    assert.equal(loadState(d).ran, undefined);
  } else {
    assert.equal(error, null, `peer was pinned out but we did not acquire: ${error?.code}`);
    assert.equal(loadState(d).ran, true);
    assert.equal(fs.existsSync(mutex), false);
  }
});

test('T1 named: withNamedLock도 같은 창에서 동료의 산 락을 파괴하지 않는다', async () => {
  const d = tmpDir();
  const lockDir = path.join(d, 'publish.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), '2147480000');
  const sim = reclaimTheftHooks();
  let error = null;
  let ran = false;
  try {
    await withNamedLock(d, 'publish.lock.d', async () => { ran = true; }, { ...fastLock, hooks: sim.hooks });
  } catch (e) { error = e; }
  assert.ok(sim.calls >= 1, 'hook never reached');
  if (sim.peerAcquired) {
    assert.equal(error?.code, 'LOCKED', `stole the peer lock: ${error ? error.code : 'acquired'}`);
    assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), String(process.pid), 'peer pid destroyed');
    assert.equal(fs.statSync(lockDir, { bigint: true }).ino, sim.peerIno, 'peer lock directory replaced');
    assert.equal(ran, false);
  } else {
    assert.equal(error, null, `peer was pinned out but we did not acquire: ${error?.code}`);
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockDir), false);
  }
});

const DEAD = '2147480000';
function deadMutex(d, name = '.mutex') {
  const dir = path.join(d, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pid'), DEAD);
  return dir;
}
const inodeOf = (p) => fs.statSync(p, { bigint: true }).ino;
function onceHook(fn) {
  let n = 0;
  return (...a) => { n += 1; if (n === 1) return fn(...a); return undefined; };
}
const tmpLeftovers = (d, base = '.mutex') => fs.readdirSync(d).filter((n) => n.startsWith(`${base}.`) && n.endsWith('.tmp'));

test('T1b: link가 교체된 산 pid에 붙으면 물러나고 동료 락은 보존된다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  let peerIno;
  const hooks = {
    afterJudge: onceHook((dir) => {
      fs.unlinkSync(path.join(dir, 'pid'));
      fs.rmdirSync(dir);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      peerIno = inodeOf(dir);
    }),
  };
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks }),
    { code: 'LOCKED' },
  );
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid));
  assert.equal(inodeOf(mutex), peerIno);
  assert.deepEqual(fs.readdirSync(mutex), ['pid']);
  assert.equal(loadState(d).ran, undefined);
  assert.deepEqual(tmpLeftovers(d), []);
});

test('T2: 동료가 link 뒤에 stale pid를 지워도 우리는 회수를 마치고 획득한다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  const hooks = {
    afterLink: onceHook((dir) => {
      fs.unlinkSync(path.join(dir, 'pid'));
      assert.throws(() => fs.rmdirSync(dir), { code: 'ENOTEMPTY' });
    }),
  };
  const r = withMutation(d, (s) => ({ state: { ...s, ok: true, seen: fs.readdirSync(mutex) }, response: null }), { ...fastLock, hooks });
  assert.deepEqual(r.state.seen, ['pid']);
  assert.equal(fs.existsSync(mutex), false);
  assert.deepEqual(tmpLeftovers(d), []);
});

test('T2c: afterLink가 throw해도 우리 aside는 남지 않는다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  const hooks = { afterLink() { throw new Error('boom'); } };
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks }),
    /boom/,
  );
  const names = fs.existsSync(mutex) ? fs.readdirSync(mutex) : [];
  assert.equal(names.some((n) => n.startsWith(`pid.reclaim.${process.pid}.`)), false);
});

test('T2b: 살아 있는 회수자의 aside가 rmdir을 막으면 LOCKED이고 그 aside는 보존된다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  const foreign = `pid.reclaim.${process.pid}.deadbeef`;
  const hooks = {
    afterLink: onceHook((dir) => {
      fs.linkSync(path.join(dir, 'pid'), path.join(dir, foreign));
    }),
  };
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks }),
    { code: 'LOCKED' },
  );
  assert.deepEqual(fs.readdirSync(mutex), [foreign]);
});

test('T3: 늦은 회수자의 rmdir은 방금 설치된 산 락을 쓸 수 없다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  let peerIno;
  const hooks = {
    beforeRmdir: onceHook((dir) => {
      fs.rmdirSync(dir);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      peerIno = inodeOf(dir);
    }),
  };
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks }),
    { code: 'LOCKED' },
  );
  assert.equal(inodeOf(mutex), peerIno);
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid));
  assert.deepEqual(tmpLeftovers(d), []);
});

test('T3b: rename 직전에 산 락이 나타나면 ENOTEMPTY로 LOCKED이고 tmp는 정리된다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const mutex = path.join(d, '.mutex');
  let peerIno;
  const hooks = {
    beforeInstall: onceHook((dir) => {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      peerIno = inodeOf(dir);
    }),
  };
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), { ...fastLock, hooks }),
    { code: 'LOCKED' },
  );
  assert.equal(inodeOf(mutex), peerIno);
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid));
  assert.deepEqual(tmpLeftovers(d), []);
});

test('T4: rename 직전에 빈(죽은) 디렉터리가 나타나면 원자 교체 후 획득한다', (t) => {
  if (skipOnWin32(t, 'POSIX rename replaces an empty destination directory; win32 refuses it')) return;
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const mutex = path.join(d, '.mutex');
  const hooks = { beforeInstall: onceHook((dir) => { fs.mkdirSync(dir); }) };
  const r = withMutation(d, (s) => ({ state: { ...s, pid: fs.readFileSync(path.join(mutex, 'pid'), 'utf8') }, response: null }), { ...fastLock, hooks });
  assert.equal(r.state.pid, String(process.pid));
  assert.equal(fs.existsSync(mutex), false);
  assert.deepEqual(tmpLeftovers(d), []);
});

test('T5a: pid 없이 고아 aside만 있으면 즉시 회수된다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, `pid.reclaim.${DEAD}.00000000`), DEAD);
  const t0 = Date.now();
  const r = withMutation(d, (s) => ({ state: { ...s, ok: true }, response: null }), fastLock);
  assert.equal(r.state.ok, true);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fs.existsSync(mutex), false);
});

test('T5b: 살아 있는 회수자의 aside만 있으면 LOCKED이고 aside는 보존된다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  const name = `pid.reclaim.${process.pid}.00000000`;
  fs.writeFileSync(path.join(mutex, name), DEAD);
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  assert.deepEqual(fs.readdirSync(mutex), [name]);
});

test('T5c: 고아 aside와 foreign 파일이 함께 있으면 LOCKED, aside만 지우고 extra는 남긴다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, `pid.reclaim.${DEAD}.00000000`), DEAD);
  fs.writeFileSync(path.join(mutex, 'extra'), 'x');
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  assert.deepEqual(fs.readdirSync(mutex), ['extra']);
});

test('T5d: owned 락은 고아 aside만 있으면 회수되고, 빈 디렉터리는 여전히 LOCKED다', () => {
  const d = tmpDir();
  const lockDir = path.join(d, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, `pid.reclaim.${DEAD}.00000000`), `${DEAD}\nutc-v1\nMon Jan  1 00:00:00 2001`);
  const h = acquireOwnedLock(d, 'loop.lock.d');
  assert.deepEqual(fs.readdirSync(lockDir), ['pid']);
  releaseOwnedLock(h);
  assert.deepEqual(tmpLeftovers(d, 'loop.lock.d'), []);
  const e = tmpDir();
  fs.mkdirSync(path.join(e, 'loop.lock.d'));
  assert.throws(() => acquireOwnedLock(e, 'loop.lock.d'), /LOCKED/);
  assert.deepEqual(fs.readdirSync(path.join(e, 'loop.lock.d')), []);
  assert.deepEqual(tmpLeftovers(e, 'loop.lock.d'), []);
});

test('T6: link 미지원이면 legacy 폴백으로 회수한다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  let linkCalls = 0;
  const hooks = {
    link() {
      linkCalls += 1;
      const err = new Error('nope');
      err.code = 'ENOTSUP';
      throw err;
    },
  };
  const r = withMutation(d, (s) => ({ state: { ...s, ok: true }, response: null }), { ...fastLock, hooks });
  assert.equal(r.state.ok, true);
  assert.equal(linkCalls, 1);
  assert.equal(fs.existsSync(mutex), false);
});

test('T6b: link의 일시 EINVAL은 재판정 후 재시도한다', () => {
  const d = tmpDir();
  const mutex = deadMutex(d);
  saveState(d, { stateVersion: 0 });
  let calls = 0;
  const hooks = {
    link(src, dst) {
      calls += 1;
      if (calls === 1) {
        const err = new Error('x');
        err.code = 'EINVAL';
        throw err;
      }
      return fs.linkSync(src, dst);
    },
  };
  const r = withMutation(d, (s) => ({ state: { ...s, ok: true }, response: null }), { ...fastLock, hooks });
  assert.equal(r.state.ok, true);
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(mutex), false);
});

test('T7: owned 죽은 기록은 link 경로로 회수되고, 도난 시도는 물러난다', () => {
  const d = tmpDir();
  const lockDir = path.join(d, 'loop.lock.d');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), `${DEAD}\nutc-v1\nMon Jan  1 00:00:00 2001`);
  let sawAside = null;
  const h = acquireOwnedLock(d, 'loop.lock.d', { hooks: { afterLink(dir, aside) { sawAside = path.basename(aside); } } });
  assert.match(sawAside, /^pid\.reclaim\.\d+\.[0-9a-f]{8}$/);
  assert.deepEqual(fs.readdirSync(lockDir), ['pid']);
  releaseOwnedLock(h);
  const e = tmpDir();
  const lock2 = path.join(e, 'loop.lock.d');
  fs.mkdirSync(lock2);
  fs.writeFileSync(path.join(lock2, 'pid'), `${DEAD}\nutc-v1\nMon Jan  1 00:00:00 2001`);
  const mine = ownedProcessStartTime(process.pid);
  const sep = mine.indexOf(':');
  const live = `${process.pid}\n${mine.slice(0, sep)}\n${mine.slice(sep + 1)}`;
  let thirdIno;
  const hooks = {
    afterJudge: onceHook((dir) => {
      fs.unlinkSync(path.join(dir, 'pid'));
      fs.rmdirSync(dir);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), live);
      thirdIno = inodeOf(dir);
    }),
  };
  assert.throws(() => acquireOwnedLock(e, 'loop.lock.d', { hooks }), /LOCKED/);
  assert.equal(inodeOf(lock2), thirdIno);
  assert.equal(fs.readFileSync(path.join(lock2, 'pid'), 'utf8'), live);
  assert.deepEqual(fs.readdirSync(lock2), ['pid']);
  assert.deepEqual(tmpLeftovers(e, 'loop.lock.d'), []);
});

test('T8: withNamedLock 정상 회수 뒤 aside·tmp 부산물이 없다', async () => {
  const d = tmpDir();
  const lockDir = deadMutex(d, 'publish.lock.d');
  const seen = await withNamedLock(d, 'publish.lock.d', async () => fs.readdirSync(lockDir), fastLock);
  assert.deepEqual(seen, ['pid']);
  assert.equal(fs.existsSync(lockDir), false);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('reclaim') || n.includes('.tmp')), []);
});

test('T9: 죽은 pid의 tmp는 쓸리고 산 pid의 tmp는 보존되며, LOCKED 타임아웃은 우리 tmp를 남기지 않는다', () => {
  const d = tmpDir();
  saveState(d, { stateVersion: 0 });
  const dead = path.join(d, `.mutex.${DEAD}.deadbeef.tmp`);
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, 'pid'), DEAD);
  const live = path.join(d, `.mutex.${process.pid}.cafebabe.tmp`);
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'pid'), String(process.pid));
  const r = withMutation(d, (s) => ({ state: { ...s, ok: true }, response: null }), fastLock);
  assert.equal(r.state.ok, true);
  assert.equal(fs.existsSync(dead), false);
  assert.ok(fs.existsSync(live));
  fs.unlinkSync(path.join(live, 'pid'));
  fs.rmdirSync(live);
  const mutex = path.join(d, '.mutex');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'pid'), String(process.pid));
  assert.throws(
    () => withMutation(d, (s) => ({ state: { ...s, ran: true }, response: null }), fastLock),
    { code: 'LOCKED' },
  );
  assert.deepEqual(tmpLeftovers(d), []);
  assert.equal(fs.readFileSync(path.join(mutex, 'pid'), 'utf8'), String(process.pid));
});
