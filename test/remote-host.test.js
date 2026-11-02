// Remote host listener: HTTPS, an allowlisted Host header and a password session in front of the
// same host API the loopback listener serves with its per-start service token.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { fakeRelay, makeLoop, makeSession, startProxyApp } from "./helpers/relay-proxy-fixture.js";
import { parseServeArgs, setHostPassword, startAppService } from "../tools/app-service.js";
import { canonicalRemoteName, remoteHostForms, remoteOrigin, remoteRouteOf } from "../tools/app-server.js";
import { readHostCredential, verifyPassword } from "../tools/host-auth.js";

const PASSWORD = "remote host password";
const GAME = "00000000-0000-4000-8000-000000000000";
const APP_SERVICE = path.resolve("tools/app-service.js");
const FIXTURES = fileURLToPath(new URL("./fixtures/remote-host-tls/", import.meta.url));
// Committed test-only pairs (see the fixture README): no openssl, so these tests always run.
const CERT_A = { cert: path.join(FIXTURES, "a.crt"), key: path.join(FIXTURES, "a.key") };
const CERT_B = { cert: path.join(FIXTURES, "b.crt"), key: path.join(FIXTURES, "b.key") };
const remoteOptions = (extra = {}) => ({
  port: 0, listen: "127.0.0.1", names: ["localhost"], tlsCert: CERT_A.cert, tlsKey: CERT_A.key,
  authOptions: { failureDelayMs: 0 }, ...extra,
});

