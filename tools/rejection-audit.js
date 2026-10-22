// #274: the durable audit of relay refusals the publisher retired (`.publish-rejections.jsonl`).
// The publisher appends under its publish lock before it removes the refused attempt; the
// training control reads it before it settles the queue. Both sides go through here.
//
// Reads and writes are bounded and refuse anything that is not a regular, single-link,
// non-symlink file directly inside the game directory. Only a missing log reads as empty;
// every other failure throws, so a transient read error can never erase earlier evidence.
// A write goes to an unpredictable, exclusively created temporary file, is fsynced, installed
// by rename only if the log is still the one that was read, and the directory is fsynced
// (POSIX) before the caller may remove the attempt.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_PUBLISH_BODY_BYTES, MAX_PUBLISH_ID } from '../publish-contract.js';
import { exactStat } from '../shared/exact-stat.js';

export const REJECTION_LOG = '.publish-rejections.jsonl';
export const REJECTION_LOG_MAX_LINES = 200;
export const REJECTION_LOG_MAX_BYTES = 512 * 1024;
// One audit line names every item of one refused body (evaluationId, field, valueSha256 —
// exactly the annotationAuthority items the publisher sent, which the shared body budget
// already bounds). The cap is therefore the body cap: every body the relay could have judged
// has an audit line that fits, and the log (REJECTION_LOG_MAX_BYTES) keeps at least eight of
// them. The pipeline also sizes each batch against this cap (rejectionRecordByteLength) so the
// contract does not depend on the arithmetic alone.
export const REJECTION_LINE_MAX_BYTES = MAX_PUBLISH_BODY_BYTES;
const LINE_MAX_BYTES = REJECTION_LINE_MAX_BYTES;
// The recorded attempt a retirement resends: its body is bounded by MAX_PUBLISH_BODY_BYTES and
// each authority it carries by the same budget; this is the same bound the training control
// reads it with (recordedAttemptSha256).
export const ATTEMPT_RECORD_MAX_BYTES = 1_000_000;
export const ATTEMPT_RECORD = '.publish-attempt.json';
const FILE_MODE = 0o600;

/** Byte length of the audit line a refusal of a body with these authority items would need. */
export function rejectionRecordByteLength(items) {
  return Buffer.byteLength(JSON.stringify({
    schemaVersion: 1,
    at: '2026-01-01T00:00:00.000Z',
    publishId: MAX_PUBLISH_ID,
    expectedGameEpoch: 'f'.repeat(64),
    bodySha256: 'f'.repeat(64),
    httpStatus: 599,
    serverCode: 'X'.repeat(64),
    items,
  }), 'utf8');
}
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

function auditError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  // Only a closed errno/syscall pair travels with it, never a path or text.
  if (cause?.code && /^E[A-Z]{2,15}$/.test(cause.code)) error.causeCode = cause.code;
  return error;
}

// Every stat here asks its fs for bigint and keeps dev and ino exact (#308): a Number-valued ino past
// 2^53 (Windows) can match a replacement. The other fields stay the Numbers a plain stat gives.
const lstatOf = (fsImpl, file) => exactStat(fsImpl.lstatSync(file, { bigint: true }));
const fstatOf = (fsImpl, fd) => exactStat(fsImpl.fstatSync(fd, { bigint: true }));

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function inspectDir(fsImpl, dir) {
  let st;
  try {
    st = lstatOf(fsImpl, dir);
  } catch (error) {
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', 'game 디렉터리를 확인할 수 없습니다.', error);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw auditError('REJECTION_AUDIT_UNSAFE', 'game 디렉터리가 안전하지 않습니다.');
  }
  return st;
}

function assertDirUnchanged(fsImpl, dir, pinned) {
  const now = inspectDir(fsImpl, dir);
  if (!sameFile(now, pinned)) {
    throw auditError('REJECTION_AUDIT_UNSAFE', 'game 디렉터리가 교체됐습니다.');
  }
}

