import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireOwnedLock, releaseOwnedLock, runExclusive, withMutation,
} from '../engine/state.js';
import {
  isReservedName, shouldArchive, archiveTag, formatArchiveId,
  closeOpenPartial, vacateLive, initGameDir, stopServer,
} from '../engine/game-archive.js';

function delegateFs(overrides = {}) {
  return {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    readdirSync: (...args) => fs.readdirSync(...args),
    renameSync: (...args) => fs.renameSync(...args),
    rmSync: (...args) => fs.rmSync(...args),
    statSync: (...args) => fs.statSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
    existsSync: (...args) => fs.existsSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    ...overrides,
  };
}

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-archive-'));
}

function jumpingNow() {
  let ms = 0;
  return () => {
    const value = new Date(ms);
    ms += 60_000;
    return value;
  };
}

function listedArchives(dir) {
  const archiveDir = path.join(dir, 'archive');
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir).filter((name) => !name.startsWith('.'));
}

test('runExclusive는 state.json 없이 락을 잡고 fn을 실행한다', () => {
  const dir = tmpGame();
  const out = runExclusive(dir, () => {
    assert.equal(fs.existsSync(path.join(dir, '.mutex')), true);
    return 7;
  });
  assert.equal(out, 7);
  assert.equal(fs.existsSync(path.join(dir, '.mutex')), false);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('runExclusive는 throw 후에도 락을 푼다', () => {
  const dir = tmpGame();
  assert.throws(() => runExclusive(dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(path.join(dir, '.mutex')), false);
});

test('isReservedName: archive, .mutex, publish.lock.d', () => {
  assert.equal(isReservedName('archive'), true);
  assert.equal(isReservedName('.mutex'), true);
  assert.equal(isReservedName('publish.lock.d'), true);
  assert.equal(isReservedName('state.json'), false);
  assert.equal(isReservedName('hands'), false);
});

test('shouldArchive: 빈 init은 false, ui-snapshot만 있으면 true', () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    handNo: 0, lastHand: null, hand: null, gameOver: false,
  }));
  assert.equal(shouldArchive(dir), false);
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  assert.equal(shouldArchive(dir), true);
});

test('shouldArchive: 깨진 state + hands 파일이면 true', () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'state.json'), '{');
  fs.mkdirSync(path.join(dir, 'hands'));
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), '{}');
  assert.equal(shouldArchive(dir), true);
});

test('archiveTag와 충돌 접미사', () => {
  assert.equal(archiveTag({ gameOver: true, result: 'abort' }), 'abort');
  assert.equal(archiveTag({ gameOver: true, result: 'win' }), 'win');
  assert.equal(archiveTag({ gameOver: false, result: null }), 'in-progress');
  assert.equal(archiveTag({ gameOver: true, result: 'a/b' }), 'in-progress');
  const id = formatArchiveId(new Date('2026-08-27T13:36:51Z'), 'abort', new Set());
  assert.equal(id, '20260827T133651Z-abort');
  const id2 = formatArchiveId(new Date('2026-08-27T13:36:51Z'), 'abort', new Set([id]));
  assert.equal(id2, '20260827T133651Z-abort-2');
});

test('vacateLive: 빈 게임은 라이브 state만 지우고 archive를 남긴다', () => {
  const dir = tmpGame();
  fs.mkdirSync(path.join(dir, 'archive', 'keep-me'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive', 'keep-me', 'marker'), 'x');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    handNo: 0, lastHand: null, hand: null, gameOver: false,
  }));
  assert.equal(vacateLive(dir), null);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'keep-me', 'marker'), 'utf8'), 'x');
});

