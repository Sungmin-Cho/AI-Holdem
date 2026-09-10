import fs from "node:fs";
import path from "node:path";
import { acquireOwnedLock, releaseOwnedLock } from "../engine/state.js";
import { writePrivateJson as writeJsonAtomic } from "./app-files.js";
import { controlError } from "../shared/session-control-contract.js";
const FILE = ".session-control.json";
const STATES = new Set(["playing", "pausing", "paused", "stopping", "aborted"]);
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
export function withActionGate(root, epoch, fn) {
  return withControlLock(root, () => {
    if (readSessionControl(root, epoch).playState !== "playing")
      throw controlError("GAME_PAUSED");
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
        if (!STATES.has(playState)) throw controlError("CONTROL_UNAVAILABLE");
        writeJsonAtomic(path.join(root, FILE), next);
        return next;
      });
    },
  };
}

export async function retryControlWrite(write, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return write();
    } catch (error) {
      if (error.code !== "CONTROL_BUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