function assertSafeLogStat(st, maxBytes = REJECTION_LOG_MAX_BYTES) {
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 로그가 안전한 단일 링크 일반 파일이 아닙니다.');
  }
  if (st.size > maxBytes) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 로그가 상한을 넘습니다.');
  }
}

// Returns { raw, stat } — stat null when the file does not exist yet.
function readLogPinned(fsImpl, dir, dirStat, name = REJECTION_LOG, maxBytes = REJECTION_LOG_MAX_BYTES) {
  const file = path.join(dir, name);
  let before;
  try {
    before = lstatOf(fsImpl, file);
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: '', stat: null };
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 로그를 확인할 수 없습니다.', error);
  }
  assertSafeLogStat(before, maxBytes);
  let fd;
  try {
    try {
      fd = fsImpl.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    } catch (error) {
      if (error.code === 'ELOOP' || error.code === 'EMLINK' || error.code === 'EISDIR') {
        throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 로그가 안전하지 않습니다.');
      }
      // A log that vanished between lstat and open is a race, not an absence.
      throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 로그를 열 수 없습니다.', error);
    }
    const st = fstatOf(fsImpl, fd);
    assertSafeLogStat(st, maxBytes);
    if (!sameFile(st, before)) throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 로그가 읽는 중 교체됐습니다.');
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = fsImpl.readSync(fd, buf, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== st.size) throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 로그를 끝까지 읽지 못했습니다.');
    assertDirUnchanged(fsImpl, dir, dirStat);
    return { raw: buf.toString('utf8'), stat: st };
  } catch (error) {
    if (error.code?.startsWith?.('REJECTION_AUDIT_')) throw error;
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 로그를 읽을 수 없습니다.', error);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* read already settled */ }
    }
  }
}

function linesOf(raw) {
  return raw.split('\n').filter((line) => line.length > 0);
}

/**
 * The recorded publish attempt, read the way the audit log is read: lstat preinspection (a
 * regular, single-link, non-symlink file within the byte bound) BEFORE any open; the open with
 * O_NOFOLLOW|O_NONBLOCK so a FIFO without a writer, a device or a replaced link can never block
 * this process's event loop; then the fstat identity/type/link/size recheck, a bounded read and
 * the directory-identity recheck. Returns { absent: true, raw: null } only for a true ENOENT at
 * preinspection; { absent: false, raw } for a safely read file; throws REJECTION_AUDIT_UNSAFE
 * (special file, link, hard link, oversize, replaced during the read) or
 * REJECTION_AUDIT_UNAVAILABLE (any other failure) — an entry in doubt is never "absent", and the
 * caller must neither send, dispose nor remove anything on it. Windows: O_NOFOLLOW/O_NONBLOCK
 * are 0 there (no FIFOs; symlinks and reparse points are refused by the lstat preinspection).
 */
export function readRecordedAttempt(dir, { fsImpl = fs, maxBytes = ATTEMPT_RECORD_MAX_BYTES } = {}) {
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat } = readLogPinned(fsImpl, dir, dirStat, ATTEMPT_RECORD, maxBytes);
  if (stat === null) return { absent: true, raw: null };
  return { absent: false, raw };
}

/** Parsed audit rows; a line that does not parse is not evidence and is skipped. */
export function readRejectionRecords(dir, { fsImpl = fs } = {}) {
  const dirStat = inspectDir(fsImpl, dir);
  const { raw } = readLogPinned(fsImpl, dir, dirStat);
  const rows = [];
  for (const line of linesOf(raw)) {
    try { rows.push(JSON.parse(line)); } catch { /* not evidence */ }
  }
  return rows;
}