test('closeOpenPartial: 라이브 스냅샷을 같은 partial로 합친다', () => {
  const dir = tmpGame();
  const partial = path.join(dir, 'archive', '.20260827T133651Z-in-progress.partial');
  fs.mkdirSync(path.join(partial, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(partial, 'state.json'), JSON.stringify({
    handNo: 1, lastHand: null, hand: { handNo: 1 }, gameOver: false,
  }));
  fs.writeFileSync(path.join(partial, 'hands', 'hand-0001.json'), '{"handNo":1}');
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{"log":[1]}');
  const archivedTo = closeOpenPartial(dir);
  assert.equal(archivedTo, 'archive/20260827T133651Z-in-progress');
  const dest = path.join(dir, archivedTo);
  assert.equal(fs.existsSync(path.join(dest, 'ui-snapshot.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'ui-snapshot.json')), false);
  assert.equal(fs.existsSync(partial), false);
});

test('vacateLive: rename EXDEV면 복사하지 않고 원본을 남긴다', () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  const io = {
    fs: delegateFs({
      renameSync() {
        const err = new Error('EXDEV');
        err.code = 'EXDEV';
        throw err;
      },
    }),
    now: () => new Date('2026-08-27T13:36:51Z'),
  };
  assert.throws(() => vacateLive(dir, io), (e) => e.code === 'ARCHIVE_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'ui-snapshot.json')), true);
});

test('closeOpenPartial: partial이 둘이면 ARCHIVE_FAILED이고 라이브를 건드리지 않는다', () => {
  const dir = tmpGame();
  fs.mkdirSync(path.join(dir, 'archive', '.20260827T133651Z-in-progress.partial'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'archive', '.20260827T133652Z-in-progress.partial'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  assert.throws(() => closeOpenPartial(dir), (e) => e.code === 'ARCHIVE_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'ui-snapshot.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'archive', '.20260827T133651Z-in-progress.partial')), true);
  assert.equal(fs.existsSync(path.join(dir, 'archive', '.20260827T133652Z-in-progress.partial')), true);
});

test('closeOpenPartial: publish.lock.d는 라이브에 남는다', () => {
  const dir = tmpGame();
  const partial = path.join(dir, 'archive', '.20260827T133651Z-in-progress.partial');
  fs.mkdirSync(path.join(partial, 'hands'), { recursive: true });
  fs.writeFileSync(path.join(partial, 'state.json'), JSON.stringify({
    handNo: 1, lastHand: null, hand: { handNo: 1 }, gameOver: false,
  }));
  fs.mkdirSync(path.join(dir, 'publish.lock.d'));
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  const archivedTo = closeOpenPartial(dir);
  assert.equal(archivedTo, 'archive/20260827T133651Z-in-progress');
  assert.equal(fs.existsSync(path.join(dir, 'publish.lock.d')), true);
  assert.equal(fs.existsSync(path.join(dir, archivedTo, 'publish.lock.d')), false);
});

test('vacateLive: publish.lock.d는 보관·삭제 뒤에도 라이브에 남는다', () => {
  const emptied = tmpGame();
  fs.mkdirSync(path.join(emptied, 'publish.lock.d'));
  fs.writeFileSync(path.join(emptied, 'state.json'), JSON.stringify({
    handNo: 0, lastHand: null, hand: null, gameOver: false,
  }));
  assert.equal(vacateLive(emptied), null);
  assert.equal(fs.existsSync(path.join(emptied, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(emptied, 'publish.lock.d')), true);

  const archived = tmpGame();
  fs.mkdirSync(path.join(archived, 'publish.lock.d'));
  fs.writeFileSync(path.join(archived, 'ui-snapshot.json'), '{}');
  const io = { fs, now: () => new Date('2026-08-27T13:36:51Z') };
  const archivedTo = vacateLive(archived, io);
  assert.equal(archivedTo, 'archive/20260827T133651Z-in-progress');
  assert.equal(fs.existsSync(path.join(archived, 'publish.lock.d')), true);
  assert.equal(fs.existsSync(path.join(archived, archivedTo, 'publish.lock.d')), false);
  assert.equal(fs.existsSync(path.join(archived, 'ui-snapshot.json')), false);
  assert.equal(fs.existsSync(path.join(archived, archivedTo, 'ui-snapshot.json')), true);
});

test('vacateLive: 빈 게임 삭제 실패면 ARCHIVE_FAILED이고 원본을 남긴다', () => {
  const dir = tmpGame();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    handNo: 0, lastHand: null, hand: null, gameOver: false,
  }));
  const io = {
    fs: delegateFs({
      rmSync() {
        const err = new Error('EACCES');
        err.code = 'EACCES';
        throw err;
      },
    }),
    now: () => new Date('2026-08-27T13:36:51Z'),
  };
  assert.throws(() => vacateLive(dir, io), (e) => e.code === 'ARCHIVE_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), true);
});

test('initGameDir: 핸드가 있는 게임을 archive하고 새 게임을 쓴다', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  assert.equal(first.archivedTo, null);
  assert.equal(first.stateVersion, 1);
  assert.equal(first.players[0].playerId, 'user');
  for (const player of first.players) {
    assert.deepEqual(Object.keys(player).sort(), ['name', 'playerId']);
  }
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
  assert.ok(stored[1].archetype);

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
    handNo: 1,
    hand: { handNo: 1 },
  }));
  const second = initGameDir(dir, { aiCount: 2, force: true });
  assert.match(second.archivedTo, /^archive\/\d{8}T\d{6}Z-in-progress/);
  assert.notEqual(second.sessionToken, first.sessionToken);
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(live.handNo, 0);
  assert.equal(live.stateVersion, 1);
  assert.equal(fs.existsSync(path.join(dir, second.archivedTo, 'state.json')), true);
});

