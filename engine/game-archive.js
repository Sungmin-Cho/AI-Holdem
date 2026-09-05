import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGame } from './hand.js';
import { generatePersonas } from './personas.js';
import {
  processStartTime, readOwnedLock, runExclusive, saveState, writeJsonAtomic,
} from './state.js';

// Game-directory archive (init vacate), not the per-hand writeHandArchive.

const RESULT_TAGS = new Set(['abort', 'win', 'lose', 'completed']);
const HAND_FILE = /^hand-.*\.json$/;
const PARTIAL_NAME = /^\..+\.partial$/;
const PARTIAL_STAMP = /^\.(\d{8}T\d{6}Z)-.+\.partial$/;

const sleepLock = new Int32Array(new SharedArrayBuffer(4));

function now() {
  return new Date();
}

function sleepSync(ms) {
  Atomics.wait(sleepLock, 0, 0, ms);
}

function clockMs(clock) {
  const value = clock();
  return typeof value === 'number' ? value : value.getTime();
}

function throwCoded(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function assertNotSessionCatalogTarget(gameDir) {
  let resolved = path.resolve(gameDir);
  try { resolved = fs.realpathSync.native(resolved); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (fs.existsSync(path.join(resolved, '.session-store'))) {
    throwCoded('BAD_DIRECTORY_MODE', 'session store root는 archive 대상으로 사용할 수 없습니다.');
  }
  const parts = resolved.split(path.sep);
  const catalogIndex = parts.lastIndexOf('.session-store');
  if (catalogIndex < 0) return;
  const relative = parts.slice(catalogIndex + 1);
  if (relative.length === 0 || relative[0] !== 'sessions' || relative.length === 1) {
    throwCoded('BAD_DIRECTORY_MODE', 'session catalog은 archive 대상으로 사용할 수 없습니다.');
  }
  const sessionName = relative[1];
  if (/^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.creating$/.test(sessionName) && relative.length === 2) return;
  throwCoded('BAD_DIRECTORY_MODE', '관리되는 session directory는 archive 대상으로 사용할 수 없습니다.');
}

function assertLoopAllowsInit(gameDir, callerPpid, force, startTimeOf = processStartTime) {
  const loop = readOwnedLock(gameDir, 'loop.lock.d', { processStartTime: startTimeOf });
  if (!loop || loop.status === 'dead') return;
  // The parent bypass is deliberately narrower than pid equality: it applies only
  // when pid+startTime positively prove that the caller's parent owns this lock.
  if (loop.status === 'alive' && loop.pid === callerPpid) return;
  throwCoded(
    force ? 'LOOP_ALIVE' : 'ACTIVE_GAME',
    force
      ? '게임 루프가 아직 실행 중입니다. 사이드카를 먼저 정지하세요.'
      : '이미 진행 중인 게임이 있습니다.',
  );
}

function waitWhileAlive(pid, alive, clock, sleep, timeoutMs, intervalMs) {
  const deadline = clockMs(clock) + timeoutMs;
  while (clockMs(clock) < deadline && alive(pid)) sleep(intervalMs);
}

export function throwArchiveFailed() {
  const error = new Error('직전 게임을 보관하지 못했습니다.');
  error.code = 'ARCHIVE_FAILED';
  throw error;
}

export function isReservedName(name) {
  return name === 'archive' || name === '.mutex' || name === '.session-store'
    || name === '.training' || name.endsWith('.lock.d');
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
  assertNotSessionCatalogTarget(gameDir);
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
  assertNotSessionCatalogTarget(gameDir);
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

export function readLock(gameDir, io = { fs }) {
  const disk = io.fs ?? fs;
  try {
    const lock = JSON.parse(disk.readFileSync(path.join(gameDir, 'lock.json'), 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function stopServer(pid, deps = {}) {
  const alive = deps.isAlive ?? isAlive;
  const kill = deps.kill ?? ((p, signal) => process.kill(p, signal));
  const beforeSignal = deps.beforeSignal ?? (() => {});
  const sleep = deps.sleepSync ?? sleepSync;
  const clock = deps.now ?? now;
  const startTimeOf = deps.processStartTime ?? processStartTime;
  const expectedStartTime = deps.expectedStartTime;

  if (typeof expectedStartTime !== 'string' || expectedStartTime.length === 0) return;
  if (!alive(pid)) return;
  const current = startTimeOf(pid);
  if (current !== expectedStartTime) return;
  beforeSignal(pid, 'SIGTERM');
  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  waitWhileAlive(pid, alive, clock, sleep, 5000, 50);
  if (!alive(pid)) return;
  if (startTimeOf(pid) !== expectedStartTime) return;
  beforeSignal(pid, 'SIGKILL');
  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  waitWhileAlive(pid, alive, clock, sleep, 200, 20);
}

export function initGameDir(gameDir, flags, deps = {}) {
  assertNotSessionCatalogTarget(gameDir);
  const disk = deps.fs ?? fs;
  const alive = deps.isAlive ?? isAlive;
  const clock = deps.now ?? now;
  const callerPpid = deps.callerPpid ?? process.ppid;
  const startTimeOf = deps.processStartTime ?? processStartTime;
  const { aiCount, startStack, blinds0, levelEvery, force, mode, startStackBb, handLimit, opponentRuntime } = flags;

  // 살아 있는 남의 loop는 force로도 엔진이 죽이지 않는다 — 정지는 부트스트랩/롤백
  // 절차의 소관이다. loopPid == callerPpid(자신의 자식 init을 부른 사이드카)는
  // 활성으로 치지 않는다: 부트스트랩이 자기 락에 막히지 않기 위한 예외다.
  assertLoopAllowsInit(gameDir, callerPpid, force, startTimeOf);

  const lock = readLock(gameDir, { fs: disk });
  const live = Boolean(lock && alive(lock.serverPid));
  if (live && !force) throwCoded('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
  if (force && live) {
    // No server signal is authorized by a stale loop preflight. Re-read immediately
    // before the first possible signal; engine init never signals the loop pid.
    assertLoopAllowsInit(gameDir, callerPpid, force, startTimeOf);
    stopServer(lock.serverPid, {
      isAlive: alive,
      kill: deps.kill,
      beforeSignal: () => assertLoopAllowsInit(gameDir, callerPpid, force, startTimeOf),
      sleepSync: deps.sleepSync,
      now: clock,
      processStartTime: startTimeOf,
      expectedStartTime: lock.serverStartTime,
    });
    if (alive(lock.serverPid)) {
      throwCoded('SERVER_ALIVE', '게임 서버가 아직 종료되지 않았습니다.');
    }
  }

  return runExclusive(gameDir, () => {
    // Process waits stay outside this mutex, but the destructive archive/new-state
    // boundary gets its own fresh identity check after mutex acquisition.
    assertLoopAllowsInit(gameDir, callerPpid, force, startTimeOf);
    const io = { fs: disk, now: clock };
    const closed = closeOpenPartial(gameDir, io);
    const vacated = vacateLive(gameDir, io);
    const archivedTo = closed ?? vacated ?? null;

    const personas = generatePersonas(aiCount);
    const state = createGame({
      aiCount,
      startStack,
      blinds0,
      levelEvery,
      names: personas.map((persona) => persona.name),
      mode,
      startStackBb,
      handLimit,
    });
    if (opponentRuntime === 'policy') {
      state.policySeed = randomBytes(32).toString('hex');
    }
    const players = [
      { playerId: 'user', seat: 0, name: '나' },
      ...personas,
    ];
    writeJsonAtomic(path.join(gameDir, 'players.json'), players);
    saveState(gameDir, state);
    return {
      stateVersion: state.stateVersion,
      sessionToken: state.sessionToken,
      players: players.map((player) => ({ playerId: player.playerId, name: player.name })),
      archivedTo,
    };
  });
}
