import { validateDiagnostics, projectRejectionForSink, retryWillCorrect } from './player-decision.js';
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
  ABORTABLE_ERROR_CODES,
  validateCommand,
  controlError,
} from "../shared/session-control-contract.js";
import { launchSession } from "./session-launcher.js";
import { abortModeFor, validateAbortingCheckpoint } from './recovery-exit.js';
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
  function abortTarget() {
    if (state !== 'error' || session || startingLoop || !current) return null;
    try {
      const engine=read(path.join(current.sessionDir,'state.json'));
      const loop=read(path.join(current.sessionDir,'loop-state.json'));
      const epoch=createHash('sha256').update(engine.sessionToken).digest('hex');
      if (loop.sessionToken!==engine.sessionToken || loop.gameEpoch!==epoch) return null;
      if (loop.aborting) {
        const checkpoint=validateAbortingCheckpoint(current.sessionDir,engine,loop);
        return checkpoint ? {mode:checkpoint.mode} : null;
      }
      if (!ABORTABLE_ERROR_CODES.includes(error)) return null;
      const mode=abortModeFor(engine,loop);
      return mode ? {mode} : null;
    } catch { return null; }
  }
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
    const pendingDecision = session?.loop.pendingDecision ?? null;
    const diagnosticCheck = pendingDecision ? validateDiagnostics(pendingDecision.diagnostics, pendingDecision) : null;
    const diagnostics = diagnosticCheck?.ok && !pendingDecision.diagnosticsQuarantined ? pendingDecision.diagnostics : null;
    const rejection = diagnostics?.lastRejection ? projectRejectionForSink(diagnostics.lastRejection, pendingDecision) : null;
    if (session && state === 'playing' && session.loop.playState === 'paused') publicState = 'paused';
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
    const recoveryExit=abortTarget();
    return {
      instanceId,
      appRevision: revision,
      state: publicState,
      gameId: current?.gameId ?? null,
      selectionVersion: current?.selectionVersion ?? 0,
      gameEpoch: epoch,
      setup: currentSetup(),
      defaultSetup,
      pendingDecision: pendingDecision ? {
        decisionId: pendingDecision.decisionId, status: pendingDecision.status,
        code: pendingDecision.code ?? null, softWait: pendingDecision.softWait === true,
        closeConfirmed: pendingDecision.closeConfirmed === true,
        diagnostics: diagnostics ? {detail:diagnostics.detail ?? null, corrections:diagnostics.corrections,
          lastRejection:rejection ? {action:rejection.projection.action, amount:rejection.projection.amount ?? null, detail:rejection.detail} : null} : null,
        diagnosticsQuarantined: pendingDecision.diagnosticsQuarantined === true || !diagnosticCheck.ok,
        retryWillCorrect: retryWillCorrect(pendingDecision),
        freshSessionAvailable: !closed && initialized && publicState === 'paused' && pendingDecision.status === 'recovery_required' && pendingDecision.closeConfirmed === true && currentSetup()?.opponentRuntime === 'llm',
        freshSessionAuthorized: !!pendingDecision.freshAuthorization && typeof pendingDecision.freshAuthorization === 'object',
      } : null,
      allowedCommands:
        closed || !initialized ? [] : (ALLOWED_COMMANDS[publicState] ?? []).filter((kind) =>
          kind === 'retry-decision' ? pendingDecision?.status === 'recovery_required' && pendingDecision.closeConfirmed === true
            : kind === 'resume' && publicState === 'paused' ? !pendingDecision
            : publicState === 'error' && ['end','restart'].includes(kind) ? !!recoveryExit && (kind!=='restart' || currentSetup()!==null) : true),
      pendingRequestId: pending?.requestId ?? null,
      error,
      recoveryExit,
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
  async function launchTracked(args, options) {
    let launched;
    try { launched=await launchSession(args,options); return launched; }
    finally {
      if (launched) startingLoop=null;
      else {
        try {
          const lock=readOwnedLock(root,'loop.lock.d');
          if (!lock || lock.status==='dead') startingLoop=null;
        } catch { /* An unverified owner keeps the recovery gate closed. */ }
      }
    }
  }
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
    const launched = await launchTracked(args, {
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
  function consumeEndedLaunch(launched) {
    if (launched.resumed?.code!=='GAME_ENDED') return false;
    // A terminal launch has released its lock. Never relabel a newly selected
    // game with this launch's outcome; publication remains bound to its target.
    sameCurrent({expectedGameId:launched.gameId,expectedSelectionVersion:launched.selectionVersion});
    current={gameId:launched.gameId,selectionVersion:launched.selectionVersion,sessionDir:launched.sessionDir};
    session=null;
    emit('ended');
    return true;
  }
  async function recoverPaused() {
    const launched = await launchTracked(
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
    if (consumeEndedLaunch(launched)) return false;
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
  async function abortUnrecoverable(row) {
    const recovery=row.recovery;
    if (session || startingLoop || recovery?.kind!=='abort-unrecoverable'
      || !['abort','finalize'].includes(recovery.mode)) throw controlError('INVALID_TRANSITION');
    const launched=await launchTracked({storeDir:root,resume:true,port:0,playerRuntime,
      expectedCurrent:{gameId:recovery.gameId,selectionVersion:recovery.selectionVersion,gameEpoch:recovery.gameEpoch}}, {
      resolver,
      onLoop:async loop=>{startingLoop=loop;if(closed){await loop.requestStop();throw controlError('APP_STOPPING');}},
      loopOptions:{controlProtocolVersion:1,abortUnrecoverable:{operationId:row.requestId}},
    });
    if (consumeEndedLaunch(launched)) return;
    observeRun(launched);
    emit('finalizing');
    await runPromise;
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
      const loop = fs.existsSync(loopFile) ? read(loopFile) : null;
      if (engine.result === "abort" && loop?.aborting) {
        emit("error", code);
        return;
      }
      if (engine.result === "abort") {
        emit("ended", code);
        return;
      }
      if (loop?.phase === "done") {
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
      if (row.recovery?.kind==='abort-unrecoverable') {
        await abortUnrecoverable(row);
        if (row.kind==='restart') {emit('starting');await start(row);}
      } else if (row.kind === "start") {
        emit("starting");
        await start(row);
      } else if (row.kind === "pause") {
        emit("pausing");
        const paused = await session.loop.pause();
        if (!["paused", "finalizing"].includes(paused.state))
          throw controlError("SESSION_STOPPED");
        emit(paused.state);
      } else if (row.kind === 'retry-decision') {
        if (!session) throw controlError('SESSION_STOPPED');
        await session.loop.retryDecision(row.decisionId, {freshAuthorization: row.freshSession ? {source:'app',requestId:row.requestId} : null});
        emit('playing');
      } else if (row.kind === "resume") {
        if (!session) {
          emit("starting");
          await recoverPaused();
        }
        if (session?.loop.playState === "paused") {
          if (session.loop.pendingDecision) emit('paused');
          else {
            await session.loop.resumePlay();
            emit("playing");
          }
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
    if (state==='error' && ['end','restart'].includes(body.kind)) {
      const recoveryExit=abortTarget();
      if (!recoveryExit) throw controlError('INVALID_TRANSITION');
      row.recovery={kind:'abort-unrecoverable',mode:recoveryExit.mode,gameId:current.gameId,
        selectionVersion:current.selectionVersion,gameEpoch:snapshot().gameEpoch};
    }
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
          } else if (row.recovery?.kind==='abort-unrecoverable') {
            await abortUnrecoverable(row);
            if (row.kind==='restart') await start(row,{recover:true});
          } else if (row.kind === "start") await start(row, { recover: true });
          else {
            await recoverPaused();
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
          row.status = row.kind === "retry-decision" ? "failed" : "succeeded";
          if (row.kind === "retry-decision") row.error = "RETRY_NOT_APPLIED";
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
      const loopState = fs.existsSync(
        path.join(current.sessionDir, "loop-state.json"),
      )
        ? read(path.join(current.sessionDir, "loop-state.json"))
        : null;
      if (engine.result === "abort" && loopState?.aborting) {
        emit("error", "SESSION_RECOVERABLE");
        return snapshot();
      }
      if (engine.result === "abort") {
        emit("ended");
        return snapshot();
      }
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