test('initGameDir: 열린 partial + 라이브 스냅샷을 한 아카이브로 닫고 새 게임을 쓴다', () => {
  const dir = tmpGame();
  initGameDir(dir, { aiCount: 2 });
  const partial = path.join(dir, 'archive', '.20260828T010203Z-in-progress.partial');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, 'state.json'), JSON.stringify({
    handNo: 1, hand: { handNo: 1 }, lastHand: null, gameOver: false, result: null,
  }));
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{"log":[]}');
  fs.unlinkSync(path.join(dir, 'state.json'));
  const out = initGameDir(dir, { aiCount: 2 });
  assert.equal(out.archivedTo, 'archive/20260828T010203Z-in-progress');
  assert.equal(fs.existsSync(path.join(dir, out.archivedTo, 'ui-snapshot.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).handNo, 0);
  assert.equal(listedArchives(dir).length, 1);
});

test('initGameDir: 중간 rename 실패 후 재호출이 partial을 닫는다', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  let renames = 0;
  const ioFs = delegateFs({
    renameSync(...args) {
      renames += 1;
      if (renames === 1) {
        const err = new Error('fail');
        err.code = 'EIO';
        throw err;
      }
      return fs.renameSync(...args);
    },
  });
  assert.throws(
    () => initGameDir(dir, { aiCount: 2 }, { fs: ioFs }),
    (e) => e.code === 'ARCHIVE_FAILED' && e.message === '직전 게임을 보관하지 못했습니다.',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessionToken,
    first.sessionToken,
  );
  assert.equal(fs.existsSync(path.join(dir, 'ui-snapshot.json')), true);
  const recovered = initGameDir(dir, { aiCount: 2 });
  assert.match(recovered.archivedTo, /^archive\//);
  assert.equal(fs.existsSync(path.join(dir, 'ui-snapshot.json')), false);
  assert.notEqual(recovered.sessionToken, first.sessionToken);
});

test('initGameDir: isAlive가 계속 true면 SERVER_ALIVE이고 파일을 안 건드린다', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: 1, port: 8877, sessionToken: first.sessionToken, startedAt: new Date().toISOString(),
  }));
  const tokenBefore = first.sessionToken;
  assert.throws(
    () => initGameDir(dir, { aiCount: 2, force: true }, {
      isAlive: () => true,
      kill() {},
      sleepSync() {
        assert.fail('stopServer must not sleep when now is past the deadline');
      },
      now: jumpingNow(),
    }),
    (e) => e.code === 'SERVER_ALIVE' && e.message === '게임 서버가 아직 종료되지 않았습니다.',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessionToken, tokenBefore);
});

test('initGameDir: 활성 서버 + force 없으면 ACTIVE_GAME이고 파일을 안 건드린다', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: 1, port: 8877, sessionToken: first.sessionToken, startedAt: new Date().toISOString(),
  }));
  assert.throws(
    () => initGameDir(dir, { aiCount: 2 }, { isAlive: () => true, kill() { assert.fail('kill'); } }),
    (e) => e.code === 'ACTIVE_GAME' && e.message === '이미 진행 중인 게임이 있습니다.',
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessionToken, first.sessionToken);
  assert.equal(fs.existsSync(path.join(dir, 'archive')), false);
});

test('initGameDir: 한 번 성공한 rename 다음 실패 후 재호출은 아카이브 하나', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  let renames = 0;
  const ioFs = delegateFs({
    renameSync(...args) {
      renames += 1;
      if (renames === 2) {
        const err = new Error('fail');
        err.code = 'EIO';
        throw err;
      }
      return fs.renameSync(...args);
    },
  });
  assert.throws(
    () => initGameDir(dir, { aiCount: 2 }, { fs: ioFs }),
    (e) => e.code === 'ARCHIVE_FAILED',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessionToken,
    first.sessionToken,
  );
  const recovered = initGameDir(dir, { aiCount: 2 });
  assert.match(recovered.archivedTo, /^archive\//);
  assert.equal(listedArchives(dir).length, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'archive')).filter((name) => name.endsWith('.partial')).length, 0);
  assert.notEqual(recovered.sessionToken, first.sessionToken);
});

