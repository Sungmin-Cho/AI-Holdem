import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { exactStat, lstatExact, statExact, fstatExact, lstatExactAsync, handleStatExact, plainIdOf } from '../shared/exact-stat.js';

const NUMBERS = ['mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'];

function assertSameAsPlain(exact, plain, big) {
  for (const key of NUMBERS) {
    assert.equal(typeof exact[key], 'number', key);
    assert.equal(exact[key], plain[key], key);
  }
  assert.equal(exact.dev, big.dev);
  assert.equal(exact.ino, big.ino);
  assert.equal(typeof exact.ino, 'bigint');
  for (const kind of KINDS) assert.equal(exact[kind](), plain[kind](), kind);
  assert.equal(Object.isFrozen(exact), true);
}

test('#308: an exact stat keeps dev and ino as bigint and every other field as a plain stat gives it', async () => {
  const root = createOwnedTempDir('holdem-exact-stat');
  const file = path.join(root, 'record');
  fs.writeFileSync(file, 'x'.repeat(1234));
  const link = path.join(root, 'link');
  fs.symlinkSync(file, link);
  assertSameAsPlain(lstatExact(file), fs.lstatSync(file), fs.lstatSync(file, { bigint: true }));
  assertSameAsPlain(lstatExact(root), fs.lstatSync(root), fs.lstatSync(root, { bigint: true }));
  assertSameAsPlain(lstatExact(link), fs.lstatSync(link), fs.lstatSync(link, { bigint: true }));
  assertSameAsPlain(statExact(link), fs.statSync(link), fs.statSync(link, { bigint: true }));
  const fd = fs.openSync(file, 'r');
  try { assertSameAsPlain(fstatExact(fd), fs.fstatSync(fd), fs.fstatSync(fd, { bigint: true })); }
  finally { fs.closeSync(fd); }
  assertSameAsPlain(await lstatExactAsync(file), fs.lstatSync(file), fs.lstatSync(file, { bigint: true }));
  const handle = await fs.promises.open(file, 'r');
  try { assertSameAsPlain(await handleStatExact(handle), fs.lstatSync(file), fs.lstatSync(file, { bigint: true })); }
  finally { await handle.close(); }
  assert.equal(lstatExact(path.join(root, 'absent'), { throwIfNoEntry: false }), undefined);
  assert.throws(() => lstatExact(path.join(root, 'absent')), { code: 'ENOENT' });
});

test('#308: two file IDs past 2^53 that a plain stat reads as one stay two', () => {
  // The Windows ID behind 19e7900's mismatch (seen exactly, and as a Number one below it).
  const recorded = 21673573207008061n;
  assert.equal(Number(recorded), 21673573207008060);
  assert.equal(Number(recorded), Number(recorded - 1n), 'a plain stat cannot tell these apart');
  const big = (ino) => ({
    dev: 7n, ino, mode: 16877n, nlink: 1n, uid: 0n, gid: 0n, rdev: 0n, size: 0n, blksize: 4096n, blocks: 0n,
    atimeNs: 0n, mtimeNs: 0n, ctimeNs: 0n, birthtimeNs: 0n,
    isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, isFIFO: () => false,
    isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
  });
  const a = exactStat(big(recorded));
  const b = exactStat(big(recorded - 1n));
  assert.notEqual(a.ino, b.ino);
  assert.equal(a.dev, b.dev);
});

test('#308: an exact stat computes millisecond times with a plain stat\'s formula', () => {
  const at = (ns) => exactStat({
    dev: 1n, ino: 1n, mode: 0n, nlink: 1n, uid: 0n, gid: 0n, rdev: 0n, size: 0n, blksize: 0n, blocks: 0n,
    atimeNs: ns, mtimeNs: ns, ctimeNs: ns, birthtimeNs: ns,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => false,
    isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
  });
  // sec * 1e3 + nsec / 1e6, as lib/internal/fs/utils.js msFromTimeSpec, over the platform's
  // (sec, nsec) with nsec in [0, 1e9) — before 1970 sec is negative and nsec is not.
  for (const [sec, nsec] of [
    [1_760_000_000, 123_456_789], [0, 1], [1_760_000_000, 999_999_999],
    [-2, 500_000_000], [-1, 999_999_999], [-1, 1], [-1_000_000, 123_456_789], [-1_000_000, 0],
  ]) {
    const ns = BigInt(sec) * 1_000_000_000n + BigInt(nsec);
    assert.equal(at(ns).mtimeMs, sec * 1e3 + nsec / 1e6, `${sec}s ${nsec}ns`);
    assert.equal(at(ns).mtimeNs, ns);
  }
});

test('#308: an identity hashed in its plain-stat form reads the platform\'s unsigned value', () => {
  // A plain stat converts the unsigned 64-bit value to a double; a bigint stat hands the same bits
  // over signed, so a value past 2^63 reads negative there.
  const cases = [
    [0n, 0], [12_345n, 12_345], [2n ** 53n + 1n, 2 ** 53], [21673573207008061n, 21673573207008060],
    [2n ** 63n - 1n, 2 ** 63], [-(2n ** 63n), 2 ** 63], [-(2n ** 63n) + 1025n, 2 ** 63 + 2048], [-1n, 2 ** 64],
  ];
  for (const [signed, plain] of cases) assert.equal(plainIdOf(signed), plain, String(signed));
  assert.equal(plainIdOf(undefined), undefined);
  // On a real file it is the plain stat's own value.
  const root = createOwnedTempDir('holdem-exact-stat-plain');
  for (const target of [root, path.join(root, 'f')]) {
    if (target !== root) fs.writeFileSync(target, 'x');
    const exact = lstatExact(target);
    const plain = fs.lstatSync(target);
    assert.equal(plainIdOf(exact.ino), plain.ino);
    assert.equal(plainIdOf(exact.dev), plain.dev);
  }
});
