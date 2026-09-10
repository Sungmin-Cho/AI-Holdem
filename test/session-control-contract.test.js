import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  ALLOWED_COMMANDS,
  validateCommand,
} from "../shared/session-control-contract.js";
test("command matrix and setup authority are explicit", () => {
  const base = {
    requestId: "abc",
    expectedInstanceId: "instance",
    expectedAppRevision: 0,
    expectedGameId: null,
    expectedSelectionVersion: 0,
  };
  for (const kind of COMMANDS) {
    assert.equal(validateCommand({ ...base, kind, ...(kind === 'retry-decision' ? { decisionId: 'd-1-preflop-0' } : {}) }).kind, kind);
    if (!["start", "replace-current"].includes(kind))
      assert.throws(() => validateCommand({ ...base, kind, setup: {} }), {
        code: "BAD_COMMAND",
      });
  }
  assert.deepEqual(ALLOWED_COMMANDS.playing, ["pause"]);
  assert.deepEqual(ALLOWED_COMMANDS.pausing, []);
});
