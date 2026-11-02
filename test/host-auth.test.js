import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";
import { createPrivateDirectory, isPrivatePath } from "../shared/platform-files.js";
import {
  checkNewPassword,
  createCredentialSource,
  createHostSessions,
  createLoginLimiter,
  createRemoteHostAuth,
  createTlsReloader,
  hashPassword,
  tlsContentIdentity,
  hostCredentialPath,
  readHostCredential,
  validateHostCredential,
  verifyPassword,
  writeHostCredential,
} from "../tools/host-auth.js";

const PASSWORD = "correct horse battery";
function appDirFor(prefix) {
  const dir = path.join(createOwnedTempDir(prefix), ".app");
  createPrivateDirectory(dir);
  return dir;
}
const fakeResponse = () => {
  const handlers = {};
  return {
    destroyed: false,
    destroy() { this.destroyed = true; handlers.close?.(); },
    once(event, fn) { handlers[event] = fn; },
  };
};

test("passwords hash with scrypt and verify only the same NFC text", async () => {
  const record = await hashPassword(PASSWORD);
  assert.equal(record.kdf, "scrypt");
  assert.deepEqual([record.N, record.r, record.p, record.keyLength], [2 ** 16, 8, 2, 32]);
  assert.equal(await verifyPassword(record, PASSWORD), true);
  assert.equal(await verifyPassword(record, PASSWORD + " "), false);
  assert.equal(await verifyPassword(record, "correct horse batterY"), false);
  // Decomposed Hangul typed on another device verifies against the composed one.
  const composed = "한글비밀번호입니다아주길게";
  const nfcRecord = await hashPassword(composed);
  assert.equal(await verifyPassword(nfcRecord, composed.normalize("NFD")), true);
  // Two hashes of one password differ (fresh salt and credential id).
  const again = await hashPassword(PASSWORD);
  assert.notEqual(again.salt, record.salt);
  assert.notEqual(again.credentialId, record.credentialId);
});

test("new passwords need 12 to 256 code points", () => {
  assert.throws(() => checkNewPassword("short-pass1"), { code: "PASSWORD_TOO_SHORT" });
  assert.equal(checkNewPassword("twelve-chars"), "twelve-chars");
  // Code points, not UTF-16 units: twelve emoji are long enough.
  assert.equal(checkNewPassword("🂡".repeat(12)), "🂡".repeat(12));
  assert.throws(() => checkNewPassword("🂡".repeat(11)), { code: "PASSWORD_TOO_SHORT" });
  assert.throws(() => checkNewPassword("x".repeat(257)), { code: "PASSWORD_TOO_LONG" });
  assert.throws(() => checkNewPassword(null), { code: "PASSWORD_INVALID" });
});

test("credential records fail closed on any other shape or unbounded parameters", async () => {
  const record = await hashPassword(PASSWORD);
  assert.equal(validateHostCredential(record), record);
  const bad = [
    { ...record, extra: 1 },
    (({ salt, ...rest }) => rest)(record),
    { ...record, kdf: "pbkdf2" },
    { ...record, schemaVersion: 2 },
    { ...record, N: 2 ** 17 },
    { ...record, N: 2 ** 15 },
    { ...record, N: 3000 },
    { ...record, r: 9 },
    { ...record, r: 1 },
    { ...record, p: 3 },
    { ...record, p: 1 },
    { ...record, p: 0 },
    { ...record, N: "65536" },
    { ...record, keyLength: 64 },
    { ...record, salt: "AAAA" },
    { ...record, hash: record.hash.slice(0, -4) + "!!!=" },
    { ...record, credentialId: "../x" },
    { ...record, createdAt: "yesterday" },
    null,
    [],
  ];
  for (const value of bad) assert.throws(() => validateHostCredential(value), { code: "HOST_AUTH_INVALID" });
  await assert.rejects(verifyPassword({ ...record, N: 2 ** 20 }, PASSWORD), { code: "HOST_AUTH_INVALID" });
});

