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
test('freshSession is a boolean authority limited to retry-decision', () => {
  const base = {requestId:'fresh',expectedInstanceId:'app',expectedAppRevision:0,
    expectedGameId:null,expectedSelectionVersion:0,kind:'retry-decision',decisionId:'d-1-preflop-0'};
  for (const freshSession of [true,false]) assert.equal(validateCommand({...base,freshSession}).freshSession,freshSession);
  for (const freshSession of [null,1,'true',{}]) assert.throws(()=>validateCommand({...base,freshSession}),{code:'BAD_COMMAND'});
  for (const kind of COMMANDS.filter(x=>x!=='retry-decision')) {
    const {decisionId,...body}=base;
    assert.throws(()=>validateCommand({...body,kind,freshSession:true}),{code:'BAD_COMMAND'});
  }
});
