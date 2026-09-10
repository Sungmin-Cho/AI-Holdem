import { withMutation } from "../engine/state.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { createGameLoop } from "../tools/game-loop.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "managed loop pauses durably, rejects actions, resumes and aborts without review",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-controls");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: {
        port: 0,
        waitMs: 60000,
        opponentRuntime: "policy",
        controlProtocolVersion: 1,
      },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({ ai: 1, stack: 5000, opponentRuntime: "policy" });
    const running = loop.run();
    running.catch(() => {});
    await sleep(300);
    assert.equal((await loop.pause()).state, "paused");
    const before = fs.readFileSync(path.join(root, "state.json"), "utf8");
    await sleep(250);
    assert.equal(
      fs.readFileSync(path.join(root, "state.json"), "utf8"),
      before,
    );
    const lock = JSON.parse(fs.readFileSync(path.join(root, "lock.json")));
    const response = await fetch(
      `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "fold",
          decisionId: "x",
          requestId: "x",
        }),
      },
    );
    assert.equal(response.status, 409);
    await loop.resumePlay();
    await sleep(100);
    await loop.pause();
    await loop.endGame("test-end");
    await running;
    const state = JSON.parse(fs.readFileSync(path.join(root, "state.json")));
    assert.equal(state.result, "abort");
    assert.equal(state.abortOperationId, "test-end");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "loop-state.json"))).phase,
      "aborted",
    );
    assert.equal(fs.existsSync(path.join(root, "review.md")), false);
  },
);

test(
  "ended session resume does not probe models or produce a completed review",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-ended-resume");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: {
        port: 0,
        opponentRuntime: "policy",
        controlProtocolVersion: 1,
        startPaused: true,
      },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({ ai: 1, stack: 5000, opponentRuntime: "policy" });
    const running = loop.run();
    await loop.pause();
    await loop.endGame("ended-resume");
    await running;
    let probes = 0;
    const restored = createGameLoop({
      gameDir: root,
      resolver: async () => {
        probes++;
        throw new Error("must not probe");
      },
      opts: { port: 0, controlProtocolVersion: 1 },
    });
    t.after(() => restored.requestStop());
    const result = await restored.resume();
    assert.equal(result.code, "GAME_ENDED");
    assert.equal(result.resumed, false);
    assert.equal(probes, 0);
    assert.equal(fs.existsSync(path.join(root, "review.md")), false);
  },
);

test(
  "brief control-lock contention retries without killing a running game",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const { acquireOwnedLock, releaseOwnedLock } = await import(
      "../engine/state.js"
    );
    const root = createOwnedTempDir("holdem-control-contention");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: {
        port: 0,
        waitMs: 60000,
        opponentRuntime: "policy",
        controlProtocolVersion: 1,
      },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({ ai: 1, stack: 5000, opponentRuntime: "policy" });
    const running = loop.run();
    running.catch(() => {});
    await sleep(100);
    const held = acquireOwnedLock(root, "session-control.lock.d");
    const released = setTimeout(() => releaseOwnedLock(held), 80);
    t.after(() => clearTimeout(released));
    assert.equal((await loop.pause()).state, "paused");
    assert.equal(loop.stopping, false);
    await loop.endGame("contention-end");
    await running;
  },
);

test(
  "pause drains one admitted LLM decision and admits no next decision",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-inflight-pause");
    let entered = false,
      release,
      calls = 0;
    const gate = new Promise((r) => {
      release = r;
    });
    const adapter = {
      kind: "fake",
      watchdog: { t1Ms: 10000, t2Ms: 1000 },
      async warmup({ playerId }) {
        return { sessionId: `session-${playerId}`, raw: "ready" };
      },
      async decide({ message }) {
        calls++;
        entered = true;
        await gate;
        const decisionId = /decisionId:\s*([^\s]+)/.exec(message)?.[1];
        return { raw: JSON.stringify({ decisionId, action: "fold" }) };
      },
      async dispose() {
        release();
      },
    };
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: adapter, upper: null, notices: [] }),
      opts: { port: 0, controlProtocolVersion: 1, opponentRuntime: "llm" },
    });
    t.after(async () => {
      release();
      await loop.requestStop();
    });
    await loop.bootstrap({
      ai: 2,
      mode: "cash-training",
      hands: 20,
      opponentRuntime: "llm",
    });
    const running = loop.run();
    running.catch(() => {});
    const lock = JSON.parse(fs.readFileSync(path.join(root, "lock.json")));
    for (let i = 0; i < 100 && !entered; i++) {
      const snap = await (
        await fetch(
          `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
        )
      ).json();
      if (snap.view?.legal?.toAct === "user")
        await fetch(
          `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decisionId: snap.view.legal.decisionId,
              requestId: crypto.randomUUID(),
              action: "fold",
            }),
          },
        );
      await sleep(20);
    }
    assert.ok(entered);
    let acknowledged = false;
    const pausing = loop.pause().then((result) => {
      acknowledged = true;
      return result;
    });
    await sleep(60);
    assert.equal(acknowledged, false);
    release();
    assert.equal((await pausing).state, "paused");
    assert.equal(calls, 1);
    await sleep(100);
    assert.equal(calls, 1);
    await loop.endGame("inflight-end");
    await running;
  },
);

test(
  "pause reconciles an accepted receipt whose reply was never delivered to the loop",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const root = createOwnedTempDir("holdem-accepted-drain");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, controlProtocolVersion: 1, opponentRuntime: "policy" },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({
      ai: 1,
      mode: "cash-training",
      hands: 20,
      opponentRuntime: "policy",
    });
    withMutation(root, (state) => {
      state.button =
        (state.seats.findIndex((s) => s.playerId === "user") +
          state.seats.length -
          1) %
        state.seats.length;
      return { state };
    });
    const cli = path.resolve("engine/cli.js"),
      publish = path.resolve("tools/publish.js");
    const initial = JSON.parse(
      (
        await exec(process.execPath, [
          cli,
          "step",
          "--new-hand",
          "--game-dir",
          root,
        ])
      ).stdout,
    );
    assert.equal(initial.next.kind, "user");
    const turn = path.join(root, ".test-turn.json");
    fs.writeFileSync(turn, JSON.stringify(initial));
    await exec(process.execPath, [publish, "--game-dir", root, "--from", turn]);
    const { acquireOwnedLock, releaseOwnedLock } = await import(
      "../engine/state.js"
    );
    const held = acquireOwnedLock(root, "session-control.lock.d");
    setTimeout(() => releaseOwnedLock(held), 80);
    const lock = JSON.parse(fs.readFileSync(path.join(root, "lock.json")));
    const received = await fetch(
      `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisionId: initial.next.decisionId,
          requestId: "lost-reply",
          action: "fold",
        }),
      },
    );
    assert.equal(received.status, 200);
    const before = JSON.parse(
      fs.readFileSync(path.join(root, "state.json")),
    ).stateVersion;
    const paused = loop.pause();
    const running = loop.run();
    running.catch(() => {});
    assert.equal((await paused).state, "paused");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "state.json"))).stateVersion,
      before + 1,
    );
    await loop.endGame("receipt-end");
    await running;
  },
);

