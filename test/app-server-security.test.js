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

test('skip-result is a host-only, epoch-bound timer operation outside the command journal', async t => {
  const {startAppServer} = await import('../tools/app-server.js');
  const root=createOwnedTempDir('holdem-skip-api');
  const gameId='00000000-0000-4000-8000-000000000001',epoch='ab'.repeat(32),token='host-skip-token';
  const calls=[];
  const manager={current:{gameId},snapshot:()=>({gameId,gameEpoch:epoch,state:'playing'}),
    session:{loop:{skipHandResult:handNo=>{calls.push(handNo);return {skipped:handNo===7};}}},
    command:()=>{throw new Error('skip must not enter the command journal');}};
  const app=await startAppServer({manager,token,storeDir:root,publicPort:0});
  t.after(()=>app.close());
  const route=`/api/game/${gameId}/skip-result`;
  const headers={authorization:`Bearer ${token}`,origin:app.origin,'x-game-epoch':epoch,'content-type':'application/json'};
  const send=(body={handNo:7},extra={})=>fetch(app.origin+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await send(undefined,{authorization:''})).status,401);
  assert.equal((await send(undefined,{origin:'https://evil.test'})).status,403);
  assert.equal((await send(undefined,{'x-game-epoch':'old'})).status,409);
  assert.equal((await fetch(app.origin+route,{headers})).status,405);
  for(const body of [{handNo:0},{handNo:1.5},{handNo:'7'},{handNo:7,extra:true},{}]) assert.equal((await send(body)).status,400);
  assert.deepEqual(await (await send()).json(),{skipped:true});
  assert.deepEqual(await (await send()).json(),{skipped:true});
  assert.deepEqual(await (await send({handNo:6})).json(),{skipped:false});
  assert.deepEqual(calls,[7,7,6]);
  const publicResponse=await fetch(`http://127.0.0.1:${app.publicPort}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"handNo":7}'});
  assert.equal(publicResponse.status,404);
  manager.current={gameId:'00000000-0000-4000-8000-000000000002'};
  assert.equal((await send()).status,409);
  manager.current={gameId};manager.session=null;
  assert.equal((await send()).status,409);
  assert.deepEqual(calls,[7,7,6]);
});
