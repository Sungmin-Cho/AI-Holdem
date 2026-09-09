import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createBrowserWorkspace,
  hashTree,
} from "../helpers/learning-browser-fixture.mjs";
import { startAppService } from "../../tools/app-service.js";
import {
  inspectStudyService,
  stopStudyService,
} from "../../tools/study-service.js";
export async function runLlmSmoke(output) {
  const workspace = createBrowserWorkspace();
  let app;
  const started = Date.now();
  let result = { pass: false, runtime: "claude" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function command(kind, setup) {
    const s = app.manager.snapshot();
    const row = app.manager.command({
      requestId: crypto.randomUUID(),
      expectedInstanceId: s.instanceId,
      expectedAppRevision: s.appRevision,
      expectedGameId: s.gameId,
      expectedSelectionVersion: s.selectionVersion,
      kind,
      ...(setup ? { setup } : {}),
    });
    for (let i = 0; i < 3000; i++) {
      const receipt = app.manager.receipt(row.requestId);
      if (receipt.status !== "accepted") {
        assert.equal(receipt.status, "succeeded", receipt.error);
        return;
      }
      await sleep(100);
    }
    throw new Error("command timed out");
  }
  try {
    app = await startAppService(workspace.root, { playerRuntime: "claude" });
    await command("start", { aiCount: 1, opponentRuntime: "llm", hands: 20 });
    let metric;
    for (let i = 0; i < 1800; i++) {
      const s = app.manager.snapshot(),
        dir = app.manager.current.sessionDir;
      const loop = JSON.parse(
        fs.readFileSync(path.join(dir, "loop-state.json")),
      );
      metric = loop.metrics?.find((m) =>
        ["accepted", "retried_accepted"].includes(m.outcome),
      );
      if (metric) break;
      assert.notEqual(s.state, "error", s.error);
      const headers = {
        authorization: `Bearer ${app.token}`,
        "x-game-epoch": s.gameEpoch,
        "content-type": "application/json",
      };
      const response = await fetch(
        `${app.origin}/api/game/${s.gameId}/snapshot`,
        { headers },
      );
      const snap = await response.json();
      if (snap.view?.legal?.toAct === "user")
        await fetch(`${app.origin}/api/game/${s.gameId}/action`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            gameEpoch: s.gameEpoch,
            decisionId: snap.view.legal.decisionId,
            requestId: crypto.randomUUID(),
            action: "fold",
          }),
        });
      await sleep(100);
    }
    assert.ok(metric, "no actual accepted LLM decision");
    await command("pause");
    const paused = hashTree(app.manager.current.sessionDir);
    await sleep(500);
    assert.equal(hashTree(app.manager.current.sessionDir), paused);
    await command("end");
    assert.equal(app.manager.snapshot().state, "ended");
    result = {
      pass: true,
      runtime: metric.runtime,
      outcome: metric.outcome,
      modelMs: metric.modelMs,
      elapsedMs: Date.now() - started,
      pausedStateUnchanged: true,
      terminal: "aborted",
    };
  } catch (e) {
    result.error = e.message;
    throw e;
  } finally {
    await app?.close();
    const study = await inspectStudyService(workspace.root);
    if (study.status === "running")
      await stopStudyService(workspace.root, {
        expectedInstanceId: study.instanceId,
      });
    workspace.close();
    fs.writeFileSync(
      output,
      JSON.stringify({ ...result, ownedCleanup: true }, null, 2),
    );
  }
}
if (
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runLlmSmoke(process.argv[2]);
