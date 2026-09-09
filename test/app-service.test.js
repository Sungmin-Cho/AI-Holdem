import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { startAppService, inspectAppService } from "../tools/app-service.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "real app: empty lobby, auth, start, pause, restart, end and attach",
  { timeout: process.platform === "win32" ? 300000 : 60000 },
  async (t) => {
    const root = createOwnedTempDir("holdem-app");
    let probes = 0;
    const app = await startAppService(root, {
      resolver: async () => {
        probes++;
        return { player: null, upper: null, notices: [] };
      },
    });
    t.after(() => app.close());
    assert.equal(probes, 0);
    assert.equal(app.manager.snapshot().state, "lobby");
    assert.equal((await inspectAppService(root)).instanceId, app.instanceId);
    assert.equal((await fetch(`${app.origin}/api/app`)).status, 401);
    const headers = {
      authorization: `Bearer ${app.token}`,
      "content-type": "application/json",
    };
    async function command(kind, setup) {
      const s = app.manager.snapshot();
      const payload = {
        kind,
        requestId: crypto.randomUUID(),
        expectedInstanceId: s.instanceId,
        expectedAppRevision: s.appRevision,
        expectedGameId: s.gameId,
        expectedSelectionVersion: s.selectionVersion,
        ...(setup ? { setup } : {}),
      };
      const response = await fetch(`${app.origin}/api/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(
        response.status,
        202,
        JSON.stringify(await response.clone().json()),
      );
      let receipt;
      const deadline =
        Date.now() + (process.platform === "win32" ? 240000 : 30000);
      while (Date.now() < deadline) {
        receipt = await (
          await fetch(`${app.origin}/api/commands/${payload.requestId}`, {
            headers,
          })
        ).json();
        if (receipt.status !== "accepted") break;
        await sleep(50);
      }
      assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
      return payload;
    }
    await command("start", { aiCount: 1 });
    const first = app.manager.snapshot().gameId;
    await command("pause");
    assert.equal(app.manager.snapshot().state, "paused");
    await command("restart");
    assert.notEqual(app.manager.snapshot().gameId, first);
    assert.ok(
      fs.existsSync(
        path.join(root, ".session-store", "sessions", first, "state.json"),
      ),
    );
    await command("pause");
    await command("end");
    assert.equal(app.manager.snapshot().state, "ended");
  },
);

test(
  "concurrent app ensure attaches to one verified detached owner without initializing a game",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const { ensureAppService, stopAppService } = await import(
      "../tools/app-service.js"
    );
    const root = createOwnedTempDir("lobby-concurrent-ensure");
    t.after(() => stopAppService(root));
    const [first, second] = await Promise.all([
      ensureAppService(root),
      ensureAppService(root),
    ]);
    assert.equal(first.instanceId, second.instanceId);
    assert.equal(first.pid, second.pid);
    const response = await fetch(`${first.origin}/api/app`, {
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal((await response.json()).gameId, null);
  },
);

test(
  "unconfirmed cleanup retains app ownership and a later stop can retry",
  { timeout: process.platform === "win32" ? 300000 : 30000 },
  async (t) => {
    const { readOwnedLock } = await import("../engine/state.js");
    const root = createOwnedTempDir("lobby-stop-retry");
    const app = await startAppService(root);
    const closeManager = app.manager.close;
    t.after(async () => {
      app.manager.close = closeManager;
      await app.close();
    });
    app.manager.close = async () => {
      throw Object.assign(new Error("cleanup not confirmed"), {
        code: "APP_STOP_UNCONFIRMED",
      });
    };
    const response = await fetch(`${app.origin}/api/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
    });
    assert.equal(response.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(readOwnedLock(root, "app.lock.d").status, "alive");
    assert.equal((await inspectAppService(root)).instanceId, app.instanceId);
    app.manager.close = closeManager;
    await app.close();
    assert.equal(readOwnedLock(root, "app.lock.d"), null);
  },
);

test('CLI prefill opens tournament AI8 lobby without creating a game', {timeout:process.platform==='win32'?300000:30000},async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {stopAppService}=await import('../tools/app-service.js');const root=createOwnedTempDir('lobby-prefill-cli');t.after(()=>stopAppService(root));const setupFile=path.join(root,'prefill.json');fs.writeFileSync(setupFile,JSON.stringify({mode:'tournament',aiCount:8,opponentRuntime:'llm'}));
 await promisify(execFile)(process.execPath,[path.resolve('tools/app-service.js'),root,'--player-runtime','codex','--setup-file',setupFile],{timeout:process.platform==='win32'?240000:20000});const app=await inspectAppService(root);const response=await fetch(`${app.origin}/api/app`,{headers:{authorization:`Bearer ${app.token}`}});const state=await response.json();assert.equal(state.gameId,null);assert.equal(state.defaultSetup.mode,'tournament');assert.equal(state.defaultSetup.aiCount,8);assert.equal(state.defaultSetup.opponentRuntime,'llm');
});