// Directory fsync makes the rename (and a later unlink) durable on POSIX. Windows cannot open a
// directory for fsync from Node; there the rename is as durable as NTFS metadata journaling
// makes it, which this module records as a known limitation instead of failing every retire.
function fsyncDir(fsImpl, dir, platform) {
  if (platform === 'win32') return;
  let fd;
  try {
    fd = fsImpl.openSync(dir, fs.constants.O_RDONLY);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', 'game 디렉터리를 동기화하지 못했습니다.', error);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* fsync result already known */ }
    }
  }
}

function unlinkTmpIfOurs(fsImpl, tmp, tmpStat) {
  try {
    const st = lstatOf(fsImpl, tmp);
    if (!st.isSymbolicLink() && st.isFile() && sameFile(st, tmpStat)) fsImpl.unlinkSync(tmp);
  } catch { /* never unlink a path that is no longer ours */ }
}

// Install `text` as `name` only over the exact file that was read (`expected`, or into its
// absence when null): an unpredictable, exclusively created temporary file is fsynced, renamed
// over the target only if it is still the one that was read, and the directory is fsynced.
// A concurrent writer or a swapped target makes this fail instead of losing what it held.
function installPinned(fsImpl, dir, dirStat, name, text, expected, { platform, onStep }) {
  const file = path.join(dir, name);
  const tmp = path.join(dir, `${name}.${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  let tmpStat = null;
  let installed = false;
  try {
    try {
      fd = fsImpl.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, FILE_MODE);
    } catch (error) {
      throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 임시 파일을 만들 수 없습니다.', error);
    }
    tmpStat = fstatOf(fsImpl, fd);
    if (!tmpStat.isFile() || tmpStat.nlink !== 1) {
      throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 임시 파일이 안전하지 않습니다.');
    }
    fsImpl.writeFileSync(fd, text);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    onStep?.('tmp-synced');
    assertDirUnchanged(fsImpl, dir, dirStat);
    const tmpNow = lstatOf(fsImpl, tmp);
    if (tmpNow.isSymbolicLink() || !tmpNow.isFile() || tmpNow.nlink !== 1 || !sameFile(tmpNow, tmpStat)) {
      throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 임시 파일이 교체됐습니다.');
    }
    let current = null;
    try { current = lstatOf(fsImpl, file); } catch (error) {
      if (error.code !== 'ENOENT') throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 파일을 확인할 수 없습니다.', error);
    }
    if ((expected === null) !== (current === null)
      || (current && (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
        || !sameFile(current, expected) || current.size !== expected.size
        || current.mtimeMs !== expected.mtimeMs))) {
      throw auditError('REJECTION_AUDIT_CHANGED', '거절 감사 파일이 쓰는 중 바뀌었습니다.');
    }
    fsImpl.renameSync(tmp, file);
    installed = true;
    onStep?.('installed');
    fsyncDir(fsImpl, dir, platform);
    onStep?.('dir-synced');
    const after = lstatOf(fsImpl, file);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameFile(after, tmpStat)) {
      throw auditError('REJECTION_AUDIT_CHANGED', '거절 감사 파일이 설치 직후 바뀌었습니다.');
    }
  } catch (error) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* already failing */ }
    }
    if (!installed && tmpStat) unlinkTmpIfOurs(fsImpl, tmp, tmpStat);
    if (error.code?.startsWith?.('REJECTION_AUDIT_')) throw error;
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', '거절 감사 파일을 쓰지 못했습니다.', error);
  }
}

/**
 * Append one record durably. Throws (and leaves the log as it was) on any unsafe target,
 * read failure, concurrent change or I/O failure. Hooks: `onStep(name)` is called at each
 * ordered boundary ('tmp-synced', 'installed', 'dir-synced') for tests.
 */
export function appendRejectionRecord(dir, record, {
  fsImpl = fs, platform = process.platform, onStep = null,
} = {}) {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') > LINE_MAX_BYTES || line.includes('\n')) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '거절 감사 기록이 상한을 넘습니다.');
  }
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat: logStat } = readLogPinned(fsImpl, dir, dirStat);
  let lines = linesOf(raw);
  lines.push(line);
  if (lines.length > REJECTION_LOG_MAX_LINES) lines = lines.slice(-REJECTION_LOG_MAX_LINES);
  let text = `${lines.join('\n')}\n`;
  while (Buffer.byteLength(text, 'utf8') > REJECTION_LOG_MAX_BYTES && lines.length > 1) {
    lines = lines.slice(1);
    text = `${lines.join('\n')}\n`;
  }
  installPinned(fsImpl, dir, dirStat, REJECTION_LOG, text, logStat, { platform, onStep });
}

// #274 recovery boundary: the private evidence of the one retirement in flight
// (`.publish-retirement.json`, mode 0600, never shown to a host). It holds what the digest-only
// audit line cannot: the exact retired body and annotation authority, and the relay identity
// (pid, start time, port, game epoch — never its token) the publisher verified around the
// refusal. The publisher installs it before the audit line and before it removes the attempt;
// the training control settles the queue from it — also after an interruption that left the
// attempt already gone — and only then removes it. One at a time: a retirement of another
// body is refused while an unsettled one is on disk.
export const RETIREMENT_EVIDENCE = '.publish-retirement.json';
export const RETIREMENT_EVIDENCE_MAX_BYTES = 256 * 1024;

/**
 * The parsed evidence, or null ONLY when no evidence file exists (ENOENT). A file that exists
 * but holds anything other than a JSON object — null, false, 0, an empty string, an array,
 * malformed text — is not "absent": it throws, and every caller fails closed on it, so no
 * publication can be authorized by evidence that was blanked rather than settled.
 */
export function readRetirementEvidence(dir, { fsImpl = fs } = {}) {
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat } = readLogPinned(fsImpl, dir, dirStat, RETIREMENT_EVIDENCE, RETIREMENT_EVIDENCE_MAX_BYTES);
  if (stat === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw auditError('REJECTION_AUDIT_UNSAFE', '비공개 폐기 증거가 JSON이 아닙니다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '비공개 폐기 증거가 JSON 객체가 아닙니다.');
  }
  return parsed;
}

/**
 * Install the evidence of a retirement durably. A same-body evidence (a retried retirement of
 * the same attempt) is replaced; evidence of any other body is still unsettled and refuses.
 */
export function writeRetirementEvidence(dir, evidence, {
  fsImpl = fs, platform = process.platform, onStep = null,
} = {}) {
  const text = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(text, 'utf8') > RETIREMENT_EVIDENCE_MAX_BYTES) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '비공개 폐기 증거가 상한을 넘습니다.');
  }
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat } = readLogPinned(fsImpl, dir, dirStat, RETIREMENT_EVIDENCE, RETIREMENT_EVIDENCE_MAX_BYTES);
  if (stat !== null) {
    let previous = null;
    try { previous = JSON.parse(raw); } catch { /* unreadable: never overwritten */ }
    if (previous?.bodySha256 !== evidence?.bodySha256) {
      throw auditError('REJECTION_EVIDENCE_PENDING', '정리되지 않은 다른 폐기 증거가 남아 있습니다.');
    }
  }
  installPinned(fsImpl, dir, dirStat, RETIREMENT_EVIDENCE, text, stat, { platform, onStep });
}

/**
 * Remove the evidence of `bodySha256` durably once what it proves is settled. Missing is fine;
 * evidence of another body is left alone (false); anything unsafe or unreadable throws.
 */
export function removeRetirementEvidence(dir, bodySha256, { fsImpl = fs, platform = process.platform } = {}) {
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat } = readLogPinned(fsImpl, dir, dirStat, RETIREMENT_EVIDENCE, RETIREMENT_EVIDENCE_MAX_BYTES);
  if (stat === null) return true;
  let previous = null;
  try { previous = JSON.parse(raw); } catch { /* not ours to remove */ }
  if (previous?.bodySha256 !== bodySha256) return false;
  assertDirUnchanged(fsImpl, dir, dirStat);
  const now = lstatOf(fsImpl, path.join(dir, RETIREMENT_EVIDENCE));
  if (now.isSymbolicLink() || !now.isFile() || now.nlink !== 1 || !sameFile(now, stat)
    || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
    throw auditError('REJECTION_AUDIT_CHANGED', '비공개 폐기 증거가 지우는 중 바뀌었습니다.');
  }
  removeDurably(dir, RETIREMENT_EVIDENCE, { fsImpl, platform });
  return true;
}

/**
 * #274: make the recorded attempt a retirement depends on durable before the evidence is
 * installed. The attempt is written by the ordinary publish path with a rename but no fsync; a
 * power loss after the evidence install (which syncs only the directory) could keep the
 * attempt's directory entry and lose its bytes, and an unreadable attempt beside valid evidence
 * blocks every later reconciliation. When the record on disk already holds exactly `text` it
 * is kept and fsynced in place (file, then directory); otherwise `text` replaces it through the
 * same pinned install (temporary file fsynced, rename, directory fsynced). The record must be a
 * regular, single-link, non-symlink file of bounded size — anything else refuses and changes
 * nothing. Returns `{ replaced }`.
 */
export function installAttemptDurably(dir, name, text, {
  fsImpl = fs, platform = process.platform, onStep = null,
} = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > ATTEMPT_RECORD_MAX_BYTES) {
    throw auditError('REJECTION_AUDIT_UNSAFE', '기록할 게시 시도가 상한을 넘습니다.');
  }
  const dirStat = inspectDir(fsImpl, dir);
  const { raw, stat } = readLogPinned(fsImpl, dir, dirStat, name, ATTEMPT_RECORD_MAX_BYTES);
  if (stat === null || raw !== text) {
    installPinned(fsImpl, dir, dirStat, name, text, stat, { platform, onStep });
    return { replaced: true };
  }
  const file = path.join(dir, name);
  let fd;
  try {
    // Opened for writing although nothing is written: flushing a handle needs write access on
    // Windows (libuv's fsync is FlushFileBuffers, which requires GENERIC_WRITE), and a read-only
    // handle would make every unchanged-attempt retirement fail there. The identity checks below
    // (same inode, single link, unchanged size and mtime) are what keep the bytes exact; the
    // handle itself only flushes.
    try {
      fd = fsImpl.openSync(file, fs.constants.O_RDWR | NOFOLLOW | NONBLOCK);
    } catch (error) {
      throw auditError('REJECTION_AUDIT_UNAVAILABLE', '기록된 시도를 열 수 없습니다.', error);
    }
    const now = fstatOf(fsImpl, fd);
    if (!now.isFile() || now.nlink !== 1 || !sameFile(now, stat) || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
      throw auditError('REJECTION_AUDIT_CHANGED', '기록된 시도가 동기화하는 중 바뀌었습니다.');
    }
    fsImpl.fsyncSync(fd);
  } catch (error) {
    if (error.code?.startsWith?.('REJECTION_AUDIT_')) throw error;
    throw auditError('REJECTION_AUDIT_UNAVAILABLE', '기록된 시도를 동기화하지 못했습니다.', error);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* fsync result already known */ }
    }
  }
  onStep?.('attempt-synced');
  assertDirUnchanged(fsImpl, dir, dirStat);
  fsyncDir(fsImpl, dir, platform);
  onStep?.('dir-synced');
  return { replaced: false };
}

/**
 * Remove a file the audit now accounts for, durably: unlink, then fsync the directory.
 * A missing file is fine (someone else settled it); every other failure throws.
 */
export function removeDurably(dir, name, { fsImpl = fs, platform = process.platform } = {}) {
  try {
    fsImpl.unlinkSync(path.join(dir, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw auditError('REJECTION_AUDIT_UNAVAILABLE', '기록된 시도를 지우지 못했습니다.', error);
  }
  fsyncDir(fsImpl, dir, platform);
}
