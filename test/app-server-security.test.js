import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { startAppService } from "../tools/app-service.js";
test("app rejects foreign origins, unauthenticated and private relay routes", async (t) => {
  const app = await startAppService(createOwnedTempDir("lobby-security"));
  t.after(() => app.close());
  const auth = { authorization: `Bearer ${app.token}` };
  for (const route of [
    "/api/app",
    "/api/commands",
    "/api/game/00000000-0000-4000-8000-000000000000/snapshot",
  ])
    assert.equal((await fetch(app.origin + route)).status, 401);
  assert.equal(
    (
      await fetch(app.origin + "/api/app", {
        headers: { ...auth, origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      http
        .get(
          app.origin + "/api/app",
          { headers: { ...auth, host: "evil.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on("error", reject);
    }),
    403,
  );
  for (const endpoint of ["publish", "wait-action", "../snapshot"])
    assert.notEqual(
      (
        await fetch(
          `${app.origin}/api/game/00000000-0000-4000-8000-000000000000/${endpoint}`,
          { headers: auth },
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await fetch(app.origin + "/api/commands", {
        method: "POST",
        headers: auth,
        body: "x".repeat(17000),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(app.origin + "/.app/descriptor.json", { headers: auth }))
      .status,
    404,
  );
  const body = await (
    await fetch(app.origin + "/api/app", { headers: auth })
  ).text();
  assert.ok(!body.includes(app.token));
  assert.ok(!body.includes("sessionToken"));
});
