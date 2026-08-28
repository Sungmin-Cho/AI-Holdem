import fs from 'node:fs';
import path from 'node:path';

// Game-directory archive (init vacate), not the per-hand writeHandArchive.

const RESULT_TAGS = new Set(['abort', 'win', 'lose']);
const HAND_FILE = /^hand-.*\.json$/;
const PARTIAL_NAME = /^\..+\.partial$/;
const PARTIAL_STAMP = /^\.(\d{8}T\d{6}Z)-.+\.partial$/;

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

export function listLiveEntries(gameDir, io = { fs, now }) {
  const disk = io.fs;
  let names;
  try {
    names = disk.readdirSync(gameDir);
  } catch {
    throwArchiveFailed();
  }
  return names.filter((name) => !isReservedName(name));
}

function readArchiveNames(gameDir, disk) {
  try {
    return disk.readdirSync(path.join(gameDir, 'archive'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throwArchiveFailed();
  }
}

function takenArchiveIds(names) {
  return new Set(names.filter((name) => !PARTIAL_NAME.test(name)));
}

function parsePartialStamp(name) {
  const match = PARTIAL_STAMP.exec(name);
  if (!match) return null;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function mkdirArchive(disk, dir, options) {
  try {
    disk.mkdirSync(dir, options);
  } catch {
    throwArchiveFailed();
  }
}

function renameOrFail(disk, from, to) {
  try {
    disk.renameSync(from, to);
  } catch {
    throwArchiveFailed();
  }
}

function moveLiveInto(gameDir, destDir, io) {
  const disk = io.fs;
  for (const name of listLiveEntries(gameDir, io)) {
    renameOrFail(disk, path.join(gameDir, name), path.join(destDir, name));
  }
}

function promotePartial(disk, gameDir, partialName, id) {
  renameOrFail(
    disk,
    path.join(gameDir, 'archive', partialName),
    path.join(gameDir, 'archive', id),
  );
  return `archive/${id}`;
}

export function closeOpenPartial(gameDir, io = { fs, now }) {
  const disk = io.fs;
  const names = readArchiveNames(gameDir, disk);
  if (names == null) return null;
  const partials = names.filter((name) => PARTIAL_NAME.test(name));
  if (partials.length === 0) return null;
  if (partials.length > 1) throwArchiveFailed();

  const partialName = partials[0];
  const partialDir = path.join(gameDir, 'archive', partialName);
  moveLiveInto(gameDir, partialDir, io);

  // Stamp from the partial name; tag from inner state.json. Parse miss → now + in-progress.
  const stamp = parsePartialStamp(partialName);
  const utcDate = stamp ?? io.now();
  const tag = stamp ? archiveTag(readState(partialDir, disk)) : 'in-progress';
  const id = formatArchiveId(utcDate, tag, takenArchiveIds(names));
  return promotePartial(disk, gameDir, partialName, id);
}

export function vacateLive(gameDir, io = { fs, now }) {
  const disk = io.fs;
  if (!shouldArchive(gameDir, io)) {
    for (const name of listLiveEntries(gameDir, io)) {
      try {
        disk.rmSync(path.join(gameDir, name), { recursive: true, force: true });
      } catch {
        throwArchiveFailed();
      }
    }
    return null;
  }

  const archiveDir = path.join(gameDir, 'archive');
  mkdirArchive(disk, archiveDir, { recursive: true });
  const names = readArchiveNames(gameDir, disk) ?? [];
  const tag = archiveTag(readState(gameDir, disk));
  const id = formatArchiveId(io.now(), tag, takenArchiveIds(names));
  const partialName = `.${id}.partial`;
  mkdirArchive(disk, path.join(archiveDir, partialName));
  moveLiveInto(gameDir, path.join(archiveDir, partialName), io);
  return promotePartial(disk, gameDir, partialName, id);
}
