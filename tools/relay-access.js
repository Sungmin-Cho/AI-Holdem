import fs from 'node:fs';
import { gameEpochOf } from '../publish-contract.js';
import { ownedIdentityStatus, validOwnedIdentity } from '../engine/state.js';

// #270: the app proxy may send the relay's session token only to the relay process that the
// game loop verified, re-proved around each request. Authorization is request-scoped and never
// cached: `capture()` pins what the loop knows before the proxy waits for a POST body, and
// `use()` re-proves it after the wait, then calls `send` in the same synchronous step as the
// last check. The token reaches only `send`'s argument; no return value, error or property of
// this module carries the token, pid, port or start time.
//
// Residual OS TOCTOU: from the listener observation through connect(2), the still-living relay
// may release its port and another process may bind it; PID reuse is not required. This also
// includes the subsequent synchronous identity-read latency and asynchronous connection setup.
// These separate observations do not atomically authenticate the connected peer.

export const RELAY_DENY_REASONS = Object.freeze([
  'STOPPING', 'NO_BINDING', 'BAD_BINDING', 'LOCK_MISSING', 'LOCK_BAD',
  'LOCK_BINDING_MISMATCH', 'STALE', 'CHANGED', 'BUSY', 'LISTENER_MISMATCH',
  'LISTENER_UNKNOWN', 'IDENTITY_UNKNOWN',
]);

export class RelayDenied extends Error {
  constructor(code, reason) {
    super(code);
    this.name = 'RelayDenied';
    this.code = code;
    this.reason = reason;
  }
}

const deny = (reason) => new RelayDenied(reason === 'STALE' ? 'STALE_GAME' : 'RELAY_UNAVAILABLE', reason);

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
// lock.json is a few hundred bytes; anything near this bound is not a relay lock.
const LOCK_MAX_BYTES = 64 * 1024;

// Regular single-link file, named by one inode from lstat through fstat (tools/rejection-audit.js
// convention). The open never follows a symlink and never blocks: a FIFO or device at the path
// must fail closed instead of parking the request in open(2); where O_NOFOLLOW is unavailable the
// lstat/fstat identity match is the fallback. `maxBytes` bounds the allocation. Bytes plus
// dev/ino and bytes detect ordinary replacements; no descriptor is retained across the
// request, so recycled inodes or an in-place change-and-restore do not prove continuity.
function readPinned(file, missing, bad, maxBytes = Infinity) {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    throw deny(error.code === 'ENOENT' ? missing : bad);
  }
  if (!before.isFile() || before.nlink !== 1n || before.size > maxBytes) throw deny(bad);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (error) {
    throw deny(error.code === 'ENOENT' ? missing : bad);
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > maxBytes
      || stat.dev !== before.dev || stat.ino !== before.ino) throw deny(bad);
    const size = Number(stat.size);
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buf, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== size) throw deny(bad);
    return { raw: buf.toString('utf8'), dev: stat.dev, ino: stat.ino };
  } catch (error) {
    throw error instanceof RelayDenied ? error : deny(bad);
  } finally {
    fs.closeSync(fd);
  }
}

const parseJson = (raw, bad) => {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  throw deny(bad);
};

const validBinding = (binding) => Boolean(binding)
  && Number.isSafeInteger(binding.pid) && binding.pid > 0
  && Number.isSafeInteger(binding.port) && binding.port >= 1 && binding.port <= 65_535
  && typeof binding.sessionToken === 'string' && binding.sessionToken.length > 0
  && validOwnedIdentity(binding.startTime);

/**
 * deps: lockPath, statePath, managed, binding() (the loop's verified-binding object itself,
 * compared by reference), isStopping(), startTimeOf(pid), listenerOwnedBy(pid, port,
 * {timeoutMs}), probeMs, maxConcurrent.
 */
