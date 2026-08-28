import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExclusive } from '../engine/state.js';
import {
  isReservedName, shouldArchive, archiveTag, formatArchiveId,
} from '../engine/game-archive.js';

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
