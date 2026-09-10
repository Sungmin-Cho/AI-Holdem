import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { createSessionManager } from "../tools/session-manager.js";
import { prepareSession, commitSession } from "../engine/session-catalog.js";
import { initializePreparedSession } from "../tools/game-loop.js";
import {
  sealPreparation,
  readPreparation,
} from "../tools/session-preparation.js";
import { normalizeSetup } from "../shared/game-setup.js";
const resolver = async () => ({ player: null, upper: null, notices: [] });
const payload = (manager, kind = "start") => {
  const s = manager.snapshot();
  return {
    requestId: randomUUID(),
    expectedInstanceId: s.instanceId,
    expectedAppRevision: s.appRevision,
    expectedGameId: s.gameId,
    expectedSelectionVersion: s.selectionVersion,
    kind,
  };
};
const settle = async (manager, id) => {
  const deadline = Date.now() + (process.platform === "win32" ? 240000 : 15000);
  while (Date.now() < deadline) {
    const row = manager.receipt(id);
    if (row.status !== "accepted") return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("receipt timeout");
};
test(
  "request identity survives stale CAS and reordered JSON; new requests cannot race",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("lobby-journal"),
      manager = createSessionManager({ storeDir: root, resolver });
    t.after(() => manager.close());
    await manager.initialize();
    const body = {
      ...payload(manager),
      setup: { aiCount: 1, mode: "cash-training" },
    };
    const first = manager.command(body);
    assert.equal(first.status, "accepted");
    assert.equal(
      manager.command({ ...body, setup: { mode: "cash-training", aiCount: 1 } })
        .requestId,
      body.requestId,
    );
    assert.throws(() => manager.command({ ...body, setup: { aiCount: 2 } }), {
      code: "REQUEST_ID_CONFLICT",
    });
    assert.throws(() => manager.command({ ...body, requestId: randomUUID() }), {
      code: "COMMAND_PENDING",
    });
    assert.equal((await settle(manager, body.requestId)).status, "succeeded");
    assert.equal(manager.command(body).status, "succeeded");
    assert.throws(() => manager.command({ ...body, requestId: randomUUID() }), {
      code: "STALE_APP",
    });
    const pause = payload(manager, "pause");
    manager.command(pause);
    await settle(manager, pause.requestId);
    const end = payload(manager, "end");
    manager.command(end);
    await settle(manager, end.requestId);
  },
);
test('managed command journal retries the displayed LLM decision once and preserves configured budget', { timeout: process.platform === 'win32' ? 300000 : 30000 }, async (t) => {
  const root = createOwnedTempDir('lobby-llm-recovery');
  const calls = [];
  const adapter = { kind: 'fake',
    async warmup({playerId}) { return {sessionId:`session-${playerId}`,raw:'ready'}; },
    async decide(input) { calls.push(input); return {raw:'invalid'}; }, async dispose() {} };
  const manager = createSessionManager({storeDir:root,
    resolver:async()=>({player:adapter,upper:null,notices:[]})});
  t.after(()=>manager.close());
  await manager.initialize();
  const start = {...payload(manager),setup:{aiCount:5,opponentRuntime:'llm',playerSoftMs:100,playerHardMs:1000}};
  manager.command(start);
  assert.equal((await settle(manager,start.requestId)).status,'succeeded');
  const waitPaused = async () => {
    const deadline = Date.now() + (process.platform === 'win32' ? 120000 : 10000);
    while (manager.snapshot().state !== 'paused' && Date.now() < deadline) await new Promise(r=>setTimeout(r,20));
    assert.equal(manager.snapshot().state,'paused');
  };
  await waitPaused();
  assert.equal(manager.snapshot().allowedCommands.includes('resume'),false);
  const retry = {...payload(manager,'retry-decision'), decisionId:manager.snapshot().pendingDecision.decisionId};
  manager.command(retry);
  manager.command(retry);
  assert.equal((await settle(manager,retry.requestId)).status,'succeeded');
  await waitPaused();
  assert.deepEqual(calls.map(call=>call.timeoutMs),[1000,1000]);
  const end = payload(manager,'end');
  manager.command(end);
  assert.equal((await settle(manager,end.requestId)).status,'succeeded');
  assert.equal(manager.snapshot().state,'ended');
});

test("reserved initialization proof rejects partial state and permits sealed commit recovery", async () => {
  const root = createOwnedTempDir("lobby-preparation");
  const reservation = { gameId: randomUUID(), selectionVersion: 1 };
  let prepared = prepareSession(root, reservation);
  assert.throws(() => readPreparation(prepared), { code: "RECOVERY_REQUIRED" });
  const initialized = await initializePreparedSession(prepared.stagingDir, {
    ai: 1,
    opponentRuntime: "policy",
  });
  sealPreparation(prepared, initialized);
  prepared = prepareSession(root, reservation);
  assert.equal(prepared.recovering, true);
  assert.equal(
    readPreparation(prepared).sessionToken,
    initialized.sessionToken,
  );
  fs.renameSync(prepared.stagingDir, prepared.sessionDir);
  assert.equal(
    readPreparation(prepared).sessionToken,
    initialized.sessionToken,
  );
  const committed = commitSession(root, prepared);
  assert.equal(committed.gameId, reservation.gameId);
  assert.throws(() => prepareSession(root, reservation), {
    code: "CURRENT_CHANGED",
  });
});
test(
  "accepted start journal recovers exactly its reserved game, parked",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("lobby-journal-recover");
    let manager = createSessionManager({ storeDir: root, resolver });
    await manager.initialize();
    const body = { ...payload(manager), setup: normalizeSetup({ aiCount: 1 }) };
    const row = {
      ...body,
      payload: JSON.stringify(body),
      status: "accepted",
      reservation: { gameId: randomUUID(), selectionVersion: 1 },
    };
    fs.writeFileSync(
      path.join(root, ".app", "commands", `${body.requestId}.json`),
      JSON.stringify(row),
    );
    manager = createSessionManager({ storeDir: root, resolver });
    t.after(() => manager.close());
    await manager.initialize();
    assert.equal(manager.snapshot().state, "paused");
    assert.equal(manager.snapshot().gameId, row.reservation.gameId);
    assert.equal(manager.receipt(body.requestId).status, "succeeded");
    const end = payload(manager, "end");
    manager.command(end);
    assert.equal((await settle(manager, end.requestId)).status, "succeeded");
  },
);

