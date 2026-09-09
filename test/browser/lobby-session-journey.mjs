import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startAppService } from "../../tools/app-service.js";
import {
  inspectStudyService,
  stopStudyService,
} from "../../tools/study-service.js";
import {
  createBrowserWorkspace,
  runOwnedCommand,
  hashTree,
} from "../helpers/learning-browser-fixture.mjs";
export const requiredJourneyChecks = [
  "bare-lobby-no-init",
  "mode-ai-selection",
  "pause-resume",
  "setup-back-no-resume",
  "menu-close-reopen",
  "restart-new-id",
  "abort-summary",
  "completed-review-reload",
  "command-reconnect",
  "study-paused-roundtrip",
  "keyboard-mobile",
  "real-user-store-unchanged",
  "owned-cleanup",
];
export async function runLobbyJourney(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const workspace = createBrowserWorkspace(),
    root = workspace.root;
  const userStore = path.resolve("game"),
    before = hashTree(userStore),
    session = `lobby-${randomUUID()}`;
  let app;
  const checks = [];
  let failure;
  const browser = async (args) => {
    const r = await runOwnedCommand(
      "npx",
      [
        "--yes",
        "agent-browser@0.36.0",
        "--session",
        session,
        "--json",
        ...args,
      ],
      { timeoutMs: 45000 },
    );
    assert.equal(
      r.exitCode,
      0,
      `${args[0]}: ${r.stderr} ${r.stdout.replace(/token=[^\s"&]+/g, "token=[redacted]")}`,
    );
    const result = JSON.parse(r.stdout);
    assert.notEqual(result.success, false, JSON.stringify(result));
    return result.data;
  };
  const evaluate = async (expr) => {
    const data = await browser(["eval", expr]);
    return data?.result ?? data;
  };
  const check = (name) => checks.push(name);
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("journey state timeout " + app.manager.snapshot().state);
  };
  const state = (expected) =>
    wait(
      () =>
        app.manager.snapshot().state === expected &&
        !app.manager.snapshot().pendingRequestId,
    );
  const click = async (selector) => {
    await browser(["snapshot", "-i"]);
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`,
    );
    await browser(["click", selector]);
  };
  const readEngine = () =>
    JSON.parse(
      fs.readFileSync(path.join(app.manager.current.sessionDir, "state.json")),
    );
  try {
    app = await startAppService(root, {
      resolver: async () => ({ player: null, upper: null, notices: [] }),
    });
    await browser(["open", app.url]);
    await browser(["set", "viewport", "1280", "900"]);
    await browser(["snapshot", "-i"]);
    await wait(() =>
      evaluate("document.querySelector('#status').textContent==='로비'"),
    );
    assert.equal(app.manager.snapshot().gameId, null);
    assert.equal(await evaluate("location.hash"), "");
    check("bare-lobby-no-init");
    await browser(["screenshot", path.join(outDir, "lobby.png")]);
    await click("#start");
    await state("playing");
    const players = JSON.parse(
      fs.readFileSync(
        path.join(app.manager.current.sessionDir, "players.json"),
      ),
    );
    assert.equal(players.length, 6);
    check("mode-ai-selection");
    await wait(() =>
      evaluate(
        "document.querySelector('#table').contentDocument.querySelector('#action-status')?.textContent.length>0",
      ),
    );
    await click("#menu");
    await state("paused");
    const paused = hashTree(app.manager.current.sessionDir);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hashTree(app.manager.current.sessionDir), paused);
    await click("#modes");
    await click("#back");
    assert.equal(app.manager.snapshot().state, "paused");
    check("setup-back-no-resume");
    await click("#close-menu");
    assert.equal(app.manager.snapshot().state, "paused");
    await click("#menu");
    check("menu-close-reopen");
    await browser(["set", "viewport", "360", "800"]);
    await browser(["press", "Escape"]);
    assert.equal(app.manager.snapshot().state, "paused");
    assert.ok(await evaluate("document.documentElement.scrollWidth<=360"));
    await click("#menu");
    check("keyboard-mobile");
    await click("#resume");
    await state("playing");
    await click("#menu");
    await state("paused");
    check("pause-resume");
    await browser(["reload"]);
    await wait(() =>
      evaluate("document.querySelector('#status').textContent==='일시정지'"),
    );
    check("command-reconnect");
    await click("#study");
    await browser(["tab", "t1"]);
    assert.equal(app.manager.snapshot().state, "paused");
    check("study-paused-roundtrip");
    await click("#menu");
    const old = app.manager.snapshot().gameId;
    await click("#restart");
    await click("#confirm-yes");
    await state("playing");
    assert.notEqual(app.manager.snapshot().gameId, old);
    check("restart-new-id");
    await click("#menu");
    await state("paused");
    await click("#modes");
    await browser(["check", 'input[value="tournament"]']);
    await browser(["select", "#ai-count", "8"]);
    // Interrupt a receipt read after mode replacement was submitted. The UI
    // must reconcile its persisted command and leave the setup screen.
    await evaluate(`(() => {
      const original = window.fetch;
      window.__receiptDisconnected = false;
      window.fetch = async (url, options) => {
        if (!window.__receiptDisconnected && String(url).startsWith('/api/commands/')) {
          window.__receiptDisconnected = true;
          throw new TypeError('fetch failed');
        }
        return original(url, options);
      };
    })()`);
    await click("#start");
    await click("#confirm-yes");
    await state("playing");
    await wait(() => evaluate("window.__receiptDisconnected && document.querySelector('#setup').hidden && !sessionStorage.getItem('holdem.app.command.v1')"));
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(app.manager.current.sessionDir, "players.json"),
        ),
      ).length,
      9,
    );
    await click("#menu");
    await state("paused");
    await click("#end");
    await click("#confirm-yes");
    await state("ended");
    assert.equal(readEngine().result, "abort");
    await wait(() =>
      evaluate(
        "document.querySelector('#result-message').textContent.includes('중도 종료')",
      ),
    );
    check("abort-summary");
    await click("#result-modes");
    await browser(["check", 'input[value="cash-training"]']);
    await browser(["select", "#ai-count", "1"]);
    await click("summary");
    await browser(["fill", 'input[name="hands"]', "1"]);
    await evaluate(
      "window.lobbyDebug=[];document.querySelector('form').addEventListener('submit',()=>window.lobbyDebug.push('submit'));document.querySelector('#start').addEventListener('click',()=>window.lobbyDebug.push('click'));window.addEventListener('error',e=>window.lobbyDebug.push(e.message));",
    );
    await click("#start");
    await state("playing");
    for (
      let i = 0;
      i < 120 && app.manager.snapshot().state !== "completed";
      i++
    ) {
      await evaluate(
        "(()=>{const d=document.querySelector('#table').contentDocument;const b=d?.querySelector('#btn-fold');if(b&&!b.disabled)b.click();})()",
      );
      await new Promise((r) => setTimeout(r, 200));
    }
    await state("completed");
    await click("#review");
    await wait(() =>
      evaluate(
        "document.querySelector('#table').contentDocument.querySelector('#action-status')?.textContent==='종료된 게임 기록입니다.'",
      ),
    );
    await browser(["reload"]);
    await state("completed");
    await click("#review");
    await wait(()=>evaluate("document.querySelector('#table').contentDocument.querySelector('#review-close')!==null"));
    assert.equal(await evaluate("document.querySelector('#table').inert"),false);
    await browser(['frame','#table']);await browser(['snapshot','-i']);await browser(['click','#review-close']);await browser(['frame','main']);
    check("completed-review-reload");
    await browser(["screenshot", path.join(outDir, "completed.png")]);
  } catch (error) {
    failure = error;
    try {
      fs.writeFileSync(
        path.join(outDir, "failure-ui.json"),
        JSON.stringify(
          await evaluate(
            "({debug:window.lobbyDebug,button:document.querySelector('#start').outerHTML,dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open})),error:document.querySelector('#error').textContent,form:[...document.querySelector('form').elements].map(e=>({name:e.name,value:e.value,valid:e.validity?.valid})),status:document.querySelector('#status').textContent})",
          ),
          null,
          2,
        ),
      );
      await browser(["screenshot", path.join(outDir, "failure.png")]);
    } catch {}
  } finally {
    await browser(["close"]).catch(() => {});
    await app?.close();
    const study = await inspectStudyService(root);
    if (study.status === "running")
      await stopStudyService(root, { expectedInstanceId: study.instanceId });
    assert.equal(hashTree(userStore), before);
    check("real-user-store-unchanged");
    workspace.close();
    check("owned-cleanup");
    const result = {
      schemaVersion: 1,
      pass: !failure && requiredJourneyChecks.every((x) => checks.includes(x)),
      node: process.version,
      browser: "agent-browser@0.36.0",
      checks,
      pending: requiredJourneyChecks.filter((x) => !checks.includes(x)),
      error: failure?.message,
    };
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify(result, null, 2),
    );
  }
  if (failure) throw failure;
}
if (
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const i = process.argv.indexOf("--out-dir");
  if (i < 0) throw new Error("--out-dir required");
  await runLobbyJourney(path.resolve(process.argv[i + 1]));
  console.log("Lobby browser journey PASS");
}
