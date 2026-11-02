import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir, registerOwnedProcess } from "./helpers/owned-fixtures.mjs";
import { startAppService, inspectAppService, stopAppService } from "../tools/app-service.js";
import { readOwnedLock } from "../engine/state.js";
import { writeStallingFetch, stallEnv, stalledCalls, stalledAborts, stalledExit, msBetween } from "./helpers/stalling-fetch.mjs";
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
      let transportFailures = 0;
      const deadline =
        Date.now() + (process.platform === "win32" ? 240000 : 30000);
      while (Date.now() < deadline) {
        try {
          const response = await fetch(
            `${app.origin}/api/commands/${payload.requestId}`,
            { headers, signal: AbortSignal.timeout(10000) },
          );
          assert.equal(response.status, 200);
          receipt = await response.json();
        } catch (error) {
          // Match the UI's pending-command recovery: retry only this read,
          // never submit a second command or replace its durable request ID.
          const transportError =
            (error instanceof TypeError && error.message === "fetch failed") ||
            error.name === "TimeoutError";
          if (!transportError || ++transportFailures > 3) throw error;
          t.diagnostic(
            `receipt reconnect kind=${kind} attempt=${transportFailures} ` +
              `cause=${error.cause?.code ?? error.name}`,
          );
          await sleep(100);
          continue;
        }
        if (receipt.status !== "accepted") break;
        await sleep(50);
      }
      assert.equal(receipt?.status, "succeeded", JSON.stringify(receipt));
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

// #343: the app CLI is a one-shot process. When one of its fetches never settles, nothing but that
// call's budget may keep it alive: it used to exit 13 with no message (the stop leaving the app
// running, the user never told why). Each stalled call is cut at its budget, and the CLI ends with
// its closed code (exit 1). Every moment is the CLI's own — the parent observes the exit late
// while it registers the child (a synchronous identity probe, up to 15s on Windows).
//
// The app runs in its own process: this test process blocks in synchronous fixture work (owned
// directories, child identity probes — PowerShell on Windows), and an app inside it could not
// answer the CLIs' real requests meanwhile. Every fixture is made before the first CLI starts.
async function stalledCliFixture(t, prefix) {
  const cli = fileURLToPath(new URL("../tools/app-service.js", import.meta.url));
  const root = createOwnedTempDir(prefix);
  const serve = spawn(process.execPath, [cli, "serve", root, "--public-port", "0"], { stdio: "ignore" });
  registerOwnedProcess(serve, "app-serve-stalled-cli");
  const exited = new Promise((resolve) => serve.once("exit", resolve));
  t.after(async () => {
    await stopAppService(root).catch(() => serve.kill());
    await exited;
  });
  const deadline = Date.now() + (process.platform === "win32" ? 120000 : 30000);
  for (;;) {
    try {
      const app = await inspectAppService(root);
      if (app.status === "running") return { cli, root, app };
    } catch {
      /* not serving yet */
    }
    if (serve.exitCode !== null || Date.now() > deadline) assert.fail("the app did not start serving");
    await sleep(100);
  }
}

function runStalledCli(cli, preload, args, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--require", preload, cli, ...args], {
      encoding: "utf8",
      timeout: process.platform === "win32" ? 240000 : 40000,
      env: { ...process.env, HOLDEM_PUBLIC_PORT: "0", ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, signal: error?.signal ?? null, stdout, stderr }));
    registerOwnedProcess(child, "app-cli-stalled");
  });
}

