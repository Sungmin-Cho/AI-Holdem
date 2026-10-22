import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { createSessionManager } from "../tools/session-manager.js";
import { prepareSession, commitSession, resolveCurrentSession } from "../engine/session-catalog.js";
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
// #319 F3: what a failed or unsettled command left behind — the receipt's code, its result's code
// and detail, and the manager's state — so a failure that does not reproduce still names its cause.
const commandState = (manager, id) => {
  const row = manager.receipt(id);
  const snap = manager.snapshot();
  return JSON.stringify({
    requestId: id, kind: row?.kind, status: row?.status, error: row?.error,
    diagnostic: row?.diagnostic, resultError: row?.result?.error, resultDetail: row?.result?.errorDetail,
    state: snap.state, managerError: snap.error, managerDetail: snap.errorDetail,
  });
};
const settle = async (manager, id) => {
  const deadline = Date.now() + (process.platform === "win32" ? 240000 : 15000);
  while (Date.now() < deadline) {
    const row = manager.receipt(id);
    if (row.status !== "accepted") return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`receipt timeout ${commandState(manager, id)}`);
};
const succeeded = async (manager, id) => {
  const row = await settle(manager, id);
  assert.equal(row.status, "succeeded", commandState(manager, id));
  return row;
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
// #273/#274 lifetime contract (6): a journal row written by an earlier version may hold raw
// adapter/child codes. Every public return of a receipt — the idempotent replay of the same
// command, receipt(), the nested result snapshot — passes one projection; the row's bytes and
// the request-id conflict check are untouched.
test('legacy receipt codes are projected on every public return path, including the idempotent command replay, while the journal row and its identity stay as recorded', { timeout: process.platform === 'win32' ? 300000 : 30000 }, async (t) => {
  const SECRET = 'SECRET_LEGACY_REPLAY_MARKER_As_Kh';
  const root = createOwnedTempDir('lobby-legacy-receipt');
  const manager = createSessionManager({ storeDir: root, resolver });
  t.after(() => manager.close());
  await manager.initialize();
  const body = { ...payload(manager), setup: { aiCount: 1, mode: 'cash-training' } };
  manager.command(body);
  assert.equal((await settle(manager, body.requestId)).status, 'succeeded');
  // Ended the way a host ends a game: pause first (end is not an allowed command while playing).
  const pause = payload(manager, 'pause');
  manager.command(pause);
  assert.equal((await settle(manager, pause.requestId)).status, 'succeeded');
  const end = payload(manager, 'end');
  manager.command(end);
  assert.equal((await settle(manager, end.requestId)).status, 'succeeded');
  // The row as an earlier version could have left it: raw codes in every code-bearing field.
  const file = path.join(root, '.app', 'commands', `${body.requestId}.json`);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  legacy.status = 'failed';
  legacy.error = SECRET;
  legacy.result = {
    ...legacy.result,
    error: SECRET,
    errorDetail: { run: SECRET, cleanup: SECRET, rejection: { httpStatus: 400, serverCode: SECRET }, recheckRejection: { httpStatus: 409, serverCode: `${SECRET}_2` } },
    pendingDecision: { decisionId: 'd-1-preflop-0', status: 'recovery_required', code: SECRET },
  };
  const legacyBytes = JSON.stringify(legacy);
  fs.writeFileSync(file, legacyBytes);

  const replayed = manager.command(body);
  const receipt = manager.receipt(body.requestId);
  for (const [label, row] of [['replay', replayed], ['receipt', receipt]]) {
    assert.equal(row.requestId, body.requestId, label);
    assert.equal(row.status, 'failed', label);
    assert.equal(row.error, 'UNLISTED', label);
    assert.equal(row.result.error, 'UNLISTED', label);
    assert.deepEqual(row.result.errorDetail, {
      run: 'UNLISTED', cleanup: 'UNLISTED',
      rejection: { httpStatus: 400, serverCode: 'UNLISTED' },
      recheckRejection: { httpStatus: 409, serverCode: 'UNLISTED' },
    }, label);
    assert.equal(row.result.pendingDecision.code, 'UNLISTED', label);
    assert.equal(row.result.pendingDecision.decisionId, 'd-1-preflop-0', `${label}: non-code fields are kept`);
    assert.equal(JSON.stringify(row).includes('SECRET'), false, `${label}: no raw code anywhere in the complete object`);
    assert.equal(JSON.stringify(row).includes('As_Kh'), false, label);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), legacyBytes, 'the journal row is never rewritten by a public read');
  assert.throws(() => manager.command({ ...body, setup: { aiCount: 2, mode: 'cash-training' } }), { code: 'REQUEST_ID_CONFLICT' }, 'identity is still compared on the recorded payload');
  assert.equal(fs.readFileSync(file, 'utf8'), legacyBytes);
});

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
    let submitted=false;
    const lock=JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir,'lock.json')));
    const base=`http://127.0.0.1:${lock.port}`;
    while (manager.snapshot().state !== 'paused' && Date.now() < deadline) {
      // The initial button is random. If the user acts first, advance that
      // real UI decision rather than assuming an AI recovery already exists.
      if(calls.length===0&&!submitted) {
        const snapshot=await (await fetch(`${base}/api/snapshot?token=${lock.sessionToken}`)).json();
        if(snapshot.view?.legal?.toAct==='user') {
          const response=await fetch(`${base}/api/action?token=${lock.sessionToken}`,{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({decisionId:snapshot.view.legal.decisionId,requestId:randomUUID(),action:'fold'})});
          assert.equal(response.ok,true);submitted=true;
        }
      }
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(manager.snapshot().state,'paused');
  };
  await waitPaused();
  assert.equal(manager.snapshot().pendingDecision.freshSessionAvailable,true);
  assert.equal(manager.snapshot().pendingDecision.freshSessionAuthorized,false);
  const originalRetry = manager.session.loop.retryDecision;
  let forwarded;
  manager.session.loop.retryDecision = async (id, options) => { forwarded=options; return originalRetry(id,options); };
  assert.equal(manager.snapshot().allowedCommands.includes('resume'),false);
  assert.deepEqual(manager.snapshot().pendingDecision.diagnostics,{detail:'no_json',corrections:1,lastRejection:{action:'unknown',amount:null,detail:'no_json'}});
  assert.equal(manager.snapshot().pendingDecision.retryWillCorrect,true);
  assert.equal(JSON.stringify(manager.snapshot()).includes('invalid'),false);
  const retry = {...payload(manager,'retry-decision'), decisionId:manager.snapshot().pendingDecision.decisionId};
  manager.command(retry);
  manager.command(retry);
  assert.equal((await settle(manager,retry.requestId)).status,'succeeded');
  assert.deepEqual(forwarded,{freshAuthorization:null});
  assert.throws(()=>manager.command({...retry,freshSession:false}),{code:'REQUEST_ID_CONFLICT'});
  await waitPaused();
  assert.equal(calls.length,4);
  assert.equal(calls[0].timeoutMs,1000); assert.equal(calls[2].timeoutMs,1000);
  assert.ok(calls[1].timeoutMs<=1000); assert.ok(calls[3].timeoutMs<=1000);
  assert.deepEqual(calls.map(x=>(x.message.match(/\[교정\]/g)||[]).length),[0,1,1,1]);
  const loopPath=path.join(manager.current.sessionDir,'loop-state.json');
  const saved=JSON.parse(fs.readFileSync(loopPath));
  for(const diagnostics of [null,{...saved.pendingDecision.diagnostics,lastRejection:{...saved.pendingDecision.diagnostics.lastRejection,projection:{action:'PRIVATE_SENTINEL',decisionIdMatches:true}}}]) {
    fs.writeFileSync(loopPath,JSON.stringify({...saved,pendingDecision:{...saved.pendingDecision,diagnostics}}));
    const snap=manager.snapshot().pendingDecision;
    assert.equal(snap.diagnostics,null); assert.equal(snap.diagnosticsQuarantined,true); assert.equal(snap.retryWillCorrect,false);
    assert.equal(JSON.stringify(manager.snapshot()).includes('PRIVATE_SENTINEL'),false);
  }
  for(const patch of [{diagnostics:undefined},{schemaVersion:1,diagnostics:undefined},{code:'TIMEOUT',diagnostics:{v:1,callNo:1,corrections:0}}]) {
    const pending={...saved.pendingDecision,...patch};
    if(patch.diagnostics===undefined) delete pending.diagnostics;
    fs.writeFileSync(loopPath,JSON.stringify({...saved,pendingDecision:pending}));
    const snap=manager.snapshot().pendingDecision;
    assert.equal(snap.retryWillCorrect,false);
    assert.equal(snap.diagnosticsQuarantined,patch.diagnostics===undefined&&patch.schemaVersion!==1);
  }
  const retained={...saved.pendingDecision.diagnostics};delete retained.detail;
  fs.writeFileSync(loopPath,JSON.stringify({...saved,pendingDecision:{...saved.pendingDecision,code:'TIMEOUT',diagnostics:retained}}));
  assert.equal(manager.snapshot().pendingDecision.retryWillCorrect,true);
  assert.equal(manager.snapshot().pendingDecision.diagnosticsQuarantined,false);
  fs.writeFileSync(loopPath,JSON.stringify(saved));
  const end = payload(manager,'end');
  manager.command(end);
  assert.equal((await settle(manager,end.requestId)).status,'succeeded');
  assert.equal(manager.snapshot().state,'ended');
});