test(
  "natural game completion wins a concurrent pause and settles the pause receipt",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-final-pause");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, controlProtocolVersion: 1, opponentRuntime: "policy" },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({
      ai: 1,
      mode: "cash-training",
      hands: 1,
      opponentRuntime: "policy",
    });
    withMutation(root, (state) => {
      state.button =
        (state.seats.findIndex((s) => s.playerId === "user") +
          state.seats.length -
          1) %
        state.seats.length;
      return { state };
    });
    const running = loop.run();
    running.catch(() => {});
    const lock = JSON.parse(fs.readFileSync(path.join(root, "lock.json")));
    let snapshot;
    for (let i = 0; i < 100; i++) {
      snapshot = await (
        await fetch(
          `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
        )
      ).json();
      if (snapshot.view?.legal?.toAct === "user") break;
      await sleep(20);
    }
    assert.equal(snapshot.view?.legal?.toAct, "user");
    await fetch(
      `http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisionId: snapshot.view.legal.decisionId,
          requestId: "last-fold",
          action: "fold",
        }),
      },
    );
    const result = await loop.pause();
    assert.equal(result.state, "finalizing");
    assert.equal((await running).phase, "done");
    assert.notEqual(loop.playState, "paused");
  },
);

test("a new end preserves a stale uncommitted abort audit and completes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const root = createOwnedTempDir("holdem-abort-retry"),
    cli = path.resolve("engine/cli.js");
  await exec(process.execPath, [cli, "init", "--ai", "1", "--game-dir", root]);
  await exec(process.execPath, [cli, "step", "--new-hand", "--game-dir", root]);
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"))),
    old = {
      schemaVersion: 1,
      operationId: "failed-end",
      stateVersion: state.stateVersion,
      hand: state.hand,
      completedHands: 0,
    };
  fs.writeFileSync(path.join(root, ".aborted-hand.json"), JSON.stringify(old));
  await exec(process.execPath, [
    cli,
    "end",
    "--result",
    "abort",
    "--operation-id",
    "retry-end",
    "--game-dir",
    root,
  ]);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, ".aborted-hand.failed-end.json")),
    ),
    old,
  );
  const audit = JSON.parse(
    fs.readFileSync(path.join(root, ".aborted-hand.json")),
  );
  assert.equal(audit.operationId, "retry-end");
  assert.equal(audit.completedHands, 0);
  const ended = JSON.parse(fs.readFileSync(path.join(root, "state.json")));
  await exec(process.execPath, [
    cli,
    "end",
    "--result",
    "abort",
    "--operation-id",
    "retry-end",
    "--game-dir",
    root,
  ]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "state.json"))).stateVersion,
    ended.stateVersion,
  );
});

test(
  "pause recovers a dead owned relay once before acknowledging the drain",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-pause-relay");
    const loop = createGameLoop({
      gameDir: root,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, controlProtocolVersion: 1, opponentRuntime: "policy" },
    });
    t.after(() => loop.requestStop());
    await loop.bootstrap({
      ai: 1,
      mode: "cash-training",
      hands: 20,
      opponentRuntime: "policy",
    });
    withMutation(root, (state) => {
      state.button =
        (state.seats.findIndex((s) => s.playerId === "user") +
          state.seats.length -
          1) %
        state.seats.length;
      return { state };
    });
    const running = loop.run();
    running.catch(() => {});
    const lock = JSON.parse(fs.readFileSync(path.join(root, "lock.json")));
    for (let i = 0; i < 100; i++) {
      const snap = await (
        await fetch(
          `http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`,
        )
      ).json();
      if (snap.view?.legal?.toAct === "user") break;
      await sleep(20);
    }
    const oldPid = loop.serverPid;
    process.kill(oldPid, "SIGTERM");
    const result = await loop.pause();
    assert.equal(result.state, "paused");
    assert.equal(loop.stopping, false);
    assert.notEqual(loop.serverPid, oldPid);
    await loop.endGame("relay-pause-end");
    await running;
  },
);
