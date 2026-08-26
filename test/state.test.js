import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { loadState, saveState, withMutation, writeHandArchive, readHand } from '../engine/state.js';

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
