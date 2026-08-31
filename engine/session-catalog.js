import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireOwnedLock, releaseOwnedLock } from './state.js';

// Permanent per-game session directories plus an atomic "current" selector at the
// store root. A game never moves or is deleted when the next game is initialized:
// prepareSession stages a fresh sessions/<gameId> off to the side, commitSession
// promotes it with a same-parent rename and only then atomically repoints current.

const CATALOG_DIR = '.session-store';
const SESSIONS_DIR = 'sessions';
const CURRENT_FILE = 'current.json';
const TRANSACTION_LOCK = 'transaction.lock.d';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function catalogDirOf(storeDir) {
  return path.join(storeDir, CATALOG_DIR);
}

function codedError(code, message, extra = {}) {
  const error = new Error(message ?? code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sessionsDirOf(storeDir) {
  return path.join(catalogDirOf(storeDir), SESSIONS_DIR);
}

function currentPathOf(storeDir) {
  return path.join(catalogDirOf(storeDir), CURRENT_FILE);
}

// Reads the current selector without ever scanning sessions/. Absent selector is a
// normal empty-store state (null); anything else that isn't a well-formed, regular,
// non-symlink JSON file fails closed rather than being treated as "no session".
function readCurrentSelector(storeDir) {
  const selectorPath = currentPathOf(storeDir);
  let fd;
  try {
    fd = fs.openSync(selectorPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw codedError(
      'CURRENT_SELECTOR_INVALID',
      'current selector를 열 수 없습니다.',
      { cause: error },
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw codedError('CURRENT_SELECTOR_INVALID', 'current selector가 일반 파일이 아닙니다.');
    }
    const raw = fs.readFileSync(fd, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw codedError(
        'CURRENT_SELECTOR_INVALID',
        'current selector JSON이 올바르지 않습니다.',
        { cause: error },
      );
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || typeof parsed.gameId !== 'string'
      || !UUID_RE.test(parsed.gameId)
      || parsed.sessionRel !== `${SESSIONS_DIR}/${parsed.gameId}`
      || !Number.isSafeInteger(parsed.selectionVersion)
      || parsed.selectionVersion < 1
    ) {
      throw codedError('CURRENT_SELECTOR_INVALID', 'current selector 계약이 올바르지 않습니다.');
    }
    return {
      gameId: parsed.gameId,
      sessionDir: path.join(catalogDirOf(storeDir), ...parsed.sessionRel.split('/')),
      selectionVersion: parsed.selectionVersion,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function ensureSessionStore(storeDir) {
  const root = path.resolve(storeDir);
  fs.mkdirSync(catalogDirOf(root), { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionsDirOf(root), { recursive: true, mode: 0o700 });
  const current = readCurrentSelector(root);
  return { storeDir: root, sessionsDir: sessionsDirOf(root), current };
}

export function prepareSession(storeDir) {
  const root = path.resolve(storeDir);
  fs.mkdirSync(catalogDirOf(root), { recursive: true, mode: 0o700 });
  const sessionsDir = sessionsDirOf(root);
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const current = readCurrentSelector(root);
  const gameId = randomUUID();
  const sessionDir = path.join(sessionsDir, gameId);
  const stagingDir = path.join(sessionsDir, `.${gameId}.creating`);
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  const selectionVersion = (current?.selectionVersion ?? 0) + 1;
  return {
    gameId, sessionDir, stagingDir, selectionVersion,
  };
}

export function commitSession(storeDir, prepared) {
  const root = path.resolve(storeDir);
  const {
    gameId, sessionDir, stagingDir, selectionVersion,
  } = prepared;
  const transaction = acquireOwnedLock(catalogDirOf(root), TRANSACTION_LOCK);
  try {
    const expectedVersion = selectionVersion - 1;
    const current = readCurrentSelector(root);
    if ((current?.selectionVersion ?? 0) !== expectedVersion) {
      throw codedError('CURRENT_CHANGED', 'session current가 prepare 이후 변경되었습니다.');
    }
    const expectedSessionDir = path.join(sessionsDirOf(root), gameId);
    const expectedStagingDir = path.join(sessionsDirOf(root), `.${gameId}.creating`);
    if (sessionDir !== expectedSessionDir || stagingDir !== expectedStagingDir || !UUID_RE.test(gameId)) {
      throw codedError('SESSION_PREPARATION_INVALID', 'prepared session 경로가 store와 일치하지 않습니다.');
    }
    fs.renameSync(stagingDir, sessionDir);

    const selectorPath = currentPathOf(root);
    const payload = JSON.stringify({ gameId, sessionRel: `${SESSIONS_DIR}/${gameId}`, selectionVersion });
    const temp = path.join(catalogDirOf(root), `.${CURRENT_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, selectorPath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* absent or preserved original failure */ }
      throw error;
    }
  } finally {
    releaseOwnedLock(transaction);
  }
  return { gameId, sessionDir, selectionVersion };
}

export function resolveCurrentSession(storeDir) {
  const root = path.resolve(storeDir);
  const current = readCurrentSelector(root);
  if (!current) return null;
  let stat;
  try { stat = fs.lstatSync(current.sessionDir); } catch (error) {
    throw codedError('CURRENT_SELECTOR_INVALID', 'current session directory가 없습니다.', { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError('CURRENT_SELECTOR_INVALID', 'current session이 실제 directory가 아닙니다.');
  }
  return current;
}