function request(port, { method = "GET", path: target = "/", headers = {}, body, host = `localhost:${port}`, ca = CERT_A.cert } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port, method, path: target, servername: "localhost", ca: fs.readFileSync(ca),
      headers: { host, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* html or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

async function boot(t, { password = PASSWORD, remote = {} } = {}) {
  const store = createOwnedTempDir("remote-host-store");
  if (password) await setHostPassword(store, password);
  const app = await startAppService(store, { remoteHost: remoteOptions(remote) });
  t.after(() => app.close());
  return { app, store, port: app.remoteHostPort };
}

const login = async (port, password = PASSWORD) => request(port, { method: "POST", path: "/api/host/login", body: { password } });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

test("remote names normalize to the Host and Origin spellings a browser sends", () => {
  for (const [raw, name] of [["Mini.Tail1.ts.net", "mini.tail1.ts.net"], ["fd7a:115c:a1e0:ab12:0:0:0:1", "[fd7a:115c:a1e0:ab12::1]"],
    ["[FD7A::1]", "[fd7a::1]"], ["0:0:0:0:0:0:0:1", "[::1]"], ["100.64.0.1", "100.64.0.1"], ["localhost", "localhost"],
    ["2130706433", "127.0.0.1"], [":::", null], ["1:2", null], ["mini:8898", null], ["bad name", null], ["a/b", null],
    ["a..b", null], ["-x", null], ["", null], ["mini@evil", null]])
    assert.equal(canonicalRemoteName(raw), name, raw);
  const forms = (raw, port) => [...remoteHostForms(raw.map(canonicalRemoteName), port)];
  assert.deepEqual(forms(["Mini.Tail1.ts.net"], 8898), ["mini.tail1.ts.net:8898"]);
  assert.deepEqual(forms(["mini"], 443), ["mini"], "a browser omits the default port");
  assert.deepEqual(forms(["fd7a:115c:0:0:0:0:0:1", "[fd7a:115c::2]"], 8898), ["[fd7a:115c::1]:8898", "[fd7a:115c::2]:8898"]);
  assert.equal(remoteOrigin("mini", 443), "https://mini");
  assert.equal(remoteOrigin(canonicalRemoteName("FD7A:0:0::1"), 8898), "https://[fd7a::1]:8898");
  for (const [route, kind] of [["/api/app", "host"], ["/api/room", "host"], ["/api/commands", "host"], ["/api/commands/r-1", "host"],
    ["/api/app/interrupt-decision", "host"], [`/api/game/${GAME}/events`, "host"], [`/api/game/${GAME}/reveal`, "host"],
    ["/api/host/login", "login"], ["/api/host/logout", "logout"], ["/api/stop", "forbidden"], ["/api/prefill", "forbidden"],
    ["/api/study", "study"], ["/api/join", "not-found"], ["/api/p/state", "not-found"], [`/api/game/${GAME}/other`, "not-found"],
    ["/api/app/x", "not-found"], ["/api/commands/a/b", "not-found"], ["/api/nothing", "not-found"]])
    assert.equal(remoteRouteOf(route), kind, route);
});

test("the remote host listener refuses to start without names, an address, TLS or a password", async () => {
  const store = createOwnedTempDir("remote-host-refuse");
  await setHostPassword(store, PASSWORD);
  const refuse = (remoteHost, code) => assert.rejects(startAppService(store, { remoteHost }), { code });
  await refuse(remoteOptions({ names: [] }), "REMOTE_HOST_NAME_REQUIRED");
  await refuse(remoteOptions({ names: ["bad name"] }), "REMOTE_HOST_NAME_INVALID");
  for (const name of ["127.0.0.1", "2130706433", ":::", "1:2", "mini:8898"])
    await refuse(remoteOptions({ names: [name] }), "REMOTE_HOST_NAME_INVALID");
  await refuse(remoteOptions({ listen: null }), "REMOTE_HOST_LISTEN_REQUIRED");
  await refuse(remoteOptions({ listen: " " }), "REMOTE_HOST_LISTEN_REQUIRED");
  await refuse(remoteOptions({ tlsCert: null }), "REMOTE_HOST_TLS_REQUIRED");
  await refuse(remoteOptions({ port: 70000 }), "REMOTE_HOST_PORT_INVALID");
  await refuse(remoteOptions({ tlsKey: CERT_B.key }), "REMOTE_HOST_TLS_INVALID");
  await refuse(remoteOptions({ tlsCert: path.join(FIXTURES, "missing.crt") }), "REMOTE_HOST_TLS_INVALID");
  const bare = createOwnedTempDir("remote-host-nopass");
  await assert.rejects(startAppService(bare, { remoteHost: remoteOptions() }), { code: "HOST_PASSWORD_NOT_SET" });
  fs.writeFileSync(path.join(bare, ".app", "host-auth.json"), "{}", { mode: 0o600 });
  await assert.rejects(startAppService(bare, { remoteHost: remoteOptions() }), { code: "HOST_AUTH_INVALID" });
  // Without the remote listener a damaged credential is inert, and a refused start released the store.
  const app = await startAppService(bare);
  assert.equal(app.remoteHostPort, null);
  assert.deepEqual(app.remoteHostOrigins, []);
  const challenge = await fetch(`${app.origin}/api/app`, { headers: bearer("0".repeat(64)) });
  assert.equal(challenge.status, 401);
  assert.equal((await fetch(`${app.origin}/api/app`, { headers: bearer(app.token) })).status, 200);
  await app.close();
});

test("a listen failure closes every listener already opened", async (t) => {
  const store = createOwnedTempDir("remote-host-busy");
  await setHostPassword(store, PASSWORD);
  // Hold one port on each address the listeners use: some platforms let a wildcard bind share a
  // port held only on 127.0.0.1.
  const blocker = net.createServer(), wildcard = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => wildcard.listen(0, "0.0.0.0", resolve));
  t.after(() => { blocker.close(); wildcard.close(); });
  const refused = async (options, code) => {
    let app;
    await assert.rejects(startAppService(store, options).then((started) => { app = started; }), { code });
    await app?.close();
  };
  const servers = () => process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;
  const settle = async (expected) => {
    // A closed handle leaves the active list a moment after its close callback.
    const deadline = Date.now() + 5000;
    while (servers() !== expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return servers();
  };
  const before = servers();
  await refused({ remoteHost: remoteOptions({ port: blocker.address().port }) }, "EADDRINUSE");
  assert.equal(await settle(before), before, "the remote listener failed: loopback and public are closed");
  await refused({ publicPort: wildcard.address().port }, "EADDRINUSE");
  assert.equal(await settle(before), before, "the public listener failed: loopback is closed");
  await refused({ remoteHost: remoteOptions({ listen: "192.0.2.123" }) }, "EADDRNOTAVAIL");
  assert.equal(await settle(before), before, "an address that is not up yet (Tailscale late) leaves nothing open");
  const app = await startAppService(store);
  await app.close();
});

test("an IPv6 name registered in full matches the compressed Host a browser sends", async (t) => {
  const { port, app } = await boot(t, { remote: { names: ["0:0:0:0:0:0:0:1", "Localhost"] } });
  assert.deepEqual(app.remoteHostOrigins, [`https://[::1]:${port}`, `https://localhost:${port}`]);
  for (const host of [`[::1]:${port}`, `[0:0:0:0:0:0:0:1]:${port}`, `localhost:${port}`])
    assert.equal((await request(port, { host })).status, 200, host);
  for (const host of [`[::2]:${port}`, `localhost:${port}/x`, `localhost:${port}@evil`])
    assert.equal((await request(port, { host })).status, 403, host);
});

test("only an allowlisted Host reaches the remote listener, and API calls must be same-origin", async (t) => {
  const { port, app } = await boot(t);
  assert.deepEqual(app.remoteHostOrigins, [`https://localhost:${port}`]);
  const lobby = await request(port);
  assert.equal(lobby.status, 200);
  assert.match(lobby.text, /<title>AI 홀덤 · 게임 로비<\/title>/);
  assert.match(lobby.headers["content-security-policy"], /default-src 'self'/);
  assert.equal((await request(port, { host: `LOCALHOST:${port}` })).status, 200, "Host is case-insensitive");
  for (const host of [`evil.test:${port}`, "localhost", `127.0.0.1:${port}`, ""])
    assert.equal((await request(port, { host })).status, 403, host);
  // A navigation from another site still opens the page; an API call from one does not.
  assert.equal((await request(port, { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
  const { token } = (await login(port)).json;
  assert.equal((await request(port, { path: "/api/app", headers: { ...bearer(token), "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await request(port, { path: "/api/app", headers: { ...bearer(token), origin: "https://evil.test" } })).status, 403);
  assert.equal((await request(port, { path: "/api/app", headers: { ...bearer(token), origin: `http://localhost:${port}` } })).status, 403);
  assert.equal((await request(port, { path: "/api/app", headers: { ...bearer(token), origin: `https://localhost:${port}` } })).status, 200);
  assert.equal((await request(port, { method: "POST", path: "/api/host/login", headers: { origin: "https://evil.test" }, body: { password: PASSWORD } })).status, 403);
});

test("the host API needs a password session there, and neither listener takes the other's credential", async (t) => {
  const { port, app } = await boot(t);
  assert.equal((await request(port, { path: "/api/app" })).status, 401);
  assert.equal((await request(port, { path: "/api/app", headers: bearer(app.token) })).status, 401, "the service token is loopback-only");
  const wrong = await login(port, "not the password");
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, { code: "LOGIN_FAILED" });
  assert.equal((await request(port, { method: "GET", path: "/api/host/login" })).status, 405);
  assert.equal((await request(port, { method: "POST", path: "/api/host/login", body: "{" })).status, 400);
  const ok = await login(port);
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^[0-9a-f]{64}$/);
  assert.equal(ok.headers["cache-control"], "no-store");
  const state = await request(port, { path: "/api/app", headers: bearer(ok.json.token) });
  assert.equal(state.status, 200);
  assert.equal(state.json.state, "lobby");
  assert.ok(!state.text.includes(app.token), "the service token never reaches a remote host");
  const loopback = await fetch(`${app.origin}/api/app`, { headers: bearer(ok.json.token) });
  assert.equal(loopback.status, 401, "a remote session is not a loopback credential");
  assert.equal((await request(port, { path: "/api/nothing", headers: bearer(ok.json.token) })).status, 404);
});

test("routes are classified before authentication: forbidden, study and participant paths", async (t) => {
  const { port, store } = await boot(t);
  const { token } = (await login(port)).json;
  for (const auth of [{}, bearer(token)]) {
    for (const method of ["POST", "GET"]) {
      const stop = await request(port, { method, path: "/api/stop", headers: auth });
      assert.equal(stop.status, 403);
      assert.equal(stop.json.code, "REMOTE_FORBIDDEN");
    }
    assert.equal((await request(port, { method: "POST", path: "/api/prefill", headers: auth, body: { aiCount: 3 } })).json.code, "REMOTE_FORBIDDEN");
    const study = await request(port, { method: "POST", path: "/api/study", headers: auth });
    assert.equal(study.status, 409);
    assert.equal(study.json.code, "STUDY_LOCAL_ONLY");
    for (const target of ["/api/join", "/api/p/state", `/api/p/game/${GAME}/snapshot`, "/api/unknown", `/api/game/${GAME}/other`])
      assert.equal((await request(port, { path: target, headers: auth })).status, 404, target);
  }
  // No side effects: the service is up, nothing was prefilled, and no study service was started.
  const state = await request(port, { path: "/api/app", headers: bearer(token) });
  assert.equal(state.status, 200);
  assert.notEqual(state.json.defaultSetup?.aiCount, 3);
  assert.deepEqual(fs.readdirSync(store).filter((name) => /study|drill/i.test(name)), []);
});

test("each listener serves only its own pages: login on remote, lobby never on the participant port", async (t) => {
  const { port, app } = await boot(t, { remote: {} });
  for (const target of ["/login", "/login.js", "/login.html", "/", "/table", "/lobby.js"])
    assert.equal((await request(port, { path: target })).status, 200, `remote ${target}`);
  assert.equal((await request(port, { path: "/join" })).status, 404);
  assert.equal((await request(port, { path: "/.app/host-auth.json" })).status, 404);
  for (const target of ["/login", "/login.html", "/login.js", "/Login.html", "/LOGIN.JS"])
    assert.equal((await fetch(`${app.origin}${target}`)).status, 404, `loopback ${target}`);
  // Exact names only: a case-insensitive file system must not open a blocked page by an alias.
  for (const target of ["/Login.html", "/Lobby.html", "/LOBBY.JS", "/Index.html"])
    assert.equal((await request(port, { path: target })).status, 404, `remote ${target}`);
  assert.equal((await fetch(`${app.origin}/`)).status, 200);
  const participant = await startAppService(createOwnedTempDir("remote-host-public"), { publicPort: 0 });
  t.after(() => participant.close());
  for (const target of ["/login.html", "/login.js", "/lobby.html", "/Login.html", "/LOGIN.html", "/Login.js", "/Lobby.html", "/shared/Pace.js"])
    assert.equal((await fetch(`${participant.publicOrigin}${target}`)).status, 404, `participant ${target}`);
  for (const target of ["/join", "/table", "/app.js", "/remote-host.js"])
    assert.equal((await fetch(`${participant.publicOrigin}${target}`)).status, 200, `participant ${target}`);
});

test("logout, a new password and a removed credential end remote sessions", async (t) => {
  const { port, store } = await boot(t);
  const first = (await login(port)).json.token;
  const second = (await login(port)).json.token;
  assert.equal((await request(port, { method: "GET", path: "/api/host/logout", headers: bearer(first) })).status, 405);
  assert.deepEqual((await request(port, { method: "POST", path: "/api/host/logout", headers: bearer(first) })).json, { ok: true });
  assert.equal((await request(port, { path: "/api/app", headers: bearer(first) })).status, 401);
  assert.equal((await request(port, { path: "/api/app", headers: bearer(second) })).status, 200);
  await setHostPassword(store, "the next remote password");
  assert.equal((await request(port, { path: "/api/app", headers: bearer(second) })).status, 401);
  assert.equal((await login(port)).status, 401);
  const third = (await login(port, "the next remote password")).json.token;
  fs.unlinkSync(path.join(store, ".app", "host-auth.json"));
  assert.equal((await request(port, { path: "/api/app", headers: bearer(third) })).status, 401);
  assert.deepEqual((await login(port, "the next remote password")).json, { code: "HOST_PASSWORD_NOT_SET" });
});

test("repeated wrong passwords lock that address with Retry-After", async (t) => {
  const { port } = await boot(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await login(port, `wrong password ${i}`)).status, 401);
  const locked = await login(port);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "LOGIN_RATE_LIMIT");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal(locked.headers["retry-after"], String(locked.json.retryAfterSec));
});

test("a locked address is refused before its login body is read", async (t) => {
  const { port } = await boot(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await login(port, `wrong password ${i}`)).status, 401);
  const started = Date.now();
  const head = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername: "localhost", ca: fs.readFileSync(CERT_A.cert) }, () => {
      socket.write(`POST /api/host/login HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"pass`);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk; if (text.includes("\r\n\r\n")) { resolve(text); socket.destroy(); } });
    socket.on("error", reject);
    setTimeout(() => { socket.destroy(); resolve("no answer"); }, 8000);
  });
  assert.match(head, /^HTTP\/1\.1 429/);
  assert.match(head, /retry-after: \d+/i);
  assert.ok(Date.now() - started < 5000, "answered without waiting for the body or the request timeout");
});

test("a login body that never finishes is cut off instead of holding the socket", async (t) => {
  const { port } = await boot(t, { remote: { requestTimeoutMs: 600 } });
  const started = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername: "localhost", ca: fs.readFileSync(CERT_A.cert) }, () => {
      socket.write(`POST /api/host/login HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"password":"`);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
    setTimeout(() => { socket.destroy(); resolve("still open"); }, 10_000);
  });
  assert.notEqual(outcome, "still open");
  assert.match(outcome, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - started < 9000);
  // A normal login still works afterwards.
  assert.equal((await login(port)).status, 200);
});