test('fresh retry command forwards app authority and warms a new LLM seat session', { timeout: process.platform === 'win32' ? 300000 : 30000 }, async (t) => {
  const root = createOwnedTempDir('lobby-fresh-llm-recovery');
  let releaseWarmup;
  let freshWarmup = false;
  const warmupGate = new Promise((resolve) => { releaseWarmup = resolve; });
  const calls = [];
  const decisions = [];
  const adapter = {
    kind: 'fake',
    async warmup({ playerId }) {
      calls.push({ playerId });
      if (calls.length === 2) {
        freshWarmup = true;
        await warmupGate;
      }
      return { sessionId: `fresh-session-${calls.length}`, raw: 'ready' };
    },
    async decide(input) { decisions.push(input); return { raw: 'invalid' }; },
    async dispose() {},
  };
  let manager = createSessionManager({ storeDir: root,
    resolver: async () => ({ player: adapter, upper: null, notices: [] }) });
  t.after(() => manager.close());
  await manager.initialize();
  const start = { ...payload(manager), setup: { aiCount: 1, opponentRuntime: 'llm', playerSoftMs: 1000, playerHardMs: 10000 } };
  manager.command(start);
  assert.equal((await settle(manager, start.requestId)).status, 'succeeded');
  const deadline = Date.now() + (process.platform === 'win32' ? 120000 : 10000);
  let submitted = false;
  while (manager.snapshot().state !== 'paused' && Date.now() < deadline) {
    if (!submitted) {
      const lock = JSON.parse(fs.readFileSync(path.join(manager.current.sessionDir, 'lock.json')));
      const snapshot = await (await fetch(`http://127.0.0.1:${lock.port}/api/snapshot?token=${lock.sessionToken}`)).json();
      if (snapshot.view?.legal?.toAct === 'user') {
        const response = await fetch(`http://127.0.0.1:${lock.port}/api/action?token=${lock.sessionToken}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decisionId: snapshot.view.legal.decisionId, requestId: randomUUID(), action: 'fold' }),
        });
        assert.equal(response.ok, true);
        submitted = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.snapshot().state, 'paused');
  const loopFilename=path.join(manager.current.sessionDir,'loop-state.json');
  const parkedBytes=fs.readFileSync(loopFilename);
  const parked=JSON.parse(parkedBytes);
  fs.writeFileSync(loopFilename,JSON.stringify({...parked,pendingDecision:{...parked.pendingDecision,
    status:'retry_authorized',freshAuthorization:{source:'app',requestId:'projection-only'}}}));
  assert.equal(manager.snapshot().pendingDecision.freshSessionAuthorized,true);
  fs.writeFileSync(loopFilename,parkedBytes);
  const setupFilename=path.join(manager.current.sessionDir,'.app-setup.json');
  const setupBytes=fs.readFileSync(setupFilename);
  fs.writeFileSync(setupFilename,JSON.stringify({...JSON.parse(setupBytes),opponentRuntime:'policy'}));
  assert.equal(manager.snapshot().pendingDecision.freshSessionAvailable,false);
  fs.writeFileSync(setupFilename,setupBytes);
  const originalRetry = manager.session.loop.retryDecision;
  let forwarded;
  manager.session.loop.retryDecision = async (decisionId, options) => {
    forwarded = { decisionId, options };
    return originalRetry(decisionId, options);
  };
  const retry = { ...payload(manager, 'retry-decision'), decisionId: manager.snapshot().pendingDecision.decisionId, freshSession: true };
  manager.command(retry);
  assert.equal(manager.command(retry).requestId, retry.requestId);
  assert.equal((await settle(manager, retry.requestId)).status, 'succeeded');
  assert.deepEqual(forwarded, { decisionId: retry.decisionId, options: { freshAuthorization: { source: 'app', requestId: retry.requestId } } });
  const warmupDeadline = Date.now() + (process.platform === 'win32' ? 120000 : 10000);
  while (!freshWarmup && Date.now() < warmupDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(freshWarmup, true);
  assert.equal(calls.length, 2);
  assert.throws(()=>manager.command({...payload(manager,'retry-decision'),decisionId:retry.decisionId,freshSession:true}),{code:'INVALID_TRANSITION'});
  releaseWarmup();
  while (manager.snapshot().state !== 'paused' && Date.now() < warmupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.snapshot().state, 'paused');
  // A restored accepted retry cannot certify an authorization that never ran.
  assert.deepEqual(decisions.map(({ message }) => Number(message.includes('[교정]'))), [0, 1, 0, 1]);
  for (const freshSession of [false, true]) {
    const abandoned = { ...payload(manager, 'retry-decision'),
      decisionId: manager.snapshot().pendingDecision.decisionId, freshSession };
    const beforeWarmups = calls.length;
    const beforeDecisions = decisions.length;
    await manager.close();
    const engineFilename = path.join(manager.current.sessionDir, 'state.json');
    const engineBefore = fs.readFileSync(engineFilename);
    fs.writeFileSync(path.join(root, '.app', 'commands', `${abandoned.requestId}.json`),
      JSON.stringify({ ...abandoned, payload: JSON.stringify(abandoned), status: 'accepted' }));
    manager = createSessionManager({ storeDir: root,
      resolver: async () => ({ player: adapter, upper: null, notices: [] }) });
    await manager.initialize();
    const recovered = manager.snapshot();
    assert.equal(recovered.state, 'paused', JSON.stringify({
      freshSession, state: recovered.state, error: recovered.error,
      receiptError: manager.receipt(abandoned.requestId)?.error,
    }));
    assert.equal(manager.receipt(abandoned.requestId).status, 'failed');
    assert.equal(manager.receipt(abandoned.requestId).error, 'RETRY_NOT_APPLIED');
    assert.equal(calls.length, beforeWarmups);
    assert.equal(decisions.length, beforeDecisions);
    assert.deepEqual(fs.readFileSync(engineFilename), engineBefore);
  }
  const end = payload(manager, 'end');
  manager.command(end);
  assert.equal((await settle(manager, end.requestId)).status, 'succeeded');
});

test('managed favorable deal survives app restart and restart-game setup', {timeout:process.platform==='win32'?300000:30000}, async t=>{
  const root=createOwnedTempDir('lobby-biased-deal');
  let manager=createSessionManager({storeDir:root,resolver});
  t.after(()=>manager.close());
  await manager.initialize();
  const start={...payload(manager),setup:{aiCount:1,dealBias:'strong'}};
  manager.command(start);await succeeded(manager,start.requestId);
  const pause=payload(manager,'pause');manager.command(pause);await succeeded(manager,pause.requestId);
  const gameId=manager.snapshot().gameId;
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  await manager.close();
  manager=createSessionManager({storeDir:root,resolver});await manager.initialize();
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  const resume=payload(manager,'resume');manager.command(resume);await succeeded(manager,resume.requestId);
  const repause=payload(manager,'pause');manager.command(repause);await succeeded(manager,repause.requestId);
  const restart=payload(manager,'restart');manager.command(restart);await succeeded(manager,restart.requestId);
  assert.notEqual(manager.snapshot().gameId,gameId);
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  const state=JSON.parse(fs.readFileSync(path.join(resolveCurrentSession(root).sessionDir,'state.json')));
  assert.equal(state.config.dealBias,'strong');
  const paused=payload(manager,'pause');manager.command(paused);await settle(manager,paused.requestId);
  const end=payload(manager,'end');manager.command(end);await succeeded(manager,end.requestId);
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
    // An LLM game still blocks on the runtime probe, so a probe failure fails
    // bootstrap. (Policy games probe the upper model in the background and fall
    // back instead of failing.)
    const player = { kind: "fake",
      async warmup({ playerId }) { return { sessionId: `session-${playerId}`, raw: "ready" }; },
      async decide() { return { raw: "invalid" }; }, async dispose() {} };
    const manager = createSessionManager({
      storeDir: root,
      resolver: async () => {
        if (fail)
          throw Object.assign(new Error("probe failure"), {
            code: "NO_PLAYER_RUNTIME",
          });
        return { player, upper: null, notices: [] };
      },
    });
    t.after(() => manager.close());
    await manager.initialize();
    const start = { ...payload(manager), setup: { aiCount: 1, opponentRuntime: "llm" } };
    manager.command(start);
    assert.equal((await settle(manager, start.requestId)).status, "failed");
    assert.ok(manager.snapshot().gameId);
    assert.equal(manager.snapshot().state, "error");
    assert.equal(manager.session,null);
    const {startAppServer}=await import('../tools/app-server.js');
    const app=await startAppServer({manager,token:'recovery-transport',storeDir:root,publicPort:0});t.after(()=>app.close());
    const gameBefore=manager.snapshot();
    const response=await fetch(`${app.origin}/api/game/${gameBefore.gameId}/events`,{headers:{authorization:'Bearer recovery-transport','x-game-epoch':gameBefore.gameEpoch}});
    assert.equal(response.status,503);assert.equal((await response.json()).code,'SESSION_UNAVAILABLE');
    fail = false;
    const resume = payload(manager, "resume");
    manager.command(resume);
    const recovered = await settle(manager, resume.requestId);
    assert.equal(recovered.status, "succeeded", recovered.error);
    assert.equal(manager.snapshot().state, "playing");
    assert.equal(manager.snapshot().gameId,gameBefore.gameId);
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

for (const pace of [undefined, 'normal']) {
  test(`pace ${pace ?? 'legacy'} survives app restart and same-settings restart`, {timeout:process.platform==='win32'?300000:60000}, async t => {
    const expectSuccess=requestId=>succeeded(manager,requestId);
    const root=createOwnedTempDir('lobby-pace');
    let manager=createSessionManager({storeDir:root,resolver});
    t.after(()=>manager.close());
    await manager.initialize();
    const start={...payload(manager),setup:{aiCount:1,hands:2,...(pace?{pace}:{})}};
    manager.command(start);await expectSuccess(start.requestId);
    let pause=payload(manager,'pause');manager.command(pause);await expectSuccess(pause.requestId);
    assert.equal(manager.snapshot().setup.pace,pace);
    await manager.close();
    manager=createSessionManager({storeDir:root,resolver});await manager.initialize();
    const resume=payload(manager,'resume');manager.command(resume);await expectSuccess(resume.requestId);
    const dir=manager.current.sessionDir;let holdSeen=false;const decisions=new Set();
    const deadline=Date.now()+(process.platform==='win32'?120000:20000);
    while(Date.now()<deadline) {
      const snap=JSON.parse(fs.readFileSync(path.join(dir,'ui-snapshot.json')));
      if(snap.resultHold) {
        holdSeen=true;assert.equal(pace,'normal');
        assert.equal(Date.parse(snap.resultHold.until)-Date.parse(snap.resultHold.startAt),3500+800*snap.resultHold.runoutStreets);
        manager.session.loop.skipHandResult(snap.resultHold.handNo);
      }
      if(snap.view.handNo>=2)break;
      const legal=snap.view.legal;
      if(snap.view.toAct==='user' && legal?.decisionId && !decisions.has(legal.decisionId)) {
        const lock=JSON.parse(fs.readFileSync(path.join(dir,'lock.json')));
        const response=await fetch(`http://127.0.0.1:${lock.port}/api/action`,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({token:lock.sessionToken,decisionId:legal.decisionId,requestId:randomUUID(),action:legal.canCheck?'check':'fold'})});
        assert.equal(response.ok,true);decisions.add(legal.decisionId);
      }
      await new Promise(r=>setTimeout(r,10));
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).handNo>=2);
    assert.equal(holdSeen,pace==='normal');
    pause=payload(manager,'pause');manager.command(pause);await expectSuccess(pause.requestId);
    const restart=payload(manager,'restart');manager.command(restart);await expectSuccess(restart.requestId);
    assert.notEqual(manager.current.sessionDir,dir);
    assert.equal(manager.snapshot().setup.pace,pace);
  });
}

