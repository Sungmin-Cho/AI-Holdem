import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobbyCommandClient } from "../server/public/lobby-command-client.js";
const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
test("lost command response reconciles its original ID without another start", async () => {
  const requests = [],
    saved = storage();
  const client = createLobbyCommandClient({
    storage: saved,
    sleep: async () => {},
    request: async (url, opts) => {
      requests.push({ url, opts });
      if (opts) throw new TypeError("connection lost");
      return { requestId: "same-id", status: "succeeded" };
    },
  });
  await client.send({ requestId: "same-id", kind: "start" });
  assert.equal(requests.filter((r) => r.opts).length, 1);
  assert.equal(requests[1].url, "/api/commands/same-id");
  assert.equal(client.pending, false);
});
test("reload recovers a not-yet-accepted command with exactly the persisted payload", async () => {
  const saved = storage(),
    payload = { requestId: "same-id", kind: "start", setup: { aiCount: 8 } };
  saved.setItem("holdem.app.command.v1", JSON.stringify(payload));
  let posted;
  const client = createLobbyCommandClient({
    storage: saved,
    request: async (url, opts) => {
      if (!opts) throw Object.assign(new Error("not found"), { status: 404 });
      posted = JSON.parse(opts.body);
      return { status: "succeeded" };
    },
  });
  await client.recover();
  assert.deepEqual(posted, payload);
  assert.equal(client.pending, false);
});

test("fallback re-POST with stale app clears pending rather than wedging the tab", async () => {
  const saved = storage();
  saved.setItem(
    "holdem.app.command.v1",
    JSON.stringify({ requestId: "old-id", kind: "start" }),
  );
  const client = createLobbyCommandClient({
    storage: saved,
    request: async (url, options) => {
      throw Object.assign(new Error(options ? "STALE_APP" : "NOT_FOUND"), {
        status: options ? 409 : 404,
      });
    },
  });
  await assert.rejects(client.recover(), /STALE_APP/);
  assert.equal(client.pending, false);
});


test("accepted command survives receipt disconnect and recovers the same ID", async () => {
  const saved = storage();
  let posts = 0;
  let reads = 0;
  const client = createLobbyCommandClient({
    storage: saved,
    sleep: async () => {},
    request: async (url, options) => {
      if (options) {
        posts++;
        return { requestId: "accepted-id", status: "accepted" };
      }
      assert.equal(url, "/api/commands/accepted-id");
      if (++reads === 1) throw new TypeError("fetch failed");
      return { requestId: "accepted-id", status: "succeeded" };
    },
  });
  await assert.rejects(client.send({ requestId: "accepted-id", kind: "start" }), /fetch failed/);
  assert.equal(client.pending, true);
  await client.recover();
  assert.equal(posts, 1);
  assert.equal(reads, 2);
  assert.equal(client.pending, false);
});