test('initGameDir: 락을 보유하는 동안 withMutation은 LOCKED이고 .mutex는 아카이브에 없다', () => {
  const dir = tmpGame();
  initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), '{}');
  let sawLocked = false;
  const ioFs = delegateFs({
    renameSync(...args) {
      if (!sawLocked) {
        assert.equal(fs.existsSync(path.join(dir, '.mutex')), true);
        assert.throws(
          () => withMutation(dir, (state) => ({ state, response: null }), { retryMs: 5, timeoutMs: 30 }),
          (e) => e.code === 'LOCKED',
        );
        sawLocked = true;
      }
      return fs.renameSync(...args);
    },
  });
  const out = initGameDir(dir, { aiCount: 2, force: true }, { fs: ioFs });
  assert.equal(sawLocked, true);
  assert.match(out.archivedTo, /^archive\//);
  assert.equal(fs.existsSync(path.join(dir, out.archivedTo, '.mutex')), false);
  assert.equal(fs.existsSync(path.join(dir, '.mutex')), false);
});

test('initGameDir: publish.lock.d는 보관·삭제 뒤에도 라이브에 남는다', () => {
  const emptied = tmpGame();
  initGameDir(emptied, { aiCount: 2 });
  fs.mkdirSync(path.join(emptied, 'publish.lock.d'));
  const emptyOut = initGameDir(emptied, { aiCount: 2, force: true });
  assert.equal(emptyOut.archivedTo, null);
  assert.equal(fs.existsSync(path.join(emptied, 'publish.lock.d')), true);
  assert.equal(fs.existsSync(path.join(emptied, 'archive')), false);

  const archived = tmpGame();
  initGameDir(archived, { aiCount: 2 });
  fs.mkdirSync(path.join(archived, 'publish.lock.d'));
  fs.writeFileSync(path.join(archived, 'ui-snapshot.json'), '{}');
  const out = initGameDir(archived, { aiCount: 2, force: true });
  assert.match(out.archivedTo, /^archive\//);
  assert.equal(fs.existsSync(path.join(archived, 'publish.lock.d')), true);
  assert.equal(fs.existsSync(path.join(archived, out.archivedTo, 'publish.lock.d')), false);
});

test('서버가 죽어도 loop 락이 살아 있으면 init은 ACTIVE_GAME/LOOP_ALIVE', () => {
  const dir = tmpGame();
  initGameDir(dir, { aiCount: 2 });
  // 이 테스트 프로세스가 loop.lock.d의 소유자(살아 있음)가 된다. callerPpid를
  // 0으로 주입해 "락 소유자가 부른 자식"의 ppid 예외를 피한다.
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  try {
    assert.throws(
      () => initGameDir(dir, { aiCount: 2 }, { callerPpid: 0 }),
      (e) => e.code === 'ACTIVE_GAME',
    );
    assert.throws(
      () => initGameDir(dir, { aiCount: 2, force: true }, { callerPpid: 0 }),
      (e) => e.code === 'LOOP_ALIVE',
    );
  } finally {
    releaseOwnedLock(h);
  }
});

test('loop 소유자가 부른 자식 init(ppid == loopPid)은 통과한다', () => {
  const dir = tmpGame();
  const h = acquireOwnedLock(dir, 'loop.lock.d');
  try {
    const result = initGameDir(dir, { aiCount: 2 }, { callerPpid: process.pid });
    assert.ok(result.sessionToken);
  } finally {
    releaseOwnedLock(h);
  }
});

test('죽은 loop 락(또는 startTime 불일치)은 활성으로 치지 않는다', () => {
  const dir = tmpGame();
  fs.mkdirSync(path.join(dir, 'loop.lock.d'));
  fs.writeFileSync(path.join(dir, 'loop.lock.d', 'pid'), '999999\nbogus-dead-pid');
  const first = initGameDir(dir, { aiCount: 2 });
  assert.ok(first.sessionToken);

  // 살아 있는 pid(이 테스트 프로세스 자신)지만 기록된 startTime이 실제와
  // 다르면(재사용 방어) 여전히 죽은 것으로 취급한다.
  fs.writeFileSync(
    path.join(dir, 'loop.lock.d', 'pid'),
    `${process.pid}\nbogus-mismatched-start-time`,
  );
  const second = initGameDir(dir, { aiCount: 2, force: true });
  assert.ok(second.sessionToken);
});

test('stopServer: now가 마감을 넘기면 sleep 없이 SIGTERM 후 SIGKILL한다', () => {
  const signals = [];
  stopServer(42, {
    isAlive: () => true,
    kill(pid, signal) {
      assert.equal(pid, 42);
      signals.push(signal);
    },
    sleepSync() {
      assert.fail('stopServer must not sleep when now is past the deadline');
    },
    now: jumpingNow(),
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
