import fs from 'node:fs';
import path from 'node:path';

// Game-directory archive (init vacate), not the per-hand writeHandArchive.

const RESULT_TAGS = new Set(['abort', 'win', 'lose']);
const HAND_FILE = /^hand-.*\.json$/;

function now() {
  return new Date();
}

export function throwArchiveFailed() {
  const error = new Error('직전 게임을 보관하지 못했습니다.');
  error.code = 'ARCHIVE_FAILED';
  throw error;
}

export function isReservedName(name) {
  return name === 'archive' || name === '.mutex' || name.endsWith('.lock.d');
}

export function archiveTag(state) {
  if (state?.gameOver === true && RESULT_TAGS.has(state.result)) return state.result;
  return 'in-progress';
}

export function formatArchiveId(utcDate, tag, taken) {
  const stamp = `${utcDate.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
  const safeTag = tag.includes('/') || tag.includes('\\') || tag.includes('\0')
    ? 'in-progress'
    : tag;
  const base = `${stamp}-${safeTag}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

export function shouldArchive(gameDir, io = { fs, now }) {
  const disk = io.fs;
  const state = readState(gameDir, disk);
  if (state && (state.handNo >= 1 || state.lastHand != null || state.hand != null)) return true;
  if (disk.existsSync(path.join(gameDir, 'review.md'))) return true;
  if (hasHandFiles(gameDir, disk)) return true;
  return disk.existsSync(path.join(gameDir, 'ui-snapshot.json'));
}

function readState(gameDir, disk) {
  try {
    return JSON.parse(disk.readFileSync(path.join(gameDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function hasHandFiles(gameDir, disk) {
  let names;
  try {
    names = disk.readdirSync(path.join(gameDir, 'hands'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throwArchiveFailed();
  }
  return names.some((name) => HAND_FILE.test(name));
}