export function createRelayAccess(deps) {
  const maxConcurrent = deps.maxConcurrent ?? 8;
  let slots = 0;

  // Synchronous observation of everything the loop and the store say about the relay. Takes no
  // OS probe. Throws `RelayDenied` for a state that can never authorize a send.
  const observe = () => {
    if (deps.isStopping()) throw deny('STOPPING');
    const ref = deps.binding();
    if (ref == null) throw deny('NO_BINDING');
    if (!validBinding(ref)) throw deny('BAD_BINDING');
    const lockFile = readPinned(deps.lockPath, 'LOCK_MISSING', 'LOCK_BAD', LOCK_MAX_BYTES);
    const lock = parseJson(lockFile.raw, 'LOCK_BAD');
    // A lock without serverStartTime is an adopted pre-#215 relay: the loop's verified binding
    // is then the only authority. A present stamp must be exactly the binding's, so a legacy
    // raw stamp (not the owned form) never matches and is refused.
    if (lock.serverPid !== ref.pid || lock.port !== ref.port || lock.sessionToken !== ref.sessionToken
      || (lock.controlProtocolVersion ?? null) !== (deps.managed ? 1 : null)
      || (lock.serverStartTime !== undefined && lock.serverStartTime !== ref.startTime)) {
      throw deny('LOCK_BINDING_MISMATCH');
    }
    let engine;
    try {
      engine = parseJson(readPinned(deps.statePath, 'LOCK_MISSING', 'LOCK_BAD').raw, 'LOCK_BAD');
    } catch (error) {
      if (error.reason === 'LOCK_MISSING') throw deny('CHANGED');
      throw error;
    }
    if (engine.sessionToken !== ref.sessionToken) throw deny('CHANGED');
    return { ref, token: engine.sessionToken, lock: lockFile };
  };
  const same = (a, b) => a.ref === b.ref && a.token === b.token
    && a.lock.raw === b.lock.raw && a.lock.dev === b.lock.dev && a.lock.ino === b.lock.ino;

  return {
    // Called synchronously after the proxy's first checks and before any body wait. A capture
    // that already fails is remembered and denies at `use()` (the request is retryable).
    capture() {
      let denied = null;
      let pinned = null;
      try { pinned = observe(); } catch (error) {
        if (!(error instanceof RelayDenied)) throw error;
        denied = error;
      }
      const copy = pinned && Object.freeze({ ...pinned.ref });
      const fresh = (gameEpoch) => {
        const now = observe();
        if (!same(now, pinned)) throw deny('CHANGED');
        if (gameEpochOf(now.token) !== gameEpoch) throw deny('STALE');
      };
      return Object.freeze({
        async use({ gameEpoch, revalidate }, send) {
          if (denied) throw denied;
          revalidate();
          fresh(gameEpoch);
          if (slots >= maxConcurrent) throw deny('BUSY');
          slots += 1;
          let owned;
          try {
            owned = await deps.listenerOwnedBy(copy.pid, copy.port, { timeoutMs: deps.probeMs });
          } catch { owned = null; } finally { slots -= 1; }
          if (owned === null) throw deny('LISTENER_UNKNOWN');
          if (owned !== true) throw deny('LISTENER_MISMATCH');
          // From here no await: the last OS read is the identity, every later check is a
          // memory or file read, and `send` runs in the same synchronous step.
          // Only a positive 'alive' (same owned kind, same reading) authorizes; dead, unknown
          // (including a Linux lstart mismatch, which proves nothing) and a throwing reader all refuse.
          let status = 'unknown';
          try { status = ownedIdentityStatus(copy.pid, copy.startTime, deps.startTimeOf); } catch { /* unknown */ }
          if (status !== 'alive') throw deny('IDENTITY_UNKNOWN');
          revalidate();
          fresh(gameEpoch);
          const access = Object.freeze({
            port: copy.port,
            sessionToken: copy.sessionToken,
            stillBound: () => !deps.isStopping() && deps.binding() === pinned.ref,
          });
          return send(access);
        },
      });
    },
  };
}
