import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { loadState, saveState, withMutation, writeHandArchive, readHand, isReclaimable } from '../engine/state.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-')); }

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