// #319 F5: SERVER_IDENTITY_UNAVAILABLE now names the check that threw it. The closed site (and,
// where a start time could not be read, whether the pid still answered just after) is copied onto
// the journal row and receipt(), so the next failure says where it came from. The HTTP receipt,
// narrowed by app-server, never carries it, and nothing outside the closed set is copied.
test("#319 F5: a failure's closed site reaches receipt() but never the HTTP receipt", { timeout: process.platform === "win32" ? 300000 : 30000 }, async (t) => {
  const { SERVER_IDENTITY_SITES } = await import("../tools/diagnostic-codes.js");
  let thrown = null;
  const root = createOwnedTempDir("lobby-identity-site");
  const manager = createSessionManager({ storeDir: root, resolver: async () => { throw thrown; } });
  t.after(() => manager.close());
  await manager.initialize();
  const { startAppServer } = await import("../tools/app-server.js");
  const app = await startAppServer({ manager, token: "identity-site", storeDir: root, publicPort: 0 });
  t.after(() => app.close());
  const run = async (error) => {
    thrown = error;
    const kind = manager.snapshot().allowedCommands.includes("start") ? "start" : "resume";
    const body = { ...payload(manager, kind), ...(kind === "start" ? { setup: { aiCount: 1, opponentRuntime: "llm" } } : {}) };
    manager.command(body);
    const row = await settle(manager, body.requestId);
    assert.equal(row.status, "failed", commandState(manager, body.requestId));
    const http = await (await fetch(`${app.origin}/api/commands/${body.requestId}`, { headers: { authorization: "Bearer identity-site" } })).json();
    assert.deepEqual([http.requestId, http.status, http.error], [body.requestId, "failed", row.error]);
    assert.ok(Object.keys(http).every((key) => ["error", "requestId", "result", "status"].includes(key)), JSON.stringify(http));
    assert.equal(JSON.stringify(http).includes("diagnostic"), false);
    return row;
  };
  const coded = (code, extra) => Object.assign(new Error(`${code} /private/store pid 4242`), { code, ...extra });
  const site = SERVER_IDENTITY_SITES[4];
  let row = await run(coded("SERVER_IDENTITY_UNAVAILABLE", { site, pidAfter: "gone" }));
  assert.deepEqual([row.error, row.diagnostic], ["SERVER_IDENTITY_UNAVAILABLE", { site, pidAfter: "gone" }]);
  row = await run(coded("SERVER_IDENTITY_UNAVAILABLE", { site, pidAfter: "/private/store" }));
  assert.deepEqual(row.diagnostic, { site }, "only alive or gone is copied");
  for (const error of [coded("SERVER_IDENTITY_UNAVAILABLE", { site: "/private/store" }),
    coded("SERVER_IDENTITY_UNAVAILABLE", {}), coded("SERVER_ALIVE", { site })]) {
    row = await run(error);
    assert.equal("diagnostic" in row, false, JSON.stringify(row));
  }
});