test("a renewed certificate is served to new connections without a restart", async (t) => {
  const dir = createOwnedTempDir("remote-host-renew");
  const cert = path.join(dir, "host.crt"), key = path.join(dir, "host.key");
  fs.copyFileSync(CERT_A.cert, cert);
  fs.copyFileSync(CERT_A.key, key);
  const { port } = await boot(t, { remote: { tlsCert: cert, tlsKey: key, tlsReloadMs: 50 } });
  const fingerprint = () => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername: "localhost", rejectUnauthorized: false }, () => {
      resolve(socket.getPeerX509Certificate().fingerprint256);
      socket.end();
    });
    socket.on("error", reject);
  });
  const a = new X509Certificate(fs.readFileSync(CERT_A.cert)).fingerprint256;
  const b = new X509Certificate(fs.readFileSync(CERT_B.cert)).fingerprint256;
  assert.equal(await fingerprint(), a);
  // Half a renewal (new certificate, old key) keeps serving the old pair.
  fs.copyFileSync(CERT_B.cert, cert);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await fingerprint(), a);
  fs.copyFileSync(CERT_B.key, key);
  const deadline = Date.now() + 5000;
  let seen = a;
  while (seen !== b && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    seen = await fingerprint();
  }
  assert.equal(seen, b);
  assert.equal((await request(port, { method: "POST", path: "/api/host/login", body: { password: PASSWORD }, ca: CERT_B.cert })).status, 200);
});

