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
test("multiplayer setup keys are idempotent and reject conflicting counts", () => {
  const participants = [
    { playerId: "h1", name: "민준", participantId: "a" },
    { playerId: "h2", name: "서연", participantId: "b" },
  ];
  const once = normalizeSetup({
    totalSeats: 6,
    participants,
    aiCount: 3,
    actionTimeoutSec: 60,
  });
  assert.equal(once.aiCount, 3);
  assert.equal(once.actionTimeoutSec, 60);
  assert.deepEqual(normalizeSetup(once), once);
  assert.throws(
    () => normalizeSetup({ totalSeats: 6, participants, aiCount: 4 }),
    { code: "INVALID_SETUP" },
  );
  assert.throws(
    () => normalizeSetup({ totalSeats: 6, participants, hints: "on", actionTimeoutSec: 60 }),
    { code: "INVALID_SETUP" },
  );
  assert.throws(
    () => normalizeSetup({ totalSeats: 3, participants: [participants[0]], aiCount: 0, mirrorSelf: true, actionTimeoutSec: 60 }),
    { code: "INVALID_SETUP" },
  );
  const empty = normalizeSetup({ totalSeats: 6, participants: [] });
  assert.equal(empty.aiCount, 5);
  assert.equal(empty.actionTimeoutSec, 0);
  assert.equal("participants" in empty, false);
});
