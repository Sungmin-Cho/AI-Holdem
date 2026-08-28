import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExclusive } from '../engine/state.js';

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