test("one-shot app CLI ends with its message, never exit 13, when a fetch never settles (#343)", { timeout: process.platform === "win32" ? 300000 : 60000 }, async (t) => {
  // tools/app-service.js: each inspect request (/api/app) keeps its 10s; prefill and stop have the same.
  const budgetMs = 10_000;
  const slackMs = process.platform === "win32" ? 10_000 : 3_000;
  const { cli, root, app } = await stalledCliFixture(t, "lobby-stalled-cli");
  const setupFile = path.join(root, "prefill.json");
  fs.writeFileSync(setupFile, JSON.stringify({ mode: "tournament", aiCount: 2 }));
  const timeout = /^The operation was aborted due to timeout$/m;
  const cases = [
    { name: "prefill request", route: "/api/prefill", args: [root, "--player-runtime", "codex", "--setup-file", setupFile], expected: /^PREFILL_FAILED$/m },
    { name: "inspect challenge", route: "/api/app", args: ["stop", root], expected: timeout },
    { name: "inspect request", route: "/api/app", after: 1, args: ["stop", root], expected: timeout },
    { name: "inspect answer", route: "/api/app", after: 1, stage: "body", args: ["stop", root], expected: timeout },
    { name: "stop request", route: "/api/stop", args: ["stop", root], expected: /^APP_STOP_FAILED$/m },
  ].map((row) => ({ ...row, stall: writeStallingFetch() }));
  // Independent: none of them reaches the app with anything that changes it.
  const results = await Promise.all(cases.map((row) => runStalledCli(cli, row.stall.preload, row.args,
    stallEnv(row.stall, row.route, row.stage, { after: row.after }))
    .then((result) => ({ ...row, ...result }))));
  for (const result of results) {
    const label = JSON.stringify({ case: result.name, code: result.code, signal: result.signal, stdout: result.stdout.slice(-200), stderr: result.stderr.slice(-300) });
    assert.equal(result.code, 1, `the CLI ends with its message, not unsettled: ${label}`);
    assert.match(result.stderr, result.expected, label);
    assert.equal(result.stdout, "", label);
    assert.equal(stalledCalls(result.stall).length, 1, label);
    const aborts = stalledAborts(result.stall);
    assert.equal(aborts.length, 1, `the stalled call was aborted: ${label}`);
    const waitedMs = msBetween(aborts[0].calledAt, aborts[0].abortedAt);
    assert.ok(waitedMs >= budgetMs - 100 && waitedMs <= budgetMs + slackMs, `${result.name} aborted ${waitedMs}ms after its call`);
    const exitedAt = stalledExit(result.stall);
    assert.ok(exitedAt !== null, `the CLI recorded its exit: ${label}`);
    const heldMs = msBetween(aborts[0].abortedAt, exitedAt);
    assert.ok(heldMs <= slackMs, `${result.name}: the CLI exited ${heldMs}ms after the abort`);
  }
  // A stop that never reached the app leaves it running.
  assert.equal(readOwnedLock(root, "app.lock.d").status, "alive");
  assert.equal((await inspectAppService(root)).instanceId, app.instanceId);
});

// An answer the CLI does not read (the inspect challenge, prefill, stop) is cancelled inside its
// budget: its headers arrived but its body never ends here, on a real socket, and a body left open
// past the released budget held the CLI. The listener runs in its own process for the same reason
// the app does.
test("one-shot app CLI does not wait on the body of an answer it does not read (#343)", { timeout: process.platform === "win32" ? 300000 : 60000 }, async (t) => {
  const slackMs = process.platform === "win32" ? 10_000 : 3_000;
  const { cli, root, app } = await stalledCliFixture(t, "lobby-open-body-cli");
  const listener = spawn(process.execPath, ["-e", [
    "const http = require('node:http');",
    "const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });",
    "server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));",
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
  registerOwnedProcess(listener, "open-body-listener");
  t.after(() => listener.kill());
  const port = await new Promise((resolve, reject) => {
    let out = "";
    listener.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(Number(out.trim()));
    });
    listener.once("exit", () => reject(new Error("the listener exited")));
  });
  const setupFile = path.join(root, "prefill.json");
  fs.writeFileSync(setupFile, JSON.stringify({ mode: "tournament", aiCount: 2 }));
  const stall = writeStallingFetch();
  const result = await runStalledCli(cli, stall.preload, [root, "--player-runtime", "codex", "--setup-file", setupFile],
    stallEnv(stall, "/api/prefill", "redirect", { target: `http://127.0.0.1:${port}` }));
  const label = JSON.stringify({ code: result.code, signal: result.signal, stdout: result.stdout.slice(-200), stderr: result.stderr.slice(-300) });
  assert.equal(result.code, 0, `the accepted prefill returns, and the CLI exits: ${label}`);
  assert.equal(result.stdout.trim(), app.url, label);
  const [calledAt] = stalledCalls(stall);
  const exitedAt = stalledExit(stall);
  assert.ok(calledAt !== undefined && exitedAt !== null, label);
  assert.ok(msBetween(calledAt, exitedAt) <= slackMs, `the CLI exited ${msBetween(calledAt, exitedAt)}ms after its prefill`);
});