test("the credential file is private, read back exactly, and refused when unsafe", async () => {
  const appDir = appDirFor("host-auth-file");
  assert.equal(readHostCredential(appDir), null);
  const record = await hashPassword(PASSWORD);
  writeHostCredential(appDir, record);
  assert.equal(isPrivatePath(hostCredentialPath(appDir)), true);
  assert.deepEqual(readHostCredential(appDir), record);
  // Malformed JSON and an unsafe file both refuse.
  fs.writeFileSync(hostCredentialPath(appDir), "{", { mode: 0o600 });
  assert.throws(() => readHostCredential(appDir), { code: "HOST_AUTH_INVALID" });
  writeHostCredential(appDir, record);
  assert.throws(() => readHostCredential(appDir, { privateCheck: () => false }), { code: "HOST_AUTH_INVALID" });
  if (process.platform !== "win32") {
    fs.chmodSync(hostCredentialPath(appDir), 0o644);
    assert.throws(() => readHostCredential(appDir), { code: "HOST_AUTH_INVALID" });
    fs.unlinkSync(hostCredentialPath(appDir));
    const target = path.join(path.dirname(appDir), "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
    fs.symlinkSync(target, hostCredentialPath(appDir));
    assert.throws(() => readHostCredential(appDir), { code: "HOST_AUTH_INVALID" });
  }
});

test("the credential source re-reads only when the file changes", async () => {
  const appDir = appDirFor("host-auth-source");
  let reads = 0;
  const source = createCredentialSource(appDir, { read: (dir) => { reads += 1; return readHostCredential(dir); } });
  assert.deepEqual(source.current(), { state: "missing" });
  assert.deepEqual(source.current(), { state: "missing" });
  assert.equal(reads, 1);
  const first = await hashPassword(PASSWORD);
  writeHostCredential(appDir, first);
  assert.equal(source.current().record.credentialId, first.credentialId);
  source.current();
  assert.equal(reads, 2);
  const second = await hashPassword("another long password");
  writeHostCredential(appDir, second);
  assert.equal(source.current().record.credentialId, second.credentialId);
  fs.writeFileSync(hostCredentialPath(appDir), "{}", { mode: 0o600 });
  assert.equal(source.current().state, "invalid");
  fs.unlinkSync(hostCredentialPath(appDir));
  assert.equal(source.current().state, "missing");
});

test("sessions expire on idle and absolute limits and die with their credential", () => {
  let clock = 1_000_000;
  const sessions = createHostSessions({ now: () => clock, idleMs: 1000, absoluteMs: 5000, max: 3 });
  const a = sessions.issue("cred-1");
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(a.idleTimeoutSec, 1);
  assert.ok(sessions.authenticate(a.token, "cred-1"));
  assert.equal(sessions.authenticate(a.token.toUpperCase(), "cred-1"), null);
  assert.equal(sessions.authenticate("Bearer " + a.token, "cred-1"), null);
  // Idle: each use slides the idle deadline until the absolute limit.
  for (let i = 0; i < 5; i += 1) {
    clock += 900;
    assert.ok(sessions.authenticate(a.token, "cred-1"), `use ${i}`);
  }
  clock += 900; // 4500 + 900 = 5400 ≥ absolute 5000, though the last use was 900 ago
  assert.equal(sessions.authenticate(a.token, "cred-1"), null);
  assert.equal(sessions.size, 0);
  const b = sessions.issue("cred-1");
  clock += 1000;
  assert.equal(sessions.authenticate(b.token, "cred-1"), null, "idle expiry");
  const c = sessions.issue("cred-1");
  assert.equal(sessions.authenticate(c.token, "cred-2"), null, "a new credential ends the session");
  assert.equal(sessions.authenticate(c.token, "cred-1"), null, "and it stays ended");
});

test("sessions cap at the maximum, revoke, and destroy attached responses", () => {
  let clock = 0;
  const sessions = createHostSessions({ now: () => (clock += 1), max: 2 });
  const a = sessions.issue("c"), b = sessions.issue("c");
  const resA = fakeResponse(), resB = fakeResponse();
  sessions.attach(sessions.authenticate(a.token, "c"), resA);
  sessions.attach(sessions.authenticate(b.token, "c"), resB);
  const c = sessions.issue("c");
  assert.equal(resA.destroyed, true, "the oldest session is evicted with its streams");
  assert.equal(sessions.authenticate(a.token, "c"), null);
  assert.ok(sessions.authenticate(c.token, "c"));
  assert.equal(sessions.revoke(b.token), true);
  assert.equal(resB.destroyed, true);
  assert.equal(sessions.revoke(b.token), false);
  const resC = fakeResponse();
  sessions.attach(sessions.authenticate(c.token, "c"), resC);
  sessions.sweep("other");
  assert.equal(resC.destroyed, true, "a sweep under a new credential ends the rest");
  const late = fakeResponse();
  sessions.attach({ key: "gone" }, late);
  assert.equal(late.destroyed, true, "a response for a vanished session is not kept");
});

test("the limiter locks an address after five failures and everyone after the global budget", () => {
  let clock = 0;
  const limiter = createLoginLimiter({ now: () => clock, windowMs: 60_000, perAddress: 5, global: 7 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check("a").ok, true);
    limiter.failure("a");
  }
  const locked = limiter.check("a");
  assert.equal(locked.ok, false);
  assert.equal(locked.scope, "address");
  assert.equal(locked.retryAfterSec, 60);
  assert.equal(limiter.check("b").ok, true, "other addresses are still allowed");
  limiter.failure("b");
  limiter.failure("c");
  const global = limiter.check("d");
  assert.equal(global.ok, false);
  assert.equal(global.scope, "global");
  clock += 30_000;
  assert.equal(limiter.check("a").retryAfterSec, 30);
  clock += 30_000;
  assert.equal(limiter.check("a").ok, true, "the window ends");
  assert.equal(limiter.check("d").ok, true);
  limiter.failure("e");
  limiter.success("e");
  assert.equal(limiter.size, 3, "success forgets the address");
});

test("the limiter prunes ended windows past its address cap", () => {
  let clock = 0;
  const limiter = createLoginLimiter({ now: () => clock, windowMs: 1000, perAddress: 5, global: 1e9, maxEntries: 4 });
  for (let i = 0; i < 4; i += 1) limiter.failure(`old-${i}`);
  clock += 1000;
  limiter.failure("new-0");
  assert.equal(limiter.size, 1);
});

async function authFixture(prefix, overrides = {}) {
  const appDir = appDirFor(prefix);
  writeHostCredential(appDir, await hashPassword(PASSWORD));
  const logs = [], delays = [];
  const auth = createRemoteHostAuth({ appDir, log: (line) => logs.push(line), delay: async (ms) => { delays.push(ms); }, ...overrides });
  return { appDir, auth, logs, delays };
}

test("login issues a session for the right password and nothing else", async () => {
  const { auth, logs, delays } = await authFixture("host-auth-login");
  const wrong = await auth.login({ addr: "100.64.0.2", body: { password: "wrong password!!" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { code: "LOGIN_FAILED" });
  assert.deepEqual(delays, [500]);
  for (const body of [null, [], {}, { password: "" }, { password: 1 }, { password: PASSWORD, extra: 1 }, { password: "x".repeat(1025) }])
    assert.equal((await auth.login({ addr: "100.64.0.2", body })).status, 400);
  const ok = await auth.login({ addr: "100.64.0.2", body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^[0-9a-f]{64}$/);
  assert.ok(auth.authenticate(`Bearer ${ok.body.token}`));
  assert.equal(auth.authenticate(ok.body.token), null);
  assert.equal(auth.authenticate(undefined), null);
  assert.ok(logs.some((line) => line === "[remote-host] login fail addr=100.64.0.2"));
  assert.ok(logs.some((line) => line === "[remote-host] login ok addr=100.64.0.2"));
  assert.ok(logs.every((line) => !line.includes(PASSWORD) && !line.includes(ok.body.token)));
  assert.equal(auth.logout(`Bearer ${ok.body.token}`), true);
  assert.equal(auth.authenticate(`Bearer ${ok.body.token}`), null);
});

test("login is rate limited per address, serialized, and refused without a credential", async () => {
  const { appDir, auth } = await authFixture("host-auth-limit");
  for (let i = 0; i < 5; i += 1)
    assert.equal((await auth.login({ addr: "a", body: { password: `wrong-${i}-password` } })).status, 401);
  const locked = await auth.login({ addr: "a", body: { password: PASSWORD } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, "LOGIN_RATE_LIMIT");
  assert.equal(locked.headers["retry-after"], String(locked.body.retryAfterSec));
  assert.equal((await auth.login({ addr: "b", body: { password: PASSWORD } })).status, 200);
  // Only one verification at a time; the second is refused without counting as a failure.
  const first = auth.login({ addr: "c", body: { password: "wrong password!!" } });
  const second = await auth.login({ addr: "c", body: { password: PASSWORD } });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "LOGIN_BUSY");
  assert.equal((await first).status, 401);
  const session = (await auth.login({ addr: "c", body: { password: PASSWORD } })).body.token;
  const stream = fakeResponse();
  auth.attach(auth.authenticate(`Bearer ${session}`), stream);
  fs.unlinkSync(hostCredentialPath(appDir));
  assert.equal(auth.authenticate(`Bearer ${session}`), null, "removing the credential ends sessions");
  assert.equal(stream.destroyed, true, "and closes their open streams at once");
  assert.deepEqual((await auth.login({ addr: "d", body: { password: PASSWORD } })).body, { code: "HOST_PASSWORD_NOT_SET" });
  fs.writeFileSync(hostCredentialPath(appDir), "{}", { mode: 0o600 });
  assert.deepEqual((await auth.login({ addr: "d", body: { password: PASSWORD } })).body, { code: "HOST_AUTH_INVALID" });
});

test("a new password ends sessions issued under the old one", async () => {
  const { appDir, auth } = await authFixture("host-auth-rotate");
  const token = (await auth.login({ addr: "a", body: { password: PASSWORD } })).body.token;
  const other = (await auth.login({ addr: "b", body: { password: PASSWORD } })).body.token;
  const res = fakeResponse(), otherRes = fakeResponse();
  auth.attach(auth.authenticate(`Bearer ${token}`), res);
  auth.attach(auth.authenticate(`Bearer ${other}`), otherRes);
  writeHostCredential(appDir, await hashPassword("a brand new password"));
  // The first request after the change ends every older session's streams, not only its own.
  assert.equal(auth.authenticate(`Bearer ${other}`), null);
  assert.equal(res.destroyed, true);
  assert.equal(otherRes.destroyed, true);
  assert.equal(auth.authenticate(`Bearer ${token}`), null);
  assert.equal((await auth.login({ addr: "a", body: { password: PASSWORD } })).status, 401);
  assert.equal((await auth.login({ addr: "a", body: { password: "a brand new password" } })).status, 200);
});

const FIXTURES = new URL("./fixtures/remote-host-tls/", import.meta.url);
// Committed test-only pairs: this test runs without openssl.
const fixturePair = (dir, name) => {
  const key = path.join(dir, `${name}.key`), cert = path.join(dir, `${name}.crt`);
  fs.copyFileSync(new URL(`${name}.key`, FIXTURES), key);
  fs.copyFileSync(new URL(`${name}.crt`, FIXTURES), cert);
  return { key, cert };
};

test("a password changed while a login is verifying issues no session", async () => {
  const { appDir, auth } = await authFixture("host-auth-race");
  const next = await hashPassword("changed during login");
  const pending = auth.login({ addr: "a", body: { password: PASSWORD } });
  // scrypt runs off the main thread: this write lands before the verification resolves.
  writeHostCredential(appDir, next);
  const result = await pending;
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: "LOGIN_RETRY" });
  assert.equal(auth.sessions.size, 0);
  // Removed or damaged while verifying: still no session.
  for (const damage of [() => fs.unlinkSync(hostCredentialPath(appDir)), () => fs.writeFileSync(hostCredentialPath(appDir), "{}", { mode: 0o600 })]) {
    writeHostCredential(appDir, next);
    const racing = auth.login({ addr: "b", body: { password: "changed during login" } });
    damage();
    assert.notEqual((await racing).status, 200);
    assert.equal(auth.sessions.size, 0);
  }
});

test("a reloader started from what the server loaded picks up a change made before it was created", () => {
  const dir = createOwnedTempDir("host-auth-tls-race");
  const pair = fixturePair(dir, "a");
  const before = tlsContentIdentity(fs.readFileSync(pair.cert), fs.readFileSync(pair.key));
  // The server read pair "a"; a renewal replaced both files before the reloader was created.
  fs.copyFileSync(new URL("b.crt", FIXTURES), pair.cert);
  fs.copyFileSync(new URL("b.key", FIXTURES), pair.key);
  const applied = [];
  const reloader = createTlsReloader({ certPath: pair.cert, keyPath: pair.key, initialIdentity: before, apply: (options) => applied.push(options), log: () => {} });
  assert.equal(reloader.check(), true);
  assert.equal(applied[0].cert.toString(), fs.readFileSync(new URL("b.crt", FIXTURES), "utf8"));
});

test("a renewal is detected by content even when the files' metadata does not change", () => {
  // Windows CopyFile keeps the source's modification time, and both test pairs have the same size:
  // only the bytes tell the pairs apart. The files on disk never change here; only what they read as.
  const dir = createOwnedTempDir("host-auth-tls-bytes");
  const pair = fixturePair(dir, "a");
  const A = { [pair.cert]: fs.readFileSync(pair.cert), [pair.key]: fs.readFileSync(pair.key) };
  const B = { [pair.cert]: fs.readFileSync(new URL("b.crt", FIXTURES)), [pair.key]: fs.readFileSync(new URL("b.key", FIXTURES)) };
  let current = A;
  const applied = [];
  const reloader = createTlsReloader({ certPath: pair.cert, keyPath: pair.key, readFile: (file) => Buffer.from(current[file]), apply: (options) => applied.push(options), log: () => {} });
  assert.equal(reloader.check(), false);
  current = B;
  assert.equal(reloader.check(), true, "new bytes behind unchanged metadata are a renewal");
  assert.equal(applied.length, 1);
  assert.equal(reloader.check(), false, "the same bytes again (a fresh Buffer) are not re-applied");
  current = A;
  assert.equal(reloader.check(), true, "going back to the earlier pair is a change too");
  assert.equal(applied.length, 2);
});

test("a failed read or apply keeps the current pair and retries the same renewal later", () => {
  const dir = createOwnedTempDir("host-auth-tls-retry");
  const pair = fixturePair(dir, "a");
  const B = { [pair.cert]: fs.readFileSync(new URL("b.crt", FIXTURES)), [pair.key]: fs.readFileSync(new URL("b.key", FIXTURES)) };
  let failRead = false, failApply = 1;
  const applied = [];
  const reloader = createTlsReloader({
    certPath: pair.cert, keyPath: pair.key, log: () => {},
    readFile: (file) => { if (failRead) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return fs.readFileSync(file); },
    apply: (options) => { if (failApply-- > 0) throw new Error("apply failed"); applied.push(options); },
  });
  fs.writeFileSync(pair.cert, B[pair.cert]);
  fs.writeFileSync(pair.key, B[pair.key]);
  failRead = true;
  assert.equal(reloader.check(), false, "an unreadable pair changes nothing");
  failRead = false;
  assert.equal(reloader.check(), false, "an apply that throws is not recorded as applied");
  assert.equal(applied.length, 0);
  assert.equal(reloader.check(), true, "the same renewal is retried and applied");
  assert.equal(applied[0].cert.toString(), B[pair.cert].toString());
});

test("a symlinked certificate path is followed: replacing its target is a change", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const dir = createOwnedTempDir("host-auth-tls-link");
  const target = fixturePair(dir, "a");
  const cert = path.join(dir, "live.crt"), key = path.join(dir, "live.key");
  fs.symlinkSync(target.cert, cert);
  fs.symlinkSync(target.key, key);
  const applied = [];
  const reloader = createTlsReloader({ certPath: cert, keyPath: key, apply: (options) => applied.push(options), log: () => {} });
  assert.equal(reloader.check(), false);
  // A renewal that rewrites the targets in place (the links themselves never change).
  fs.writeFileSync(target.cert, fs.readFileSync(new URL("b.crt", FIXTURES)));
  fs.writeFileSync(target.key, fs.readFileSync(new URL("b.key", FIXTURES)));
  assert.equal(reloader.check(), true);
  assert.equal(applied.length, 1);
});

test("the TLS reloader swaps a changed certificate pair and keeps the old one on a bad write", () => {
  const dir = createOwnedTempDir("host-auth-tls");
  const first = fixturePair(dir, "a");
  const second = { key: fileURLToPath(new URL("b.key", FIXTURES)), cert: fileURLToPath(new URL("b.crt", FIXTURES)) };
  const applied = [];
  const reloader = createTlsReloader({ certPath: first.cert, keyPath: first.key, apply: (options) => applied.push(options), log: () => {} });
  assert.equal(reloader.check(), false, "unchanged files do nothing");
  // A half-written renewal: new cert, old key — refused, retried later.
  fs.copyFileSync(second.cert, first.cert);
  assert.equal(reloader.check(), false);
  assert.equal(applied.length, 0);
  fs.copyFileSync(second.key, first.key);
  assert.equal(reloader.check(), true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].cert.toString(), fs.readFileSync(second.cert, "utf8"));
  assert.equal(reloader.check(), false);
  reloader.start();
  reloader.stop();
});