test("a remote host plays through the shared relay proxy, without the study link, and a logout ends its stream", { timeout: 60000 }, async (t) => {
  const credentials = createOwnedTempDir("remote-host-relay");
  await setHostPassword(credentials, PASSWORD);
  const relay = await fakeRelay({ snapshotExtra: { studyUrl: `http://127.0.0.1:9/#token=${"d".repeat(64)}` } });
  t.after(() => relay.close());
  const session = makeSession(createOwnedTempDir("remote-host-relay-session"), relay.port);
  const loop = makeLoop(session);
  const h = await startProxyApp(t, { loop, relay, session, remoteHost: remoteOptions({ appDir: path.join(credentials, ".app") }) });
  const port = h.app.remoteHostPort;
  const { token } = (await login(port)).json;
  const game = (endpoint) => `/api/game/${h.ctx.gameId}/${endpoint}`;
  const headers = { ...bearer(token), "x-game-epoch": h.ctx.epoch };
  // The loopback host still receives the study link; the remote host never does.
  const local = await (await h.hostGet("snapshot")).json();
  assert.match(local.studyUrl, /#token=d{64}$/);
  const snapshot = await request(port, { path: game("snapshot"), headers });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.view.viewer, "user");
  assert.equal(Object.hasOwn(snapshot.json, "studyUrl"), false);
  assert.ok(!snapshot.text.includes("d".repeat(64)));
  const action = await request(port, { method: "POST", path: game("action"), headers, body: h.actionBody() });
  assert.equal(action.status, 200);
  const forwarded = relay.seen.requests.filter((row) => row.path === "/api/action").at(-1);
  assert.equal(forwarded.headers["x-seat"], "user");
  assert.equal(forwarded.body.note, "secret", "the host keeps its intent note");
  assert.equal(Object.hasOwn(forwarded.body, "seat"), false);
  // An open event stream ends the moment its session is logged out.
  const stream = await new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path: game("events?after=0"), servername: "localhost", ca: fs.readFileSync(CERT_A.cert),
      headers: { ...headers, host: `localhost:${port}` }, agent: false }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; if (data.includes("hello")) resolve({ res, ended: new Promise((done) => res.on("close", done)) }); });
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(stream.res.statusCode, 200);
  assert.equal(relay.openStreams(), 1);
  assert.equal((await request(port, { method: "POST", path: "/api/host/logout", headers: bearer(token) })).status, 200);
  const closed = await Promise.race([stream.ended.then(() => true), new Promise((resolve) => setTimeout(resolve, 5000, false))]);
  if (!closed) stream.res.destroy();
  assert.equal(closed, true, "the logged-out session's open stream is closed");
  const deadline = Date.now() + 5000;
  while (relay.openStreams() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.openStreams(), 0, "the upstream relay stream is released too");
  assert.equal((await request(port, { path: game("snapshot"), headers })).status, 401);
  // A new password ends every older session's open stream at the next request any of them makes.
  const tokens = [(await login(port)).json.token, (await login(port)).json.token];
  const streams = [];
  for (const token of tokens) {
    streams.push(await new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port, path: game("events?after=0"), servername: "localhost", ca: fs.readFileSync(CERT_A.cert),
        headers: { ...bearer(token), "x-game-epoch": h.ctx.epoch, host: `localhost:${port}` }, agent: false }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; if (data.includes("hello")) resolve({ res, ended: new Promise((done) => res.on("close", done)) }); });
      });
      req.on("error", reject);
      req.end();
    }));
  }
  assert.equal(relay.openStreams(), 2);
  await setHostPassword(credentials, "a replacement password");
  assert.equal((await request(port, { path: "/api/app", headers: bearer(tokens[0]) })).status, 401);
  for (const [i, stream] of streams.entries()) {
    const ended = await Promise.race([stream.ended.then(() => true), new Promise((resolve) => setTimeout(resolve, 5000, false))]);
    if (!ended) stream.res.destroy();
    assert.equal(ended, true, `stream ${i} closed`);
  }
  const until = Date.now() + 5000;
  while (relay.openStreams() !== 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.openStreams(), 0);
});

