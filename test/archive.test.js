import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExclusive } from '../engine/state.js';
import {
  isReservedName, shouldArchive, archiveTag, formatArchiveId,
  closeOpenPartial, vacateLive,
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
