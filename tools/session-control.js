import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { acquireOwnedLock, releaseOwnedLock } from "../engine/state.js";
import { writePrivateJson as writeJsonAtomic } from "./app-files.js";
import { controlError } from "../shared/session-control-contract.js";
const FILE = ".session-control.json";
const STATES = new Set(["playing", "pausing", "paused", "stopping", "aborted"]);
const PAUSE_STATES = new Set(["pausing", "paused"]);
export function readSessionControl(root, epoch) {
  let fd;
  try {
    fd = fs.openSync(
      path.join(root, FILE),
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 16384 || st.nlink !== 1)
      throw controlError("CONTROL_UNAVAILABLE");
    const v = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      v.schemaVersion !== 1 ||
      v.gameEpoch !== epoch ||
      !STATES.has(v.playState) ||
      !Number.isSafeInteger(v.controlRevision) ||
      v.controlRevision < 0
    )
      throw controlError("CONTROL_UNAVAILABLE");
    return v;
  } catch {
    throw controlError("CONTROL_UNAVAILABLE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// #235: display hint for action-status. Lock-free and advisory — the gate stays
// the only admission authority. null when the control cannot be read.
export function readActionGatePaused(root, epoch) {
  try {
    return PAUSE_STATES.has(readSessionControl(root, epoch).playState);
  } catch {
    return null;
  }
}
export function withControlLock(root, fn) {
  let lock;
  try {
    lock = acquireOwnedLock(root, "session-control.lock.d");
  } catch (e) {
    throw controlError(
      e.code === "LOCKED" ? "CONTROL_BUSY" : "CONTROL_UNAVAILABLE",
    );
  }
  try {
    return fn();
  } finally {
    releaseOwnedLock(lock);
  }
}
// #235: `onClosed(control)` runs inside the same control lock when the gate is
// closed for a pause, so a cancellation it records is linearized before resume
// (which takes this lock to write `playing`). Its truthy result is attached to
// the GAME_PAUSED error as `cancelled`; a throwing callback only drops the proof.
// `precheck()` runs first inside the lock, before the gate state is consulted, so a
// caller's own admission error (e.g. the turn moved to another seat while a
// CONTROL_BUSY retry was waiting) wins over GAME_PAUSED and records nothing.
export function withActionGate(root, epoch, fn, { decisionId, onClosed, precheck } = {}) {
  return withControlLock(root, () => {
    if (typeof precheck === "function") precheck();
    const control = readSessionControl(root, epoch);
    if (control.playState !== "playing") {
      const error = controlError("GAME_PAUSED");
      if (typeof onClosed === "function" && PAUSE_STATES.has(control.playState)) {
        let cancelled = null;
        try { cancelled = onClosed(control) ?? null; } catch { cancelled = null; }
        if (cancelled) error.cancelled = cancelled;
      }
      throw error;
    }
    if (decisionId != null && control.closedDecisionId === decisionId) {
      throw controlError("DECISION_CLOSED");
    }
    return fn();
  });
}
export function createSessionControl(
  root,
  epoch,
  { startPaused = false, gameId = null, mustExist = false } = {},
) {
  withControlLock(root, () => {
    let exists;
    try {
      fs.lstatSync(path.join(root, FILE));
      exists = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw controlError("CONTROL_UNAVAILABLE");
      exists = false;
    }
    if (!exists) {
      if (mustExist) throw controlError("CONTROL_UNAVAILABLE");
      writeJsonAtomic(path.join(root, FILE), {
        schemaVersion: 1,
        gameId,
        gameEpoch: epoch,
        controlRevision: 0,
        playState: startPaused ? "pausing" : "playing",
      });
    } else {
      const old = readSessionControl(root, epoch);
      if (startPaused && old.playState !== "aborted")
        writeJsonAtomic(path.join(root, FILE), {
          ...old,
          playState: "pausing",
          pauseIntent: true,
          controlRevision: old.controlRevision + 1,
        });
    }
  });
  return {
    read: () => readSessionControl(root, epoch),
    set(playState, patch = {}) {
      return withControlLock(root, () => {
        const old = readSessionControl(root, epoch);
        const next = {
          ...old,
          ...patch,
          playState,
          controlRevision: old.controlRevision + 1,
        };
        if (!Object.hasOwn(patch, "closedDecisionId")) next.closedDecisionId = null;
        if (!STATES.has(playState)) throw controlError("CONTROL_UNAVAILABLE");
        writeJsonAtomic(path.join(root, FILE), next);
        return next;
      });
    },
    closeDecision(decisionId) {
      return withControlLock(root, () => {
        const old = readSessionControl(root, epoch);
        if (old.playState !== "playing") return { closed: false };
        writeJsonAtomic(path.join(root, FILE), {
          ...old,
          closedDecisionId: decisionId,
          controlRevision: old.controlRevision + 1,
        });
        return { closed: true };
      });
    },
  };
}

// A busy attempt judges the lock's current holder. For a holder in another process
// that is an identity read, which on Windows spawns PowerShell and alone can outlast
// `timeoutMs` (#251). `minAttempts` still retries after such a slow judgement — a
// holder keeps this lock only for a few file writes. The first attempt always runs;
// `maxMs` is the last moment a later one may start, and one already running (a
// synchronous identity read, capped at 15 s on Windows) is not interrupted. The
// lock's own verdicts (fail-closed, dead-owner reclaim) are unchanged: this only
// decides when to ask again. `onBusy` observes each busy attempt (tests only); an
// error it throws ends the retries in place of CONTROL_BUSY.
const CONTROL_RETRY_MIN_ATTEMPTS = 3;
const CONTROL_RETRY_MAX_MS = 5000;
const CONTROL_RETRY_SLEEP_MS = 20;
export async function retryControlWrite(write, {
  timeoutMs = 2000,
  minAttempts = CONTROL_RETRY_MIN_ATTEMPTS,
  maxMs = Math.max(timeoutMs, CONTROL_RETRY_MAX_MS),
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onBusy = () => {},
} = {}) {
  const started = now();
  // Checked after a failure and again after the pause, so no attempt starts late.
  const mayRetry = (attempt) => {
    const elapsed = now() - started;
    return elapsed < maxMs && (attempt < minAttempts || elapsed < timeoutMs);
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return write();
    } catch (error) {
      if (error.code !== "CONTROL_BUSY") throw error;
      onBusy(attempt);
      if (!mayRetry(attempt)) throw error;
      await sleep(CONTROL_RETRY_SLEEP_MS);
      if (!mayRetry(attempt)) throw error;
    }
  }
}
