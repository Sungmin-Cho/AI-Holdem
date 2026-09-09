import fs from "node:fs";
import {
  readPrivateJson,
  writePrivateJson as writeJsonAtomic,
} from "./app-files.js";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readOwnedLock, ownedIdentityStatus } from "../engine/state.js";
import {
  resolveCurrentSession,
  ensureSessionStore,
} from "../engine/session-catalog.js";
import { normalizeSetup, setupToArgs } from "../shared/game-setup.js";
import {
  ALLOWED_COMMANDS,
  validateCommand,
  controlError,
} from "../shared/session-control-contract.js";
import { launchSession } from "./session-launcher.js";
const read = readPrivateJson;
const stable = (value) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((k) => value[k] !== undefined)
          .map((k) => [k, stable(value[k])]),
      )
    : value;
const canonical = (value) => JSON.stringify(stable(value));
export function createSessionManager({
  storeDir,
  instanceId = randomUUID(),
  playerRuntime = "codex",
  resolver,
  onChange = () => {},
}) {
  const root = path.resolve(storeDir);
  ensureSessionStore(root);
  const journalDir = path.join(root, ".app", "commands");
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  let defaultSetup = normalizeSetup({});
  let current = resolveCurrentSession(root),
    state = "starting",
    revision = 0,
    error = null,
    session = null,
    startingLoop = null,
    runPromise = null,
    pending = null,
    closed = false,
    initialized = false;
  const setupFile = () =>
    current && path.join(current.sessionDir, ".app-setup.json");
  const currentSetup = () => {
    try {
      return normalizeSetup(read(setupFile()));
    } catch {
      return null;
    }
  };
  const emit = (next, code = null) => {
    state = next;
    error = code;
    revision++;
    onChange(snapshot());
  };
  function snapshot() {
    if (initialized && state === "external" && !pending) {
      const owner = readOwnedLock(root, "loop.lock.d");
      if (!owner || owner.status === "dead")
        reconcileFailure("SESSION_RECOVERABLE");
    }

    let epoch = null;
    if (current) {
      try {
        epoch = createHash("sha256")
          .update(
            read(path.join(current.sessionDir, "state.json")).sessionToken,
          )
          .digest("hex");
      } catch {}
    }
    let publicState = state;
    if (session && state === "playing") {
      try {
        const phase = read(
          path.join(current.sessionDir, "loop-state.json"),
        ).phase;
        if (
          ["finalizing", "review_generated", "review_published"].includes(phase)
        )
          publicState = "finalizing";
      } catch {}
    }
    return {
      instanceId,
      appRevision: revision,
      state: publicState,
      gameId: current?.gameId ?? null,
      selectionVersion: current?.selectionVersion ?? 0,
      gameEpoch: epoch,
      setup: currentSetup(),
      defaultSetup,
      allowedCommands:
        closed || !initialized ? [] : (ALLOWED_COMMANDS[publicState] ?? []),
      pendingRequestId: pending?.requestId ?? null,
      error,
    };
  }
  const save = (row) =>
    writeJsonAtomic(path.join(journalDir, `${row.requestId}.json`), row);
  const sameCurrent = (expected) => {
    const actual = resolveCurrentSession(root);
    if (
      (actual?.gameId ?? null) !== expected.expectedGameId ||
      (actual?.selectionVersion ?? 0) !== expected.expectedSelectionVersion
    )
      throw controlError("CURRENT_CHANGED");
  };
  function observeRun(launched) {
    session = launched;
    current = resolveCurrentSession(root);
    runPromise = launched.loop
      .run()
      .then(async (result) => {
        await launched.loop.requestStop();
        if (session === launched) {
          session = null;
          emit(result?.phase === "aborted" ? "ended" : "completed");
        }
        return result;
      })
      .catch(async (err) => {
        let cleanupConfirmed = true;
        try {
          await launched.loop.requestStop();
        } catch (cleanup) {
          err = cleanup;
          cleanupConfirmed = false;
        }
        if (session === launched) {
          if (cleanupConfirmed) session = null;
          emit("error", err.code ?? "SESSION_FAILED");
        }
        throw err;
      });
    runPromise.catch(() => {});
  }
  async function start(row, { recover = false } = {}) {
    const setup = row.setup;
    const args = { ...setupToArgs(setup, root), port: 0, playerRuntime };
    const launched = await launchSession(args, {
      resolver,
      onLoop: async (loop) => {
        startingLoop = loop;
        if (closed) {
          await loop.requestStop();
          throw controlError("APP_STOPPING");
        }
      },
      loopOptions: {
        controlProtocolVersion: 1,
        startPaused: recover,
        appSetup: setup,
      },
      onReserve: (previous) => {
        // This comparison runs while the launcher owns loop.lock.d.
        sameCurrent(row);
        row.reservation ??= {
          gameId: randomUUID(),
          selectionVersion: (previous?.selectionVersion ?? 0) + 1,
        };
        save(row);
        return row.reservation;
      },
    });
    startingLoop = null;
    current = resolveCurrentSession(root);
    writeJsonAtomic(setupFile(), setup);
    observeRun(launched);
    if (recover) {
      const paused = await launched.loop.pause();
      if (!["paused", "finalizing"].includes(paused.state))
        throw controlError("SESSION_STOPPED");
      emit(paused.state);
    } else emit("playing");
  }
  async function recoverPaused() {
    const launched = await launchSession(
      { storeDir: root, resume: true, port: 0, playerRuntime },
      {
        resolver,
        onLoop: async (loop) => {
          startingLoop = loop;
          if (closed) {
            await loop.requestStop();
            throw controlError("APP_STOPPING");
          }
        },
        loopOptions: { controlProtocolVersion: 1, startPaused: true },
      },
    );
    startingLoop = null;
    current = resolveCurrentSession(root);
    const phase = read(path.join(current.sessionDir, "loop-state.json")).phase;
    if (["aborted", "done"].includes(phase)) {
      await launched.loop.run();
      await launched.loop.requestStop();
      session = null;
      emit(phase === "aborted" ? "ended" : "completed");
      return false;
    }
    observeRun(launched);
    if (
      ["finalizing", "review_generated", "review_published"].includes(phase)
    ) {
      emit("finalizing");
      return false;
    }
    const paused = await launched.loop.pause();
    if (!["paused", "finalizing"].includes(paused.state))
      throw controlError("SESSION_STOPPED");
    emit(paused.state);
    return paused.state === "paused";
  }
  function reconcileFailure(code) {
    try {
      current = resolveCurrentSession(root);
      if (session && !session.loop.stopping) {
        const playing = session.loop.playState;
        if (["playing", "paused"].includes(playing)) {
          emit(playing, code);
          return;
        }
      }
      const lock = readOwnedLock(root, "loop.lock.d");
      if (lock && lock.status !== "dead") {
        emit(lock.pid === process.pid ? "error" : "external", code);
        return;
      }
      if (!current) {
        emit("lobby", code);
        return;
      }
      const engine = read(path.join(current.sessionDir, "state.json"));
      const loopFile = path.join(current.sessionDir, "loop-state.json");
      if (engine.result === "abort") {
        emit("ended", code);
        return;
      }
      if (fs.existsSync(loopFile) && read(loopFile).phase === "done") {
        emit("completed", code);
        return;
      }
      emit("error", code);
    } catch {
      emit("error", code ?? "SESSION_UNAVAILABLE");
    }
  }
  async function execute(row) {
    try {
      sameCurrent(row);
      if (row.kind === "start") {
        emit("starting");
        await start(row);
      } else if (row.kind === "pause") {
        emit("pausing");
        const paused = await session.loop.pause();
        if (!["paused", "finalizing"].includes(paused.state))
          throw controlError("SESSION_STOPPED");
        emit(paused.state);
      } else if (row.kind === "resume") {
        if (!session) {
          emit("starting");
          await recoverPaused();
        }
        if (session?.loop.playState === "paused") {
          await session.loop.resumePlay();
          emit("playing");
        }
      } else {
        if (state === "paused" || session) {
          emit("stopping");
          await session.loop.endGame(row.requestId);
          await runPromise;
        }
        if (row.kind === "end") {
          emit("ended");
        } else {
          // Preserve the caller's selector CAS across cleanup; an external loop can win here.
          emit("starting");
          await start(row);
        }
      }
      row.status = "succeeded";
      row.result = snapshot();
    } catch (err) {
      row.status = "failed";
      row.error = err.code ?? "COMMAND_FAILED";
      reconcileFailure(row.error);
    } finally {
      row.completedAt = new Date().toISOString();
      save(row);
      pending = null;
      revision++;
      onChange(snapshot());
    }
  }
  function command(body) {
    validateCommand(body);
    const normalized = { ...body };
    if (["start", "replace-current"].includes(body.kind))
      normalized.setup = normalizeSetup(body.setup);
    // Stable deep encoding: setup's key order must not change request identity.
    const payload = canonical(normalized);
    const file = path.join(journalDir, `${body.requestId}.json`);
    if (fs.existsSync(file)) {
      const old = read(file);
      if (old.payload !== payload) throw controlError("REQUEST_ID_CONFLICT");
      return old;
    }
    if (closed) throw controlError("APP_STOPPING");
    if (pending) throw controlError("COMMAND_PENDING");
    if (
      body.expectedInstanceId !== instanceId ||
      body.expectedAppRevision !== revision
    )
      throw controlError("STALE_APP");
    sameCurrent(body);
    if (!snapshot().allowedCommands.includes(body.kind))
      throw controlError("INVALID_TRANSITION");
    const setup = body.kind === "restart" ? currentSetup() : normalized.setup;
    if (["restart", "replace-current", "start"].includes(body.kind) && !setup)
      throw controlError("SETUP_UNAVAILABLE");
    const row = {
      ...normalized,
      setup,
      payload,
      status: "accepted",
      acceptedAt: new Date().toISOString(),
    };
    save(row);
    pending = row;
    revision++;
    onChange(snapshot());
    queueMicrotask(() => {
      void execute(row).catch(async () => {
        pending = null;
        closed = true;
        emit("error", "COMMAND_PERSISTENCE_FAILED");
        try {
          await session?.loop.requestStop();
        } catch {
          /* preserve ownership on unconfirmed cleanup */
        }
      });
    });
    return row;
  }
  async function initialize() {
    try {
      current = resolveCurrentSession(root);
      const rows = fs
        .readdirSync(journalDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => read(path.join(journalDir, f)));
      const unfinished = rows.filter((r) => r.status === "accepted");
      if (unfinished.length > 1) {
        emit("error", "RECOVERY_REQUIRED");
        return snapshot();
      }
      if (unfinished.length === 1) {
        const row = unfinished[0];
        pending = row;
        try {
          const reservedCurrent =
            row.reservation &&
            current?.gameId === row.reservation.gameId &&
            current.selectionVersion === row.reservation.selectionVersion;
          if (!reservedCurrent) sameCurrent(row);
          const lock = readOwnedLock(root, "loop.lock.d");
          if (lock && lock.status !== "dead") throw controlError("ACTIVE_GAME");
          if (reservedCurrent) {
            if (!currentSetup()) writeJsonAtomic(setupFile(), row.setup);
            await recoverPaused();
          } else if (row.kind === "start") await start(row, { recover: true });
          else {
            const engine = current
              ? read(path.join(current.sessionDir, "state.json"))
              : null;
            if (engine?.result !== "abort") await recoverPaused();
            else {
              await launchSession(
                { storeDir: root, resume: true, port: 0, playerRuntime },
                {
                  resolver,
                  loopOptions: { controlProtocolVersion: 1, startPaused: true },
                },
              );
              emit("ended");
            }
            if (["end", "restart", "replace-current"].includes(row.kind)) {
              if (session) {
                emit("stopping");
                await session.loop.endGame(row.requestId);
                await runPromise;
              }
              if (row.kind === "end") emit("ended");
              else await start(row, { recover: true });
            }
            // A crash-restored resume is parked; opening the app never silently plays.
          }
          row.status = "succeeded";
          row.result = snapshot();
        } catch (err) {
          row.status = "failed";
          row.error = err.code ?? "RECOVERY_REQUIRED";
          reconcileFailure(row.error);
        } finally {
          row.completedAt = new Date().toISOString();
          save(row);
          pending = null;
          revision++;
        }
        return snapshot();
      }
      if (!current) {
        emit("lobby");
        return snapshot();
      }
      const lock = readOwnedLock(root, "loop.lock.d");
      if (lock && lock.status !== "dead") {
        emit("external", "ACTIVE_GAME");
        return snapshot();
      }
      const engine = read(path.join(current.sessionDir, "state.json"));
      if (engine.result === "abort") {
        emit("ended");
        return snapshot();
      }
      const loopState = fs.existsSync(
        path.join(current.sessionDir, "loop-state.json"),
      )
        ? read(path.join(current.sessionDir, "loop-state.json"))
        : null;
      if (loopState?.phase === "done") {
        emit("completed");
        return snapshot();
      }
      // Attaching never resumes play implicitly, nor invokes a model until requested.
      emit("error", "SESSION_RECOVERABLE");
      return snapshot();
    } finally {
      initialized = true;
      revision++;
    }
  }
  async function close() {
    closed = true;
    revision++;
    const deadline =
      Date.now() + (process.platform === "win32" ? 300000 : 120000);
    // Stop first: this cancels waits, resolves pending pauses and interrupts bootstrap.
    await Promise.all([
      session?.loop.requestStop(),
      startingLoop?.requestStop(),
    ]);
    while (pending) {
      if (Date.now() >= deadline) throw controlError("APP_STOP_UNCONFIRMED");
      await new Promise((r) => setTimeout(r, 20));
    }
    await startingLoop?.requestStop();
    if (session) {
      await session.loop.requestStop();
      await runPromise.catch(() => {});
    }
  }
  return {
    initialize,
    initializationFailed(error) {
      closed = true;
      emit("error", error.code ?? "APP_INIT_FAILED");
    },
    snapshot,
    command,
    close,
    setPrefill(value) {
      defaultSetup = normalizeSetup(value);
      revision++;
      onChange(snapshot());
    },
    get current() {
      return current;
    },
    get session() {
      return session;
    },
    receipt(id) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw controlError("BAD_COMMAND");
      return read(path.join(journalDir, `${id}.json`));
    },
  };
}