test("serve reads the remote flags, exits when they fail, and host-password stores a private credential", { timeout: 90000 }, async (t) => {
  assert.throws(() => parseServeArgs(["--remote-host-name", "a"]), { code: "REMOTE_HOST_PORT_INVALID" });
  assert.deepEqual(parseServeArgs(["--player-runtime", "claude"]).remoteHost, null);
  assert.deepEqual(parseServeArgs(["--remote-host-port", "8898", "--remote-host-name", "mini.tail.ts.net", "--remote-host-name", "mini", "--remote-host-listen", "100.64.0.1", "--remote-tls-cert", "/c", "--remote-tls-key", "/k"]).remoteHost,
    { port: 8898, listen: "100.64.0.1", names: ["mini.tail.ts.net", "mini"], tlsCert: "/c", tlsKey: "/k" });
  assert.equal(parseServeArgs(["--remote-host-port", "8898"]).remoteHost.listen, null, "no default bind address");
  const store = createOwnedTempDir("remote-host-cli");
  const short = spawnSync(process.execPath, [APP_SERVICE, "host-password", store], { input: "too short\n", encoding: "utf8" });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /PASSWORD_TOO_SHORT/);
  assert.equal(readHostCredential(path.join(store, ".app")), null);
  assert.equal(spawnSync(process.execPath, [APP_SERVICE, "host-password", "relative/store"], { input: `${PASSWORD}\n`, encoding: "utf8" }).status, 1);
  const set = spawnSync(process.execPath, [APP_SERVICE, "host-password", store], { input: `${PASSWORD}\r\nsecond line\n`, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr);
  const record = readHostCredential(path.join(store, ".app"));
  assert.equal(await verifyPassword(record, PASSWORD), true, "only the first line, without its line ending");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(store, ".app", "host-auth.json")).mode & 0o777, 0o600);
  const serveArgs = (extra) => [APP_SERVICE, "serve", store, "--remote-host-port", "0", "--remote-host-name", "localhost", "--remote-tls-cert", CERT_A.cert, "--remote-tls-key", CERT_A.key, ...extra];
  const env = { ...process.env, HOLDEM_PUBLIC_PORT: "0" };
  // A failed remote start ends the process (launchd restarts it), it does not linger half-open.
  const failed = spawnSync(process.execPath, serveArgs(["--remote-host-listen", "192.0.2.123"]), { env, encoding: "utf8", timeout: 30000 });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /EADDRNOTAVAIL/);
  const missing = spawnSync(process.execPath, serveArgs([]), { env, encoding: "utf8", timeout: 30000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /REMOTE_HOST_LISTEN_REQUIRED/);
  // End to end through the CLI: serve prints the remote origin and the password logs in.
  const child = spawn(process.execPath, serveArgs(["--remote-host-listen", "127.0.0.1"]), { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  let stdout = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve printed no remote origin: ${stdout}`)), 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /remote host: https:\/\/localhost:(\d+)\//.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`serve exited ${code}`)); });
  });
  const { token } = (await login(port)).json;
  assert.equal((await request(port, { path: "/api/app", headers: bearer(token) })).status, 200);
  child.kill("SIGTERM");
  // POSIX runs the SIGTERM close handler; Windows terminates the process without one.
  if (process.platform !== "win32") assert.equal(await exited, 0);
  else await exited;
});

test("the loopback listener is unchanged when the remote listener is on", async (t) => {
  const { app } = await boot(t);
  assert.match(app.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${app.origin}/api/app`, { headers: bearer(app.token) })).status, 200);
  const host = await new Promise((resolve, reject) => {
    http.get(`${app.origin}/api/app`, { headers: { ...bearer(app.token), host: "localhost" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(host, 403);
  // Remote paths do not exist on loopback.
  assert.equal((await fetch(`${app.origin}/api/host/login`, { method: "POST", headers: bearer(app.token), body: "{}" })).status, 404);
});
