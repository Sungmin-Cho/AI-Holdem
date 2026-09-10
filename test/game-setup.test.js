import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSetup, cliModeDefaults } from "../shared/game-setup.js";
test("lobby supports both modes and all seat counts without changing CLI defaults", () => {
  for (const mode of ["cash-training", "tournament"])
    for (let aiCount = 1; aiCount <= 8; aiCount++)
      assert.equal(normalizeSetup({ mode, aiCount }).aiCount, aiCount);
  assert.equal(
    normalizeSetup({ mode: "tournament" }).opponentRuntime,
    "policy",
  );
  assert.equal(
    cliModeDefaults({ storeDir: "game", mode: "tournament" }).opponentRuntime,
    undefined,
  );
  assert.deepEqual(cliModeDefaults({ storeDir: "game", resume: true }), {
    storeDir: "game",
    resume: true,
  });
  assert.equal(
    normalizeSetup({ mode: "tournament", opponentRuntime: "llm" })
      .opponentRuntime,
    "llm",
  );
});
test("setup rejects invalid, conflicting and unsafe input", () => {
  for (const input of [
    { aiCount: 0 },
    { aiCount: 9 },
    { aiCount: "5" },
    { stackBb: Infinity },
    { stackBb: Number.MAX_SAFE_INTEGER },
    { mode: "tournament", hands: 2 },
    { levelEvery: 2 },
    { stack: 1, stackBb: 1 },
    { blinds: "50/25" },
    { mirrorSelf: true, exploitSelf: true, aiCount: 1 },
    { mirrorSelf: true, opponentRuntime: "llm" },
    { playerRuntime: "sh" },
  ])
    assert.throws(() => normalizeSetup(input), { code: "INVALID_SETUP" });
});
