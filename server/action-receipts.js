import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  normalizeActionRequest, sameActionIdentity, validateActionAck,
  NOTE_MAX_CHARS, NOTE_MAX_BYTES,
} from '../publish-contract.js';
import { openContained } from '../tools/training-store.js';

const RECEIPT_FILE = 'ui-action-receipt.json';
// #235: requests the pause gate refused with durable proof. Only the current
// decision's entries are kept; a new decision's first entry replaces the file.
const CANCELLATION_FILE = 'ui-action-cancellations.json';
const RELAY_FILES = new Set(['ui-action-receipt.json', 'ui-action-cancellations.json', 'ui-snapshot.json', 'lock.json']);
export const ACTION_RECEIPT_MAX_BYTES = 4096;
export const ACTION_REJECTION_LIMIT = 16;
export const ACTION_CANCELLATION_LIMIT = 16;
export const ACTION_CANCELLATION_MAX_BYTES = 4096;
const PHASES = new Set(['accepted', 'delivered', 'consumed', 'rejected']);
const TERMINAL = new Set(['consumed', 'rejected']);
const KEYS = new Set(['schemaVersion', 'gameEpoch', 'decisionId', 'requestId', 'action', 'amount', 'digest', 'phase', 'publishId', 'reason', 'rejections', 'retiredAtPublishId', 'note']);
const REJECTION_KEYS = new Set(['requestId', 'digest', 'reason', 'publishId']);
const CANCELLATION_KEYS = new Set(['schemaVersion', 'gameEpoch', 'decisionId', 'entries']);
const CANCELLATION_ENTRY_KEYS = new Set(['requestId', 'digest', 'controlRevision']);
const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const coded = (code) => Object.assign(new Error(code), { code });
const fail = () => coded('ACTION_RECEIPT_CORRUPT');
const owners = new WeakMap();

// The UI and receipt must use this same lifetime identity, never a freshly pinned
// directory at the old pathname after a game-root replacement.
export function createRelayRootOwner(root) {
  const resolved = path.resolve(root);
  const original = fs.lstatSync(resolved);
  if (!original.isDirectory() || original.isSymbolicLink()) throw coded('RELAY_ROOT_CHANGED');
  const canonical = fs.realpathSync(resolved);
  const assert = (fd) => {
    try {
      const st = fs.lstatSync(resolved);
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== original.dev || st.ino !== original.ino
        || fs.realpathSync(resolved) !== canonical) throw coded('RELAY_ROOT_CHANGED');
      if (fd !== undefined) {
        const opened = fs.fstatSync(fd);
        if (!opened.isDirectory() || opened.dev !== original.dev || opened.ino !== original.ino) throw coded('RELAY_ROOT_CHANGED');
      }
    } catch { throw coded('RELAY_ROOT_CHANGED'); }
  };
  const owner = Object.freeze({ root: resolved, assert });
  owners.set(owner, canonical);
  return owner;
}

