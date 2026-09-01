import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendJsonl,
  ensureDir,
  readJsonl,
  readJsonSecure,
  writeJsonSecure,
} from '../tools/training-store.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tstore-'));
}

test('ensureDir creates 0700 and refuses symlink or non-directory', () => {
  const root = tmp();
  const dir = path.join(root, 'training');
  ensureDir(dir);
  const st = fs.lstatSync(dir);
  assert.equal(st.isDirectory(), true);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.mode & 0o777, 0o700);

  const link = path.join(root, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => ensureDir(link), { code: 'UNSAFE_PATH' });

  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => ensureDir(file), { code: 'UNSAFE_PATH' });
});

test('writeJsonSecure is 0600, O_NOFOLLOW, and refuses symlink targets', () => {
  const root = tmp();
  const file = path.join(root, 'training', 'auth.json');
  writeJsonSecure(file, { schemaVersion: 1, ok: true });
  const st = fs.lstatSync(file);
  assert.equal(st.isFile(), true);
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(readJsonSecure(file), { schemaVersion: 1, ok: true });

  const decoy = path.join(root, 'decoy.json');
  fs.writeFileSync(decoy, '{"pwned":true}');
  const linked = path.join(root, 'training', 'linked.json');
  fs.symlinkSync(decoy, linked);
  assert.throws(() => writeJsonSecure(linked, { schemaVersion: 1 }), { code: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(decoy, 'utf8'), '{"pwned":true}');
});

test('jsonl append truncates a torn tail before writing the next event', () => {
  const root = tmp();
  const file = path.join(root, 'training', 'evaluations.jsonl');
  appendJsonl(file, { id: 'a' });
  fs.appendFileSync(file, '{"id":"torn"');
  appendJsonl(file, { id: 'b' });
  const rows = readJsonl(file);
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
});

test('readJsonl ignores an incomplete last line without rewriting', () => {
  const root = tmp();
  const file = path.join(root, 'training', 'evaluations.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"id":"a"}\n{"id":"partial"');
  assert.deepEqual(readJsonl(file), [{ id: 'a' }]);
  assert.match(fs.readFileSync(file, 'utf8'), /partial/);
});