// Every throw of SERVER_IDENTITY_UNAVAILABLE in the loop names a site of the closed set, and no two
// checks share one: otherwise the next failure could not be traced back to a single check.
test("#319 F5: every SERVER_IDENTITY_UNAVAILABLE in the loop names one site of the closed set, once", async () => {
  const { SERVER_IDENTITY_SITES } = await import("../tools/diagnostic-codes.js");
  const source = fs.readFileSync(new URL("../tools/game-loop.js", import.meta.url), "utf8");
  assert.equal(Object.isFrozen(SERVER_IDENTITY_SITES), true);
  assert.equal(/codedError\(\s*['"]SERVER_IDENTITY_UNAVAILABLE['"]/.test(source.replace(/function serverIdentityUnavailable[\s\S]*?\n}\n/, "")), false,
    "a bare throw names no site");
  const named = [...source.matchAll(/serverIdentityUnavailable\(\s*'([^']+)'/g), ...source.matchAll(/unavailableSite: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(source.match(/unavailableCode: 'SERVER_IDENTITY_UNAVAILABLE'/g).length, source.match(/unavailableSite: '/g).length,
    "each wait for the server's death names its own site");
  assert.deepEqual([...named].sort(), [...SERVER_IDENTITY_SITES].sort());
});

// #319 F5 (review r2): what receipt() returns of a stored diagnostic is the closed site of the row's own
// failure or nothing — the journal bytes stay as they were — and a recovered success carries none.
test("#319 F5: a stored diagnostic is re-checked on read and dropped by a recovered success", { timeout: process.platform === "win32" ? 300000 : 30000 }, async (t) => {
  const root = createOwnedTempDir("lobby-stored-diagnostic");
  let manager = createSessionManager({ storeDir: root, resolver });
  t.after(() => manager.close());
  await manager.initialize();
  const journal = path.join(root, ".app", "commands");
  const site = { site: "reuse-start-time", pidAfter: "gone" };
  const rows = [
    ["valid", { status: "failed", error: "SERVER_IDENTITY_UNAVAILABLE", diagnostic: site }, site],
    ["foreign-site", { status: "failed", error: "SERVER_IDENTITY_UNAVAILABLE", diagnostic: { site: "/private/x", pidAfter: "gone" } }, undefined],
    ["foreign-pid", { status: "failed", error: "SERVER_IDENTITY_UNAVAILABLE", diagnostic: { site: site.site, pidAfter: 4242 } }, { site: site.site }],
    ["other-code", { status: "failed", error: "SERVER_ALIVE", diagnostic: site }, undefined],
    ["not-object", { status: "failed", error: "SERVER_IDENTITY_UNAVAILABLE", diagnostic: "reuse-start-time" }, undefined],
    ["succeeded", { status: "succeeded", diagnostic: site }, undefined],
  ];
  for (const [name, fields, expected] of rows) {
    const requestId = `stored-${name}`;
    const file = path.join(journal, `${requestId}.json`);
    fs.writeFileSync(file, JSON.stringify({ requestId, kind: "pause", payload: "{}", ...fields }));
    const bytes = fs.readFileSync(file);
    assert.deepEqual(manager.receipt(requestId).diagnostic, expected, name);
    assert.deepEqual(fs.readFileSync(file), bytes, `${name}: a read writes nothing`);
  }
  // An accepted row recovered at start-up as a success keeps no diagnostic, on disk or on read.
  const body = { ...payload(manager), setup: normalizeSetup({ aiCount: 1 }) };
  await manager.close();
  const accepted = { ...body, payload: JSON.stringify(body), status: "accepted", reservation: { gameId: randomUUID(), selectionVersion: 1 }, diagnostic: site };
  fs.writeFileSync(path.join(journal, `${body.requestId}.json`), JSON.stringify(accepted));
  manager = createSessionManager({ storeDir: root, resolver });
  await manager.initialize();
  assert.equal(manager.receipt(body.requestId).status, "succeeded");
  assert.equal("diagnostic" in manager.receipt(body.requestId), false);
  assert.equal("diagnostic" in JSON.parse(fs.readFileSync(path.join(journal, `${body.requestId}.json`), "utf8")), false);
  const end = payload(manager, "end");
  manager.command(end);
  await succeeded(manager, end.requestId);
});
