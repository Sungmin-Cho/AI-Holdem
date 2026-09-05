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
import { skipOnWin32 } from './helpers/platform.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tstore-'));
}

test('ensureDir creates 0700 and refuses symlink or non-directory', (t) => {
  if (skipOnWin32(t, 'unix mode bits and symlink refusal are POSIX')) return;
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

test('writeJsonSecure is 0600, O_NOFOLLOW, and refuses symlink targets', (t) => {
  if (skipOnWin32(t, 'unix mode bits and symlink refusal are POSIX')) return;
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

test('openContained refuses a symlink at the final path', (t) => {
  if (skipOnWin32(t, 'symlink fixtures require POSIX privilege semantics')) return;
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

test('writeContained create is 0600 and parent dir stays 0700', (t) => {
  if (skipOnWin32(t, 'unix mode bits are POSIX')) return;
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

test('writeContained rejects the same bad segments as openContained', () => {
  const root = containedRoot();
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
      () => writeContained(root, segments, 'x', { mode: 'create' }),
      { code: 'BAD_SEGMENT' },
      `expected BAD_SEGMENT for ${JSON.stringify(segments)}`,
    );
  }
});

test('writeContained create never calls rename', () => {
  const root = containedRoot();
  const origRename = fs.renameSync;
  let renamed = false;
  fs.renameSync = (...args) => {
    renamed = true;
    return origRename(...args);
  };
  try {
    writeContained(root, ['fresh.json'], 'x', { mode: 'create' });
    assert.equal(renamed, false);
    assert.throws(
      () => writeContained(root, ['fresh.json'], 'y', { mode: 'create' }),
      { code: 'EXISTS' },
    );
    assert.equal(renamed, false);
    assert.equal(fs.readFileSync(path.join(root, 'fresh.json'), 'utf8'), 'x');
  } finally {
    fs.renameSync = origRename;
  }
});

test('writeContained does not chmod dest by path after publish', (t) => {
  if (skipOnWin32(t, 'unix mode bits are POSIX')) return;
  const root = containedRoot();
  const origChmod = fs.chmodSync;
  fs.chmodSync = () => {
    throw new Error('path chmod after publish is a containment hole');
  };
  try {
    writeContained(root, ['mode.json'], 'ok', { mode: 'create' });
  } finally {
    fs.chmodSync = origChmod;
  }
  assert.equal(fs.lstatSync(path.join(root, 'mode.json')).mode & 0o777, 0o600);
});

test('writeContained wipes tmp when writeFileSync fails before publish', () => {
  const root = containedRoot();
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (target, data, ...rest) => {
    if (typeof target === 'number') {
      throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    }
    return origWrite(target, data, ...rest);
  };
  try {
    assert.throws(
      () => writeContained(root, ['write.json'], 'payload', { mode: 'replace' }),
      { code: 'EIO' },
    );
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.equal(fs.existsSync(path.join(root, 'write.json')), false);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp')), []);
});

test('writeContained create EEXIST leaves no tmp beside the original dest', () => {
  const root = containedRoot();
  const dest = path.join(root, 'keep.json');
  fs.writeFileSync(dest, 'original', { mode: 0o600 });
  assert.throws(
    () => writeContained(root, ['keep.json'], 'overwrite', { mode: 'create' }),
    { code: 'EXISTS' },
  );
  assert.equal(fs.readFileSync(dest, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp')), []);
});

function assertNoPayload(root, outside) {
  assert.deepEqual(fs.readdirSync(outside), []);
  function collectFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) out.push(...collectFiles(full));
      else if (st.isFile()) out.push(full);
    }
    return out;
  }
  for (const file of collectFiles(root)) {
    assert.equal(
      fs.readFileSync(file, 'utf8').includes('payload'),
      false,
      `leftover payload in ${file}`,
    );
  }
}

function installPostReinspectSwap(nested, outside) {
  const origRename = fs.renameSync;
  const origLink = fs.linkSync;
  const swapOnce = () => {
    const st = fs.lstatSync(nested);
    if (st.isSymbolicLink()) return;
    origRename(nested, `${nested}.real`);
    fs.symlinkSync(outside, nested);
  };
  fs.renameSync = (...args) => {
    swapOnce();
    return origRename(...args);
  };
  fs.linkSync = (...args) => {
    swapOnce();
    return origLink(...args);
  };
  return () => {
    fs.renameSync = origRename;
    fs.linkSync = origLink;
  };
}

test('writeContained wipes payload if parent swaps after reinspect before publish', () => {
  const root = containedRoot();
  const nested = path.join(root, 'a');
  fs.mkdirSync(nested, { mode: 0o700 });
  const outside = tmp();
  const restore = installPostReinspectSwap(nested, outside);
  try {
    assert.throws(
      () => writeContained(root, ['a', 'out.json'], 'payload', { mode: 'replace' }),
    );
  } finally {
    restore();
  }
  assertNoPayload(root, outside);
});

test('writeContained create-mode wipes payload if parent swaps after reinspect before link', () => {
  const root = containedRoot();
  const nested = path.join(root, 'a');
  fs.mkdirSync(nested, { mode: 0o700 });
  const outside = tmp();
  const restore = installPostReinspectSwap(nested, outside);
  try {
    assert.throws(
      () => writeContained(root, ['a', 'out.json'], 'payload', { mode: 'create' }),
    );
  } finally {
    restore();
  }
  assertNoPayload(root, outside);
});

test('writeContained wipes tmp when fsync fails before publish', () => {
  const root = containedRoot();
  const origFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' });
  };
  try {
    assert.throws(
      () => writeContained(root, ['fsync.json'], 'payload', { mode: 'replace' }),
      { code: 'EIO' },
    );
  } finally {
    fs.fsyncSync = origFsync;
  }
  assert.equal(fs.existsSync(path.join(root, 'fsync.json')), false);
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('openContained returns only bytes actually read on short read', () => {
  const root = containedRoot();
  fs.writeFileSync(path.join(root, 'short.json'), 'ABCDEFGH');
  const origRead = fs.readSync;
  let calls = 0;
  fs.readSync = (fd, buffer, offset, length, position) => {
    calls += 1;
    if (calls === 1) {
      buffer[offset] = 65;
      return 1;
    }
    return 0;
  };
  try {
    const got = openContained(root, ['short.json'], { maxBytes: 4096 });
    assert.equal(got.toString('utf8'), 'A');
    assert.equal(got.length, 1);
  } finally {
    fs.readSync = origRead;
  }
});

test('writeContained rejects parent-swap between inspect and reinspect', (t) => {
  if (skipOnWin32(t, 'parent-swap TOCTOU fixture uses POSIX rename/symlink')) return;
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
  function collectFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) out.push(...collectFiles(full));
      else if (st.isFile()) out.push(full);
    }
    return out;
  }
  for (const file of collectFiles(root)) {
    assert.equal(
      fs.readFileSync(file, 'utf8').includes('payload'),
      false,
      `leftover payload in ${file}`,
    );
  }
});