// Closed server-owned destinations only. Check the lifetime owner at every path
// mutation and fsync boundary; open file descriptors still refer to our own inode.
export function writeRelayJsonAtomic(owner, name, value) {
  if (!owners.has(owner) || !RELAY_FILES.has(name)) throw coded('RELAY_ROOT_CHANGED');
  owner.assert();
  const file = path.join(owner.root, name);
  const inspectTarget = () => {
    owner.assert();
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw coded('UNSAFE_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  inspectTarget();
  const bytes = JSON.stringify(value);
  const tmp = path.join(owner.root, `.${name}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  let temporary;
  try {
    owner.assert();
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    temporary = fs.fstatSync(fd);
    owner.assert();
    fs.writeFileSync(fd, bytes, 'utf8');
    owner.assert();
    fs.fsyncSync(fd);
    inspectTarget();
    owner.assert();
    // The pathname can be replaced while the original fd remains valid. Keep that
    // fd open and compare both identities immediately before the rename.
    const opened = fs.fstatSync(fd);
    const named = fs.lstatSync(tmp);
    if (!opened.isFile() || opened.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
      || opened.dev !== temporary.dev || opened.ino !== temporary.ino
      || named.dev !== opened.dev || named.ino !== opened.ino) throw coded('UNSAFE_PATH');
    fs.renameSync(tmp, file);
    owner.assert();
    fs.closeSync(fd);
    fd = undefined;
    // Node cannot open/fsync directories on Windows. File bytes were flushed
    // before atomic rename; directory crash durability is unavailable there.
    if (process.platform === 'win32') { owner.assert(); return; }
    fd = fs.openSync(owner.root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    owner.assert(fd);
    try { fs.fsyncSync(fd); } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    }
    owner.assert(fd);
  } catch (error) {
    try {
      owner.assert();
      const st = fs.lstatSync(tmp);
      if (temporary && st.dev === temporary.dev && st.ino === temporary.ino && st.isFile() && !st.isSymbolicLink() && st.nlink === 1) fs.unlinkSync(tmp);
    } catch { /* do not unlink anything through a replaced root */ }
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectionEntry(row, reason, publishId) {
  return { requestId: row.requestId, digest: row.digest, reason, publishId };
}

function checkCapacity(row) {
  if (row.rejections.length > ACTION_REJECTION_LIMIT
    || Buffer.byteLength(JSON.stringify(row), 'utf8') > ACTION_RECEIPT_MAX_BYTES) {
    throw coded('ACTION_RECEIPT_CAPACITY');
  }
}

function reserveTerminalCapacity(row) {
  // Reserve the maximum legal acknowledgement at acceptance, including the new
  // rejection entry. No old rejection is evicted to make room for another try.
  const reason = 'R'.repeat(64);
  const publishId = Number.MAX_SAFE_INTEGER;
  checkCapacity({ ...row, phase: 'rejected', reason, publishId,
    rejections: [...row.rejections, rejectionEntry(row, reason, publishId)] });
  checkCapacity({ ...row, phase: 'consumed', reason, publishId,
    rejections: [], retiredAtPublishId: publishId });
}

export function createActionReceiptStore(root, gameEpoch, { checkpoint = () => {}, owner = createRelayRootOwner(root) } = {}) {
  if (!DIGEST.test(gameEpoch ?? '') || !owners.has(owner) || owner.root !== path.resolve(root)) throw fail();
  const file = path.join(owner.root, RECEIPT_FILE);
  let observedReceipt = false;
  let observedCancellations = false;
  const inspectFile = (target) => {
    owner.assert();
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw fail();
      return st;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const inspect = () => inspectFile(file);
  const validate = (row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some((key) => !KEYS.has(key))
      || row.schemaVersion !== 1 || row.gameEpoch !== gameEpoch || !PHASES.has(row.phase)
      || !Object.hasOwn(row, 'amount') || !Array.isArray(row.rejections)) throw fail();
    // Rejections inherit this row's exact gameEpoch and decisionId. Missing ledger
    // in an unreleased intermediate format is unsupported, never invented history.
    const ids = new Set();
    let previousPublication = 0;
    for (const entry of row.rejections) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some((key) => !REJECTION_KEYS.has(key))
        || typeof entry.requestId !== 'string' || !REQUEST_ID.test(entry.requestId)
        || typeof entry.digest !== 'string' || !DIGEST.test(entry.digest)
        || typeof entry.reason !== 'string' || !REASON.test(entry.reason)
        || !Number.isSafeInteger(entry.publishId) || entry.publishId <= previousPublication
        || ids.has(entry.requestId)) throw fail();
      ids.add(entry.requestId);
      previousPublication = entry.publishId;
    }
    if (Object.hasOwn(row, 'note')
      && (typeof row.note !== 'string'
        || [...row.note].length > NOTE_MAX_CHARS
        || Buffer.byteLength(JSON.stringify(row.note), 'utf8') > NOTE_MAX_BYTES)) throw fail();
    let normalized;
    try { normalized = normalizeActionRequest(row); checkCapacity(row); } catch { throw fail(); }
    if (Object.entries(normalized).some(([key, value]) => row[key] !== value)) throw fail();
    if (Object.hasOwn(row, 'note') && row.note !== normalized.note) throw fail();
    const rejection = row.rejections.find((entry) => entry.requestId === row.requestId);
    const retired = Object.hasOwn(row, 'retiredAtPublishId');
    if (TERMINAL.has(row.phase)) {
      if (!Number.isSafeInteger(row.publishId) || row.publishId < 1
        || typeof row.reason !== 'string' || !REASON.test(row.reason)) throw fail();
      if (previousPublication > row.publishId || (row.phase === 'consumed' && previousPublication >= row.publishId)) throw fail();
      if (retired && (!Number.isSafeInteger(row.retiredAtPublishId)
        || row.retiredAtPublishId < row.publishId || row.rejections.length !== 0)) throw fail();
      if (row.phase === 'rejected' && !retired
        && (!rejection || rejection.digest !== row.digest || rejection.reason !== row.reason
          || rejection.publishId !== row.publishId)) throw fail();
      if (row.phase === 'consumed' && rejection) throw fail();
    } else {
      if (Object.hasOwn(row, 'publishId') || Object.hasOwn(row, 'reason') || retired || rejection) throw fail();
      try { reserveTerminalCapacity(row); } catch { throw fail(); }
    }
    return row;
  };
  const read = () => {
    try {
      const before = inspect();
      if (!before) {
        if (observedReceipt) throw fail();
        return null;
      }
      const bytes = openContained(owner.root, [RECEIPT_FILE], { maxBytes: ACTION_RECEIPT_MAX_BYTES });
      const after = inspect();
      if (!after || after.dev !== before.dev || after.ino !== before.ino) throw fail();
      const row = validate(JSON.parse(bytes.toString('utf8')));
      observedReceipt = true;
      return row;
    } catch { throw fail(); }
  };
  const validateCancellations = (ledger) => {
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
      || Object.keys(ledger).some((key) => !CANCELLATION_KEYS.has(key))
      || ledger.schemaVersion !== 1 || ledger.gameEpoch !== gameEpoch
      || typeof ledger.decisionId !== 'string' || !DECISION_ID.test(ledger.decisionId)
      || !Array.isArray(ledger.entries) || ledger.entries.length < 1
      || ledger.entries.length > ACTION_CANCELLATION_LIMIT
      || Buffer.byteLength(JSON.stringify(ledger), 'utf8') > ACTION_CANCELLATION_MAX_BYTES) throw fail();
    const ids = new Set();
    for (const entry of ledger.entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some((key) => !CANCELLATION_ENTRY_KEYS.has(key))
        || typeof entry.requestId !== 'string' || !REQUEST_ID.test(entry.requestId)
        || entry.requestId.startsWith('legacy-')
        || typeof entry.digest !== 'string' || !DIGEST.test(entry.digest)
        || !Number.isSafeInteger(entry.controlRevision) || entry.controlRevision < 0
        || ids.has(entry.requestId)) throw fail();
      ids.add(entry.requestId);
    }
    return ledger;
  };
  const cancellationFile = path.join(owner.root, CANCELLATION_FILE);
  // Same fail-closed reading as the receipt: once observed, a vanished ledger is
  // corruption, never "nothing was cancelled".
  const readCancellations = () => {
    try {
      const before = inspectFile(cancellationFile);
      if (!before) {
        if (observedCancellations) throw fail();
        return null;
      }
      const bytes = openContained(owner.root, [CANCELLATION_FILE], { maxBytes: ACTION_CANCELLATION_MAX_BYTES });
      const after = inspectFile(cancellationFile);
      if (!after || after.dev !== before.dev || after.ino !== before.ino) throw fail();
      const ledger = validateCancellations(JSON.parse(bytes.toString('utf8')));
      observedCancellations = true;
      return ledger;
    } catch { throw fail(); }
  };
  const cancelledEntry = (decisionId, requestId) => {
    const ledger = readCancellations();
    return ledger?.decisionId === decisionId
      ? ledger.entries.find((entry) => entry.requestId === requestId) ?? null
      : null;
  };
  const commit = (row) => {
    checkCapacity(row);
    validate(row);
    inspect();
    writeRelayJsonAtomic(owner, 'ui-action-receipt.json', row);
    observedReceipt = true;
    checkpoint(row.phase);
    return row;
  };
  const terminalRow = (receipt, ack, publishId) => {
    if (!receipt || !sameActionIdentity(receipt, ack)
      || !TERMINAL.has(ack.phase) || !Number.isSafeInteger(publishId) || publishId < 1) throw fail();
    if (TERMINAL.has(receipt.phase)) {
      if (receipt.phase !== ack.phase || receipt.reason !== ack.reason || receipt.publishId !== publishId) throw fail();
      return receipt;
    }
    const next = { ...receipt, phase: ack.phase, reason: ack.reason, publishId,
      rejections: ack.phase === 'rejected' ? [...receipt.rejections, rejectionEntry(receipt, ack.reason, publishId)] : receipt.rejections };
    checkCapacity(next);
    return validate(next);
  };
  const acknowledgeDurable = (ack, publishId) => {
    const receipt = read();
    const next = terminalRow(receipt, ack, publishId);
    return next === receipt ? receipt : commit(next);
  };
  const validateStoredAck = (receipt, lastActionAck, publishId) => {
    if (receipt?.rejections.some((entry) => !Number.isSafeInteger(publishId) || entry.publishId > publishId)) throw fail();
    if (lastActionAck === undefined) return null;
    if (!receipt) throw fail();
    const { publishId: ackPublishId, ...ack } = lastActionAck ?? {};
    if (!Number.isSafeInteger(ackPublishId) || ackPublishId < 1 || ackPublishId > publishId) throw fail();
    try {
      validateActionAck(ack, { gameEpoch, view: { legal: { decisionId: ack.phase === 'rejected' ? ack.decisionId : null } } });
    } catch { throw fail(); }
    const current = sameActionIdentity(receipt, ack);
    if (current) terminalRow(receipt, ack, ackPublishId);
    else if (receipt.decisionId === ack.decisionId) {
      // Each correction follows its predecessor's UI-before-receipt commit.
      // The active correction therefore requires the latest rejection anchor.
      const historical = receipt.rejections.at(-1);
      if (ack.phase !== 'rejected' || !historical || historical.requestId !== ack.requestId || historical.digest !== ack.digest
        || historical.reason !== ack.reason || historical.publishId !== ackPublishId) throw fail();
    }
    return { ack, publishId: ackPublishId, current };
  };
  read();
  readCancellations();
  return {
    read,
    accept(body, currentDecision) {
      if (currentDecision == null || body?.decisionId !== currentDecision) throw coded('STALE_DECISION');
      const next = { schemaVersion: 1, gameEpoch, ...normalizeActionRequest(body), phase: 'accepted', rejections: [] };
      // #235: a request the pause gate cancelled with proof can never be accepted
      // later, whether it is a retry after resume or an older timed-out POST.
      const cancelled = cancelledEntry(next.decisionId, next.requestId);
      if (cancelled) throw coded(cancelled.digest === next.digest ? 'ACTION_CANCELLED' : 'ACTION_ALREADY_RECEIVED');
      const previous = read();
      if (previous?.decisionId === next.decisionId) {
        const rejected = previous.rejections.find((entry) => entry.requestId === next.requestId);
        if (rejected) throw coded(rejected.digest === next.digest ? 'ACTION_REJECTED' : 'ACTION_ALREADY_RECEIVED');
        if (previous.requestId === next.requestId) {
          if (previous.digest !== next.digest) throw coded('ACTION_ALREADY_RECEIVED');
          if (previous.phase === 'rejected') throw coded('ACTION_REJECTED');
          return previous;
        }
      }
      if (previous && previous.decisionId === next.decisionId) {
        if (previous.phase !== 'rejected' || previous.retiredAtPublishId !== undefined) throw coded('ACTION_ALREADY_RECEIVED');
        next.rejections = previous.rejections;
      } else if (previous && !TERMINAL.has(previous.phase)) {
        throw coded('ACTION_ALREADY_RECEIVED');
      }
      reserveTerminalCapacity(next);
      return commit(next);
    },
    deliver(currentDecision, expectedDecision = '') {
      const row = read();
      if (!row || TERMINAL.has(row.phase) || row.decisionId !== currentDecision
        || (expectedDecision && row.decisionId !== expectedDecision)) return null;
      const delivered = row.phase === 'accepted' ? commit({ ...row, phase: 'delivered' }) : row;
      const { gameEpoch: epoch, decisionId, requestId, action, amount, digest, note } = delivered;
      return {
        gameEpoch: epoch, decisionId, requestId, action,
        ...(amount === null ? {} : { amount }),
        digest,
        ...(note ? { note } : {}),
      };
    },
    preflightAcknowledge(ack, publishId) { terminalRow(read(), ack, publishId); },
    shouldClearHistoricalAck(authoritativeView, lastActionAck, publishId) {
      const receipt = read();
      const stored = validateStoredAck(receipt, lastActionAck, publishId);
      return Boolean(stored && !stored.current && receipt.decisionId === stored.ack.decisionId
        && authoritativeView != null && authoritativeView.legal?.decisionId !== receipt.decisionId);
    },
    acknowledgeDurable,
    reconcile(authoritativeView, lastActionAck, publishId) {
      let receipt = read();
      if (receipt && TERMINAL.has(receipt.phase)
        && (!Number.isSafeInteger(publishId) || receipt.publishId > publishId)) throw fail();
      if (receipt?.rejections.some((entry) => !Number.isSafeInteger(publishId) || entry.publishId > publishId)) throw fail();
      if (receipt?.retiredAtPublishId !== undefined && (receipt.retiredAtPublishId > publishId
        || authoritativeView == null || authoritativeView.legal?.decisionId === receipt.decisionId)) throw fail();
      const stored = validateStoredAck(receipt, lastActionAck, publishId);
      if (stored?.current) receipt = acknowledgeDurable(stored.ack, stored.publishId);
      if (receipt && authoritativeView != null && receipt.decisionId !== (authoritativeView.legal?.decisionId ?? null)) {
        if (!TERMINAL.has(receipt.phase)) {
          receipt = terminalRow(receipt, { ...receipt, phase: 'consumed', reason: 'DECISION_ADVANCED' }, publishId);
        }
        if (receipt.retiredAtPublishId === undefined) {
          receipt = commit({ ...receipt, rejections: [], retiredAtPublishId: publishId });
        }
      }
      return receipt;
    },
    // #235: called by the action gate while it holds the control lock and the game
    // is pausing/paused. Returns durable proof `{decisionId, requestId}` only after
    // the ledger write (file + directory fsync) completed; otherwise null, which the
    // relay reports as a plain GAME_PAUSED exactly as before. Never evicts.
    cancel(body, currentDecision, controlRevision) {
      try {
        if (body?.requestId === undefined || !Number.isSafeInteger(controlRevision) || controlRevision < 0) return null;
        const request = normalizeActionRequest(body);
        if (request.requestId.startsWith('legacy-')) return null;
        if (currentDecision == null || request.decisionId !== currentDecision) return null;
        const receipt = read();
        if (receipt?.decisionId === request.decisionId && (receipt.requestId === request.requestId
          || receipt.rejections.some((entry) => entry.requestId === request.requestId))) return null;
        const ledger = readCancellations();
        const same = ledger?.decisionId === request.decisionId ? ledger : null;
        const proof = { decisionId: request.decisionId, requestId: request.requestId };
        const existing = same?.entries.find((entry) => entry.requestId === request.requestId);
        if (existing) return existing.digest === request.digest ? proof : null;
        const next = { schemaVersion: 1, gameEpoch, decisionId: request.decisionId,
          entries: [...(same?.entries ?? []), { requestId: request.requestId, digest: request.digest, controlRevision }] };
        try { validateCancellations(next); } catch { return null; }
        inspectFile(cancellationFile);
        writeRelayJsonAtomic(owner, 'ui-action-cancellations.json', next);
        observedCancellations = true;
        return proof;
      } catch { return null; }
    },
    status(currentDecision) {
      const row = read();
      const current = row?.decisionId === currentDecision ? row : null;
      const ledger = readCancellations();
      // #235: earlier rejected requests of the current decision are terminal too.
      // A tab holding one of them (its response lost while another tab corrected)
      // needs this list to release instead of reading a mismatched receipt.
      const rejected = (current?.rejections ?? []).map((entry) => entry.requestId).filter((id) => id !== current.requestId);
      return { ok: true, decisionId: currentDecision, requestId: current?.requestId ?? null, phase: current?.phase ?? 'unreceived',
        ...(current?.phase==='rejected' && ['STALE_DECISION','ILLEGAL_ACTION','VERSION_MISMATCH'].includes(current.reason)?{reason:current.reason}:{}),
        ...(rejected.length ? { rejected } : {}),
        ...(currentDecision != null && ledger?.decisionId === currentDecision
          ? { cancelled: ledger.entries.map((entry) => entry.requestId) } : {}) };
    },
  };
}