test(
  "committed reservation without loop-state resumes without reinitializing",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const { resolveSessionReference } = await import(
      "../tools/reference-source.js"
    );
    const root = createOwnedTempDir("lobby-committed-recover");
    let manager = createSessionManager({ storeDir: root, resolver });
    await manager.initialize();
    const body = { ...payload(manager), setup: normalizeSetup({ aiCount: 1 }) },
      reservation = { gameId: randomUUID(), selectionVersion: 1 };
    const prepared = prepareSession(root, reservation);
    const initialized = await initializePreparedSession(prepared.stagingDir, {
      ai: 1,
      mode: "cash-training",
      hands: 20,
      opponentRuntime: "policy",
    });
    resolveSessionReference(prepared.stagingDir, { createNew: true });
    sealPreparation(prepared, initialized);
    commitSession(root, prepared);
    const row = {
      ...body,
      payload: JSON.stringify(body),
      status: "accepted",
      reservation,
    };
    fs.writeFileSync(
      path.join(root, ".app", "commands", `${body.requestId}.json`),
      JSON.stringify(row),
    );
    manager = createSessionManager({ storeDir: root, resolver });
    t.after(() => manager.close());
    await manager.initialize();
    assert.equal(manager.snapshot().state, "paused");
    assert.equal(manager.snapshot().gameId, reservation.gameId);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(prepared.sessionDir, "state.json")))
        .sessionToken,
      initialized.sessionToken,
    );
  },
);
test(
  "bootstrap failure refreshes current so a later resume is not stuck on stale CAS",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const root = createOwnedTempDir("lobby-bootstrap-failure");
    let fail = true;
    const manager = createSessionManager({
      storeDir: root,
      resolver: async () => {
        if (fail)
          throw Object.assign(new Error("probe failure"), {
            code: "NO_PLAYER_RUNTIME",
          });
        return resolver();
      },
    });
    t.after(() => manager.close());
    await manager.initialize();
    const start = { ...payload(manager), setup: { aiCount: 1 } };
    manager.command(start);
    assert.equal((await settle(manager, start.requestId)).status, "failed");
    assert.ok(manager.snapshot().gameId);
    assert.equal(manager.snapshot().state, "error");
    fail = false;
    const resume = payload(manager, "resume");
    manager.command(resume);
    const recovered = await settle(manager, resume.requestId);
    assert.equal(recovered.status, "succeeded", recovered.error);
    assert.equal(manager.snapshot().state, "playing");
  },
);
test(
  "close interrupts an active user wait before waiting for a pending pause",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async () => {
    const root = createOwnedTempDir("lobby-close-pending");
    const manager = createSessionManager({ storeDir: root, resolver });
    await manager.initialize();
    const start = { ...payload(manager), setup: { aiCount: 1 } };
    manager.command(start);
    await settle(manager, start.requestId);
    const pause = payload(manager, "pause");
    manager.command(pause);
    const started = Date.now();
    await manager.close();
    assert.ok(Date.now() - started < 5000);
    assert.notEqual(manager.receipt(pause.requestId).status, "accepted");
  },
);

test(
  "close owns and interrupts bootstrap before a running session is published",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async () => {
    const root = createOwnedTempDir("lobby-bootstrap-stop");
    let entered, release;
    const entering = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    const manager = createSessionManager({
      storeDir: root,
      resolver: async () => {
        entered();
        await gate;
        return resolver();
      },
    });
    await manager.initialize();
    const start = { ...payload(manager), setup: { aiCount: 1 } };
    manager.command(start);
    await entering;
    const closing = manager.close();
    setTimeout(release, 30);
    await closing;
    assert.equal(manager.receipt(start.requestId).status, "failed");
    assert.deepEqual(manager.snapshot().allowedCommands, []);
  },
);

test("lobby notices an external loop owner has exited", async () => {
  const { acquireOwnedLock, releaseOwnedLock } = await import(
    "../engine/state.js"
  );
  const root = createOwnedTempDir("lobby-external");
  const manager = createSessionManager({ storeDir: root, resolver });
  // Publish a valid current session, as the standalone launcher does.
  const prepared = prepareSession(root);
  await initializePreparedSession(prepared.stagingDir, {
    ai: 1,
    opponentRuntime: "policy",
  });
  commitSession(root, prepared);
  const owner = acquireOwnedLock(root, "loop.lock.d");
  await manager.initialize();
  assert.equal(manager.snapshot().state, "external");
  releaseOwnedLock(owner);
  assert.equal(manager.snapshot().state, "error");
  assert.ok(manager.snapshot().allowedCommands.includes("resume"));
  await manager.close();
});
