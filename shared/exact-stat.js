import fs from 'node:fs';

// #308: Windows file IDs run past 2^53 (on NTFS the high 16 bits are a sequence number), where a
// Number-valued stat rounds them, so two different files can read as one. These read one bigint
// stat and keep dev and ino exact (bigint), while every other field is the Number a plain stat
// gives: a caller compares identity exactly and keeps its size, nlink, mode and time arithmetic as
// it was. One stat call, so the fields and the identity always describe the same file. Both sides of
// a comparison come from here (or another bigint stat): a bigint stat hands dev and ino over as
// signed 64-bit values, so one past 2^63 reads negative, the same way on both sides.
const NUMBERS = ['mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks'];
const TIMES = ['atime', 'mtime', 'ctime', 'birthtime'];
const KINDS = ['isFile', 'isDirectory', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'];
const NS_PER_S = 1_000_000_000n;
// A plain stat's own formula (seconds × 1e3 + nanoseconds / 1e6) over the same (sec, nsec) pair the
// platform gives — nsec in [0, 1e9), so a time before 1970 has a negative sec and a positive nsec
// (BigInt division truncates toward zero) — so the result is the same double.
const msOf = (ns) => {
  let sec = ns / NS_PER_S;
  let nsec = ns % NS_PER_S;
  if (nsec < 0n) { sec -= 1n; nsec += NS_PER_S; }
  return Number(sec) * 1e3 + Number(nsec) / 1e6;
};

export function exactStat(big) {
  if (big === undefined) return undefined;
  const out = { dev: big.dev, ino: big.ino };
  for (const key of NUMBERS) out[key] = Number(big[key]);
  for (const key of TIMES) {
    out[`${key}Ms`] = msOf(big[`${key}Ns`]);
    out[`${key}Ns`] = big[`${key}Ns`];
  }
  for (const kind of KINDS) out[kind] = () => big[kind]();
  return Object.freeze(out);
}

export const lstatExact = (file, options = {}) => exactStat(fs.lstatSync(file, { ...options, bigint: true }));
export const statExact = (file, options = {}) => exactStat(fs.statSync(file, { ...options, bigint: true }));
export const fstatExact = (fd) => exactStat(fs.fstatSync(fd, { bigint: true }));
export const lstatExactAsync = async (file) => exactStat(await fs.promises.lstat(file, { bigint: true }));
export const handleStatExact = async (handle) => exactStat(await handle.stat({ bigint: true }));

// The Number a plain stat gives for a dev or ino this module read as bigint, for an identity that is
// hashed or persisted in that form. A plain stat converts the platform's unsigned 64-bit value to a
// double; a bigint stat hands the same bits over signed, so they are read back unsigned before the
// same conversion (both round to the nearest double, ties to even).
export const plainIdOf = (value) => (value === undefined ? undefined : Number(BigInt.asUintN(64, value)));
