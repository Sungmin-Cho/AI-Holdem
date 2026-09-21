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
  manager.command(start);assert.equal((await settle(manager,start.requestId)).status,'succeeded');
  const pause=payload(manager,'pause');manager.command(pause);assert.equal((await settle(manager,pause.requestId)).status,'succeeded');
  const gameId=manager.snapshot().gameId;
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  await manager.close();
  manager=createSessionManager({storeDir:root,resolver});await manager.initialize();
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  const resume=payload(manager,'resume');manager.command(resume);assert.equal((await settle(manager,resume.requestId)).status,'succeeded');
  const repause=payload(manager,'pause');manager.command(repause);assert.equal((await settle(manager,repause.requestId)).status,'succeeded');
  const restart=payload(manager,'restart');manager.command(restart);assert.equal((await settle(manager,restart.requestId)).status,'succeeded');
  assert.notEqual(manager.snapshot().gameId,gameId);
  assert.equal(manager.snapshot().setup.dealBias,'strong');
  const state=JSON.parse(fs.readFileSync(path.join(resolveCurrentSession(root).sessionDir,'state.json')));
  assert.equal(state.config.dealBias,'strong');
  const paused=payload(manager,'pause');manager.command(paused);await settle(manager,paused.requestId);
  const end=payload(manager,'end');manager.command(end);assert.equal((await settle(manager,end.requestId)).status,'succeeded');
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
    const expectSuccess=async requestId=>{const receipt=await settle(manager,requestId);assert.equal(receipt.status,'succeeded',JSON.stringify({requestId,status:receipt.status,error:receipt.error}));};
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
