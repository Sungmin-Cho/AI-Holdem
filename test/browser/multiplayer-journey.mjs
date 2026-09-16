import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
  "lan-join-url",
  "name-taken",
  "two-guests-start",
  "guest-cards-hidden-from-others",
  "guest-action-insecure-context",
  "pause-banner",
  "end-final-stacks",
  "room-closed-offline",
  "real-user-store-unchanged",
  "owned-cleanup",
];

function lanIPv4() {
  for (const rows of Object.values(os.networkInterfaces() ?? {})) {
    for (const row of rows ?? []) {
      if (!row.internal && row.family === "IPv4") return row.address;
    }
  }
  return null;
}

function makeBrowser(session) {
  return async (args) => {
    const r = await runOwnedCommand(
      "npx",
      ["--yes", "agent-browser@0.36.0", "--session", session, "--json", ...args],
      { timeoutMs: 45_000 },
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
}

export async function runMultiplayerJourney(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const workspace = createBrowserWorkspace();
  const root = workspace.root;
  const userStore = path.resolve("game");
  const before = hashTree(userStore);
  const lan = lanIPv4();
  const checks = [];
  const check = (name) => checks.push(name);
  let failure;
  let app;
  const host = makeBrowser(`mp-host-${randomUUID()}`);
  const guestA = makeBrowser(`mp-a-${randomUUID()}`);
  const guestB = makeBrowser(`mp-b-${randomUUID()}`);
  const evaluate = (browser) => async (expr) => {
    const data = await browser(["eval", expr]);
    return data?.result ?? data;
  };
  const wait = async (predicate, label) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`journey timeout: ${label}`);
  };
  const click = async (browser, selector) => {
    await browser(["snapshot", "-i"]);
    await evaluate(browser)(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`,
    );
    await browser(["click", selector]);
  };
  const closeBrowsers = async () => {
    await Promise.all([
      host(["close"]).catch(() => {}),
      guestA(["close"]).catch(() => {}),
      guestB(["close"]).catch(() => {}),
    ]);
  };
  try {
    if (!lan) {
      throw new Error("skip: no LAN IPv4 (insecure-context join cannot be verified)");
    }
    app = await startAppService(root, {
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      publicPort: 0,
    });
    assert.ok(app.publicPort, "public listener did not bind");
    await host(["open", app.url]);
    await host(["set", "viewport", "1280", "900"]);
    await wait(
      () => evaluate(host)("document.querySelector('#status')?.textContent==='로비'"),
      "host lobby",
    );
    await host(["select", "#action-timeout", "30"]);
    await host(["select", "#total-seats", "6"]);
    await click(host, "#room-open");
    await wait(
      () => evaluate(host)("document.querySelector('#room-panel')?.hidden===false"),
      "room panel",
    );
    const joinHref = await evaluate(host)(`([...document.querySelectorAll('#join-links li')]
      .map((item) => item.textContent)
      .find((href) => href.includes(${JSON.stringify(lan)})))`);
    assert.ok(joinHref, `no LAN join link for ${lan}`);
    check("lan-join-url");

    await guestA(["open", joinHref]);
    await guestA(["fill", "#join-name", "민준"]);
    await click(guestA, "#join-submit");
    await wait(
      () => evaluate(guestA)("document.querySelector('#waiting')?.hidden===false"),
      "guest A waiting",
    );

    await guestB(["open", joinHref]);
    await guestB(["fill", "#join-name", "민준"]);
    await click(guestB, "#join-submit");
    await wait(
      () => evaluate(guestB)("document.querySelector('#join-error')?.textContent?.includes('이미 쓰인 이름')"),
      "duplicate name",
    );
    check("name-taken");
    await guestB(["fill", "#join-name", "서연"]);
    await click(guestB, "#join-submit");
    await wait(
      () => evaluate(guestB)("document.querySelector('#waiting')?.hidden===false"),
      "guest B waiting",
    );

    await click(host, "summary");
    await host(["fill", 'input[name="hands"]', "1"]);
    await click(host, "#start");
    await wait(
      () => app.manager.snapshot().state === "playing" && !app.manager.snapshot().pendingRequestId,
      "playing",
    );
    await wait(
      () => evaluate(guestA)("document.querySelector('#playing')?.hidden===false"),
      "guest A table",
    );
    await wait(
      () => evaluate(guestB)("document.querySelector('#playing')?.hidden===false"),
      "guest B table",
    );
    const players = JSON.parse(
      fs.readFileSync(path.join(app.manager.current.sessionDir, "players.json"), "utf8"),
    );
    assert.equal(players.filter((row) => row.kind === "human").length, 3);
    assert.equal(players.filter((row) => row.kind === "ai").length, 3);
    check("two-guests-start");

    const engine = JSON.parse(
      fs.readFileSync(path.join(app.manager.current.sessionDir, "state.json"), "utf8"),
    );
    const hidden = engine.hand?.holes?.h1 ?? engine.lastHand?.holes?.h1 ?? [];
    assert.equal(hidden.length, 2, "guest A hole cards missing from engine state");
    const tableText = async (browser) => evaluate(browser)(
      "document.querySelector('#table')?.contentDocument?.documentElement?.innerHTML ?? document.documentElement.innerHTML",
    );
    await wait(
      async () => {
        const html = await tableText(guestA);
        return typeof html === "string" && html.length > 0;
      },
      "guest A iframe",
    );
    const hostHtml = await tableText(host);
    const bHtml = await tableText(guestB);
    for (const card of hidden) {
      assert.equal(hostHtml.includes(card), false, `host DOM leaked ${card}`);
      assert.equal(bHtml.includes(card), false, `guest B DOM leaked ${card}`);
    }
    check("guest-cards-hidden-from-others");

    await wait(
      async () => {
        const acted = await evaluate(guestA)(`(() => {
          const doc = document.querySelector('#table')?.contentDocument;
          const fold = doc?.querySelector('#btn-fold');
          const call = doc?.querySelector('#btn-call');
          const checkBtn = doc?.querySelector('#btn-check');
          const btn = [fold, call, checkBtn].find((node) => node && !node.disabled);
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        return acted === true;
      },
      "guest A action",
    );
    check("guest-action-insecure-context");

    await click(host, "#menu");
    await wait(
      () => app.manager.snapshot().state === "paused",
      "paused",
    );
    await wait(
      () => evaluate(guestA)("document.querySelector('#pause-banner')?.hidden===false"),
      "pause banner",
    );
    check("pause-banner");
    await click(host, "#resume");
    await wait(
      () => app.manager.snapshot().state === "playing",
      "resumed",
    );
    await wait(
      () => evaluate(guestA)("document.querySelector('#pause-banner')?.hidden===true"),
      "pause banner cleared",
    );

    await click(host, "#menu");
    await wait(() => app.manager.snapshot().state === "paused", "pause to end");
    await click(host, "#end");
    await click(host, "#confirm-yes");
    await wait(
      () => ["ended", "completed"].includes(app.manager.snapshot().state),
      "ended",
    );
    await wait(
      () => evaluate(guestA)("document.querySelector('#final')?.hidden===false"),
      "final stacks",
    );
    const stackText = await evaluate(guestA)("document.querySelector('#final-stacks')?.innerText ?? ''");
    assert.match(String(stackText), /민준|서연|호스트/);
    check("end-final-stacks");

    await click(host, "#result-modes");
    await wait(
      () => evaluate(host)("document.querySelector('#setup')?.hidden===false && document.querySelector('#room-close')?.disabled===false"),
      "setup with closable room",
    );
    await click(host, "#room-close");
    await wait(
      () => evaluate(host)("document.querySelector('#room-status')?.textContent==='closed'"),
      "room closed",
    );
    await wait(
      () => evaluate(guestA)("document.querySelector('#join-error')?.textContent?.includes('닫혔거나')"),
      "guest offline",
    );
    check("room-closed-offline");
    await host(["screenshot", path.join(outDir, "host.png")]);
    await guestA(["screenshot", path.join(outDir, "guest-a.png")]);
  } catch (error) {
    failure = error;
    try {
      await host(["screenshot", path.join(outDir, "failure-host.png")]);
      await guestA(["screenshot", path.join(outDir, "failure-guest.png")]);
    } catch { /* best-effort */ }
  } finally {
    await closeBrowsers();
    await app?.close();
    const study = await inspectStudyService(root);
    if (study.status === "running") {
      await stopStudyService(root, { expectedInstanceId: study.instanceId });
    }
    assert.equal(hashTree(userStore), before);
    check("real-user-store-unchanged");
    workspace.close();
    check("owned-cleanup");
    const result = {
      schemaVersion: 1,
      pass: !failure && requiredJourneyChecks.every((name) => checks.includes(name)),
      node: process.version,
      browser: "agent-browser@0.36.0",
      lan,
      checks,
      pending: requiredJourneyChecks.filter((name) => !checks.includes(name)),
      error: failure?.message,
    };
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  }
  if (failure) throw failure;
}

if (
  !process.env.NODE_TEST_CONTEXT
  && process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const i = process.argv.indexOf("--out-dir");
  if (i < 0) throw new Error("--out-dir required");
  await runMultiplayerJourney(path.resolve(process.argv[i + 1]));
  console.log("Multiplayer browser journey PASS");
}
