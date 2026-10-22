import fs from 'node:fs';

// #308: two file IDs of Windows size that a Number-valued stat reads as one — the ID behind
// 19e7900's mismatch, and its neighbour. As bigint they differ; as Number both are
// 21673573207008060.
export const FAR = 21673573207008061n;
export const NEAR = FAR - 1n;

function withIno(st, ino) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
  copy.ino = typeof st.ino === 'bigint' ? ino : Number(ino);
  return copy;
}

// Makes the file at `target` read with another identity through `fsImpl`'s stat calls, as if the
// path and an open descriptor named two files whose IDs only differ past 2^53: lstat/stat of the
// path read `pathIno(n)` (n counts those calls) and fstat of a descriptor open on it reads
// `fdIno(n)`. A bigint stat sees the two IDs; a Number stat sees one. Returns a restore function.
export function collideIdentity(target, { pathIno, fdIno = pathIno }, fsImpl = fs) {
  const real = fsImpl.lstatSync(target, { bigint: true });
  // A Number stat of the target carries its IDs rounded (Windows IDs run past 2^53), so it is told
  // by the rounded values; a bigint stat by the exact ones.
  const isTarget = (st) => Boolean(st) && (typeof st.ino === 'bigint'
    ? st.dev === real.dev && st.ino === real.ino
    : st.dev === Number(real.dev) && st.ino === Number(real.ino));
  const counts = { path: 0, fd: 0 };
  const original = { lstatSync: fsImpl.lstatSync, statSync: fsImpl.statSync, fstatSync: fsImpl.fstatSync };
  const wrap = (name, kind) => function patched(...args) {
    const st = original[name].apply(this, args);
    if (!isTarget(st)) return st;
    const n = counts[kind]++;
    return withIno(st, kind === 'fd' ? fdIno(n) : pathIno(n));
  };
  fsImpl.lstatSync = wrap('lstatSync', 'path');
  fsImpl.statSync = wrap('statSync', 'path');
  fsImpl.fstatSync = wrap('fstatSync', 'fd');
  return Object.assign(() => { Object.assign(fsImpl, original); }, { counts });
}
