import { openContained } from '../tools/training-store.js';
import { RELAY_RENAME_RETRIES, observeRelayRenameRetries, writeRelayJsonAtomic } from './action-receipts.js';

// #347: the relay's own record of its storage trouble. The loop starts the relay with its stdio
// ignored, so this file in the relay's game directory is the only place the reason survives. Two
// kinds of entry, closed fields only:
//   persist-failed  a publish answered 500 PERSIST_FAILED: which commit stage failed, the error's
//                   code and syscall from the fixed lists below (anything else is OTHER, an absent
//                   one null), how many renames were tried when the rename was what failed, and when
//   rename-retried  a write whose rename onto one of the relay's own files succeeded only after
//                   collisions (a Windows reader holding it open): the file's fixed name, the first
//                   collision's code, how many renames it took, and when
// Never a path or a message, which name the user's directories. No route serves the file and no
// response carries it: it is read on the host's own machine (and by the tests).
//
// Recording is best effort. It runs just after a write in this directory failed or struggled, so
// it may fail too; it never throws, and nothing about the publish's answer or the relay's recovery
// depends on it. Its own write is never retried and never recorded, so it cannot recurse.

export const RELAY_PERSIST_STAGES = Object.freeze(['receipt-check', 'ui-commit', 'receipt-acknowledge', 'receipt-reconcile']);
const STAGES = new Set(RELAY_PERSIST_STAGES);
// errno names the relay's writes and reads can raise, and the codes this repository throws on them.
const CODES = new Set([
  'EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'ENOSPC', 'EDQUOT',
  'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EINVAL', 'ELOOP', 'EXDEV', 'EAGAIN', 'ETXTBSY', 'ENAMETOOLONG', 'ESTALE',
  'RELAY_ROOT_CHANGED', 'UNSAFE_PATH', 'ACTION_RECEIPT_CORRUPT', 'ACTION_RECEIPT_CAPACITY', 'TOO_LARGE', 'BAD_SEGMENT',
]);
const SYSCALLS = new Set(['open', 'close', 'read', 'write', 'fsync', 'rename', 'lstat', 'stat', 'fstat', 'realpath', 'unlink', 'mkdir', 'scandir']);
const COLLISIONS = new Set(['EPERM', 'EBUSY', 'EACCES']);
// The relay's own files a rename collision can be reported for (never this record itself).
const TARGETS = new Set(['ui-snapshot.json', 'ui-action-receipt.json', 'ui-action-cancellations.json', 'lock.json']);
const MAX_ATTEMPTS = RELAY_RENAME_RETRIES + 1;
const ENTRY_LIMIT = 32;
const MAX_BYTES = 16 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHAPES = {
  'persist-failed': { required: ['event', 'stage', 'code', 'syscall', 'at'], optional: ['attempts', 'causeCode', 'causeSyscall'] },
  'rename-retried': { required: ['event', 'target', 'code', 'attempts', 'at'], optional: [] },
};

const closed = (value, allowed) => {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && allowed.has(value) ? value : 'OTHER';
};
const closedValue = (value, allowed) => value === null || value === 'OTHER' || allowed.has(value);
const attemptCount = (value, min) => Number.isSafeInteger(value) && value >= min && value <= MAX_ATTEMPTS;

/** The closed record of one failed commit stage. Reads only `code`, `syscall` and `renameAttempts` (and the cause's code and syscall). */
export function persistFailureEntry(stage, error, now = new Date()) {
  const entry = {
    event: 'persist-failed',
    stage: STAGES.has(stage) ? stage : 'OTHER',
    code: closed(error?.code, CODES),
    syscall: closed(error?.syscall, SYSCALLS),
  };
  if (attemptCount(error?.renameAttempts, 1)) entry.attempts = error.renameAttempts;
  // A receipt read wraps its failure as ACTION_RECEIPT_CORRUPT; one level of cause says why.
  const cause = error?.cause;
  if (cause && typeof cause === 'object' && cause !== error) {
    entry.causeCode = closed(cause.code, CODES);
    entry.causeSyscall = closed(cause.syscall, SYSCALLS);
  }
  entry.at = now.toISOString();
  return entry;
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.event !== 'string') return false;
  // A string key only: a lookup would coerce ['persist-failed'] to the same name.
  const shape = Object.hasOwn(SHAPES, entry.event) ? SHAPES[entry.event] : null;
  if (!shape) return false;
  const keys = Object.keys(entry);
  if (!shape.required.every((key) => keys.includes(key))
    || keys.some((key) => !shape.required.includes(key) && !shape.optional.includes(key))) return false;
  if (typeof entry.at !== 'string' || !ISO.test(entry.at) || !Number.isFinite(Date.parse(entry.at))) return false;
  if (entry.event === 'rename-retried') {
    return TARGETS.has(entry.target) && COLLISIONS.has(entry.code) && attemptCount(entry.attempts, 2);
  }
  if (keys.includes('causeCode') !== keys.includes('causeSyscall')) return false;
  return (STAGES.has(entry.stage) || entry.stage === 'OTHER')
    && closedValue(entry.code, CODES) && closedValue(entry.syscall, SYSCALLS)
    && (!keys.includes('attempts') || attemptCount(entry.attempts, 1))
    && (!keys.includes('causeCode') || (closedValue(entry.causeCode, CODES) && closedValue(entry.causeSyscall, SYSCALLS)));
}

// Entries an earlier relay of this game recorded. Anything unreadable, oversized or not written by
// this module is left out; the next write replaces it.
function recordedEntries(owner) {
  try {
    owner.assert();
    const parsed = JSON.parse(openContained(owner.root, ['relay-diagnostics.json'], { maxBytes: MAX_BYTES }).toString('utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(validEntry);
  } catch { return []; }
}

function record(owner, entry) {
  if (!validEntry(entry)) return false;
  const entries = [...recordedEntries(owner), entry].slice(-ENTRY_LIMIT);
  writeRelayJsonAtomic(owner, 'relay-diagnostics.json', { schemaVersion: 1, entries }, { renameRetries: 0 });
  return true;
}

/** Records one failed commit stage, keeping the newest ENTRY_LIMIT entries. Never throws; true when written. */
export function recordPersistFailure(owner, stage, error) {
  try { return record(owner, persistFailureEntry(stage, error)); } catch { return false; }
}

/** Records every rename of this relay's own files that succeeded only after collisions. */
export function recordRenameRetries(owner) {
  observeRelayRenameRetries(owner, ({ target, code, attempts }) => {
    if (!TARGETS.has(target)) return;
    try {
      record(owner, { event: 'rename-retried', target, code: closed(code, COLLISIONS), attempts, at: new Date().toISOString() });
    } catch { /* best effort */ }
  });
}
