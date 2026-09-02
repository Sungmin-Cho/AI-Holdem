import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendJsonl,
  ensureDir,
  openContained,
  readJsonl,
  readJsonSecure,
  writeContained,
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

function containedRoot() {
  const root = tmp();
  fs.chmodSync(root, 0o700);
  return root;
}

test('openContained rejects parent-swap between inspect and reinspect', () => {
  const root = containedRoot();
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nested, 'secret.json'), 'inside');

  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.json'), 'pwned-outside');

  const origOpen = fs.openSync;
  fs.openSync = (p, flags, mode) => {
    fs.openSync = origOpen;
    const parent = path.join(root, 'a', 'b');
    const moved = `${parent}.real`;
    fs.renameSync(parent, moved);
    fs.symlinkSync(outside, parent);
    return origOpen(p, flags, mode);
  };
  try {
    assert.throws(
      () => openContained(root, ['a', 'b', 'secret.json'], { maxBytes: 4096 }),
      { code: 'UNSAFE_PATH' },
    );
  } finally {
    fs.openSync = origOpen;
  }
});

test('openContained refuses a symlink at the final path', () => {
  const root = containedRoot();
  const realFile = path.join(root, 'real.json');
  fs.writeFileSync(realFile, '{"ok":true}');
  fs.symlinkSync(realFile, path.join(root, 'link.json'));
  assert.throws(
    () => openContained(root, ['link.json'], { maxBytes: 4096 }),
    { code: 'UNSAFE_PATH' },
  );
});

test('openContained rejects .., absolute, empty, and separator segments', () => {
  const root = containedRoot();
  fs.writeFileSync(path.join(root, 'ok.json'), '{}');
  const cases = [
    ['..'],
    ['..', 'ok.json'],
    [path.join(root, 'ok.json')],
    [''],
    ['.'],
    ['a/b'],
    ['a\\b'],
    ['ok.json', ''],
  ];
  for (const segments of cases) {
    assert.throws(
      () => openContained(root, segments, { maxBytes: 4096 }),
      { code: 'BAD_SEGMENT' },
      `expected BAD_SEGMENT for ${JSON.stringify(segments)}`,
    );
  }
});

test('openContained refuses a file larger than maxBytes', () => {
  const root = containedRoot();
  fs.writeFileSync(path.join(root, 'big.json'), 'x'.repeat(64));
  assert.throws(
    () => openContained(root, ['big.json'], { maxBytes: 16 }),
    { code: 'TOO_LARGE' },
  );
});

test('writeContained create preserves an existing file and returns EXISTS', () => {
  const root = containedRoot();
  const dest = path.join(root, 'keep.json');
  fs.writeFileSync(dest, 'original', { mode: 0o600 });
  assert.throws(
    () => writeContained(root, ['keep.json'], 'overwrite', { mode: 'create' }),
    { code: 'EXISTS' },
  );
  assert.equal(fs.readFileSync(dest, 'utf8'), 'original');
});

test('writeContained create uses link so a TOCTOU exists-check cannot overwrite', () => {
  const root = containedRoot();
  const dest = path.join(root, 'keep.json');
  fs.writeFileSync(dest, 'original', { mode: 0o600 });
  const origExists = fs.existsSync;
  fs.existsSync = (p) => {
    if (p === dest) return false;
    return origExists(p);
  };
  try {
    assert.throws(
      () => writeContained(root, ['keep.json'], 'overwrite', { mode: 'create' }),
      { code: 'EXISTS' },
    );
    assert.equal(fs.readFileSync(dest, 'utf8'), 'original');
  } finally {
    fs.existsSync = origExists;
  }
});

test('writeContained cleans tmp and writes nothing outside root when replace fails', () => {
  const root = containedRoot();
  const sibling = tmp();
  const origRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error('injected rename failure'), { code: 'EXDEV' });
  };
  try {
    assert.throws(
      () => writeContained(root, ['out.json'], 'payload', { mode: 'replace' }),
      { code: 'EXDEV' },
    );
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(fs.existsSync(path.join(root, 'out.json')), false);
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp') || name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(sibling), []);
});

test('writeContained create is 0600 and parent dir stays 0700', () => {
  const root = containedRoot();
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { mode: 0o700 });
  writeContained(root, ['nested', 'file.json'], '{"ok":true}', { mode: 'create' });
  const fileSt = fs.lstatSync(path.join(nested, 'file.json'));
  const dirSt = fs.lstatSync(nested);
  assert.equal(fileSt.isFile(), true);
  assert.equal(fileSt.mode & 0o777, 0o600);
  assert.equal(dirSt.isDirectory(), true);
  assert.equal(dirSt.mode & 0o777, 0o700);
  assert.equal(
    openContained(root, ['nested', 'file.json'], { maxBytes: 4096 }).toString('utf8'),
    '{"ok":true}',
  );
});

test('writeContained replace overwrites dest and openContained reads the new bytes', () => {
  const root = containedRoot();
  writeContained(root, ['x.json'], 'first', { mode: 'create' });
  writeContained(root, ['x.json'], 'second', { mode: 'replace' });
  assert.equal(
    openContained(root, ['x.json'], { maxBytes: 4096 }).toString('utf8'),
    'second',
  );
});

test('writeContained rejects parent-swap between inspect and reinspect', () => {
  const root = containedRoot();
  const nested = path.join(root, 'a');
  fs.mkdirSync(nested, { mode: 0o700 });
  const outside = tmp();
  const origFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    origFsync.call(fs, fd);
    fs.fsyncSync = origFsync;
    const moved = `${nested}.real`;
    fs.renameSync(nested, moved);
    fs.symlinkSync(outside, nested);
  };
  try {
    assert.throws(
      () => writeContained(root, ['a', 'out.json'], 'payload', { mode: 'create' }),
      { code: 'UNSAFE_PATH' },
    );
  } finally {
    fs.fsyncSync = origFsync;
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});
