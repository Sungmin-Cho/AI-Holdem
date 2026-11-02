// Remote host login: one password credential per store, in-memory host sessions, and a login
// limiter. The remote host listener (tools/app-server.js) is the only consumer; the loopback host
// listener keeps its per-start service token and never accepts these sessions.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { readPrivateJson, writePrivateJson } from "./app-files.js";
import { isPrivatePath } from "../shared/platform-files.js";
import { lstatExact } from "../shared/exact-stat.js";

export const HOST_AUTH_FILE = "host-auth.json";
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const LOGIN_PASSWORD_MAX = 1024;
// One supported scrypt cost (OWASP's N=2^16, r=8, p=2: 64 MiB, ~0.2 s on an M-series Mac). The
// record keeps the numbers, but any other combination is refused: a tampered or foreign file can
// neither raise the work per login nor lower it.
const PARAMS = Object.freeze({ N: 2 ** 16, r: 8, p: 2 });
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const RECORD_KEYS = ["schemaVersion", "kdf", "N", "r", "p", "keyLength", "salt", "hash", "credentialId", "createdAt"];
const TOKEN_RE = /^[0-9a-f]{64}$/;

const coded = (code, message = code) => Object.assign(new Error(message), { code });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const codePoints = (text) => [...text].length;

export function normalizePassword(password) {
  if (typeof password !== "string") throw coded("PASSWORD_INVALID");
  return password.normalize("NFC");
}

/** The rule for setting a password (login accepts any 1..1024 string and lets the hash decide). */
export function checkNewPassword(password) {
  const value = normalizePassword(password);
  const length = codePoints(value);
  if (length < PASSWORD_MIN) throw coded("PASSWORD_TOO_SHORT", `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  if (length > PASSWORD_MAX) throw coded("PASSWORD_TOO_LONG", `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`);
  return value;
}

function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128·N·r (V) plus 128·r·p (B); the 32 MiB default is below 2^16·8.
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r + 128 * r * p + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password, { salt = randomBytes(SALT_BYTES), credentialId = randomUUID(), now = () => new Date() } = {}) {
  const value = checkNewPassword(password);
  const hash = await derive(value, salt, PARAMS);
  return {
    schemaVersion: 1,
    kdf: "scrypt",
    ...PARAMS,
    keyLength: KEY_LENGTH,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    credentialId,
    createdAt: now().toISOString(),
  };
}

const decode = (text, bytes) => {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const buffer = Buffer.from(text, "base64");
  return buffer.length === bytes && buffer.toString("base64") === text ? buffer : null;
};

/** Fail closed: anything but the exact shape this module writes is HOST_AUTH_INVALID. */
export function validateHostCredential(value) {
  const invalid = () => coded("HOST_AUTH_INVALID", "원격 호스트 자격 파일이 올바르지 않습니다.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.join() !== [...RECORD_KEYS].sort().join()) throw invalid();
  if (value.schemaVersion !== 1 || value.kdf !== "scrypt" || value.keyLength !== KEY_LENGTH) throw invalid();
  if (value.N !== PARAMS.N || value.r !== PARAMS.r || value.p !== PARAMS.p) throw invalid();
  if (!decode(value.salt, SALT_BYTES) || !decode(value.hash, KEY_LENGTH)) throw invalid();
  if (typeof value.credentialId !== "string" || !/^[0-9a-f-]{36}$/.test(value.credentialId)) throw invalid();
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw invalid();
  return value;
}

export async function verifyPassword(record, password) {
  validateHostCredential(record);
  const value = normalizePassword(password);
  const expected = Buffer.from(record.hash, "base64");
  const actual = await derive(value, Buffer.from(record.salt, "base64"), record);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const hostCredentialPath = (appDir) => path.join(appDir, HOST_AUTH_FILE);

export function writeHostCredential(appDir, record) {
  validateHostCredential(record);
  writePrivateJson(hostCredentialPath(appDir), record);
}

/** null when no credential was set; throws HOST_AUTH_INVALID for anything unsafe or malformed. */
export function readHostCredential(appDir, { privateCheck = isPrivatePath } = {}) {
  const file = hostCredentialPath(appDir);
  let st;
  try {
    st = lstatExact(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw coded("HOST_AUTH_INVALID");
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || !privateCheck(file))
    throw coded("HOST_AUTH_INVALID", "원격 호스트 자격 파일이 올바르지 않습니다.");
  let value;
  try {
    value = readPrivateJson(file, 4096);
  } catch {
    throw coded("HOST_AUTH_INVALID", "원격 호스트 자격 파일이 올바르지 않습니다.");
  }
  return validateHostCredential(value);
}

/**
 * The credential as of now. The file is re-read only when its identity or timestamps change, so a
 * password set while the service runs takes effect on the next request without a restart.
 */
export function createCredentialSource(appDir, { read = readHostCredential } = {}) {
  let cached = null;
  return {
    current() {
      let key;
      try {
        const st = lstatExact(hostCredentialPath(appDir));
        key = JSON.stringify([String(st.dev), String(st.ino), st.size, st.mtimeMs, st.ctimeMs]);
      } catch (error) {
        key = error.code === "ENOENT" ? "missing" : "unreadable";
      }
      if (cached?.key === key) return cached.value;
      let value;
      try {
        const record = read(appDir);
        value = record ? { state: "ok", record } : { state: "missing" };
      } catch {
        value = { state: "invalid" };
      }
      cached = { key, value };
      return value;
    },
  };
}

/**
 * In-memory host sessions. Only sha256(token) is kept. A session is bound to the credentialId it
 * was issued under, so a new password ends every older session.
 */
export function createHostSessions({ now = Date.now, idleMs = 2 * 60 * 60 * 1000, absoluteMs = 24 * 60 * 60 * 1000, max = 8 } = {}) {
  const sessions = new Map();
  const end = (key) => {
    const row = sessions.get(key);
    if (!row) return false;
    sessions.delete(key);
    for (const res of row.responses) {
      try { res.destroy(); } catch { /* already closed */ }
    }
    row.responses.clear();
    return true;
  };
  const live = (row, credentialId, at) =>
    row.credentialId === credentialId && at - row.lastSeen < idleMs && at - row.createdAt < absoluteMs;
  return {
    issue(credentialId) {
      const token = randomBytes(32).toString("hex");
      const at = now();
      while (sessions.size >= max) {
        let oldest = null;
        for (const [key, row] of sessions) if (!oldest || row.createdAt < oldest[1].createdAt) oldest = [key, row];
        end(oldest[0]);
      }
      sessions.set(sha256(token), { credentialId, createdAt: at, lastSeen: at, responses: new Set() });
      return { token, expiresAt: new Date(at + absoluteMs).toISOString(), idleTimeoutSec: Math.floor(idleMs / 1000) };
    },
    authenticate(token, credentialId) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
      const key = sha256(token);
      const row = sessions.get(key);
      if (!row) return null;
      const at = now();
      if (!live(row, credentialId, at)) {
        end(key);
        return null;
      }
      row.lastSeen = at;
      return { key };
    },
    attach(session, res) {
      const row = sessions.get(session?.key);
      if (!row) {
        res.destroy();
        return;
      }
      row.responses.add(res);
      const drop = () => row.responses.delete(res);
      res.once("close", drop);
      res.once("finish", drop);
    },
    revoke(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
      return end(sha256(token));
    },
    sweep(credentialId) {
      const at = now();
      for (const [key, row] of [...sessions]) if (!live(row, credentialId, at)) end(key);
    },
    clear() {
      for (const key of [...sessions.keys()]) end(key);
    },
    get size() {
      return sessions.size;
    },
  };
}

/** Fixed-window failure counting per address and across all addresses. */
export function createLoginLimiter({ now = Date.now, windowMs = 15 * 60 * 1000, perAddress = 5, global = 50, maxEntries = 1024 } = {}) {
  const rows = new Map();
  let all = { count: 0, start: now() };
  const fresh = (row, at) => (at - row.start >= windowMs ? { count: 0, start: at } : row);
  const retryAfter = (row, at) => Math.max(1, Math.ceil((row.start + windowMs - at) / 1000));
  const prune = (at) => {
    if (rows.size <= maxEntries) return;
    for (const [key, row] of rows) if (at - row.start >= windowMs) rows.delete(key);
  };
  return {
    check(addr) {
      const at = now();
      all = fresh(all, at);
      if (all.count >= global) return { ok: false, retryAfterSec: retryAfter(all, at), scope: "global" };
      const row = rows.get(addr);
      if (row) {
        const current = fresh(row, at);
        if (current !== row) rows.set(addr, current);
        if (current.count >= perAddress) return { ok: false, retryAfterSec: retryAfter(current, at), scope: "address" };
      }
      return { ok: true };
    },
    failure(addr) {
      const at = now();
      all = fresh(all, at);
      all.count += 1;
      const row = fresh(rows.get(addr) ?? { count: 0, start: at }, at);
      row.count += 1;
      rows.set(addr, row);
      prune(at);
    },
    success(addr) {
      rows.delete(addr);
    },
    get size() {
      return rows.size;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything the remote host listener needs for authentication. `login` returns
 * {status, body, headers}; `authenticate` returns a session handle or null.
 */
export function createRemoteHostAuth({
  appDir,
  now = Date.now,
  delay = sleep,
  failureDelayMs = 500,
  log = (line) => console.error(line),
  sessions = createHostSessions({ now }),
  limiter = createLoginLimiter({ now }),
  credentials = createCredentialSource(appDir),
} = {}) {
  let verifying = false;
  let knownId;
  // A new, removed or unreadable credential ends every session (and its open streams) at the
  // first request that sees it, not only the session making that request.
  const credentialId = () => {
    const current = credentials.current();
    const id = current.state === "ok" ? current.record.credentialId : null;
    if (id !== knownId) {
      if (id) sessions.sweep(id);
      else sessions.clear();
      knownId = id;
    }
    return id;
  };
  const lockout = (addr) => {
    const gate = limiter.check(addr);
    if (gate.ok) return null;
    log(`[remote-host] login locked addr=${addr} scope=${gate.scope}`);
    return { status: 429, body: { code: "LOGIN_RATE_LIMIT", retryAfterSec: gate.retryAfterSec }, headers: { "retry-after": String(gate.retryAfterSec) } };
  };
  return {
    /** The refusal for a locked address, or null — checked before a login body is read. */
    lockout,
    async login({ addr, body }) {
      const locked = lockout(addr);
      if (locked) return locked;
      if (verifying) return { status: 429, body: { code: "LOGIN_BUSY", retryAfterSec: 1 }, headers: { "retry-after": "1" } };
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
        || typeof body.password !== "string" || body.password.length < 1 || body.password.length > LOGIN_PASSWORD_MAX)
        return { status: 400, body: { code: "BAD_COMMAND" } };
      credentialId();
      const current = credentials.current();
      if (current.state !== "ok") {
        const code = current.state === "missing" ? "HOST_PASSWORD_NOT_SET" : "HOST_AUTH_INVALID";
        return { status: 503, body: { code } };
      }
      verifying = true;
      let ok = false;
      try {
        ok = await verifyPassword(current.record, body.password);
      } catch {
        ok = false;
      } finally {
        verifying = false;
      }
      if (!ok) {
        limiter.failure(addr);
        log(`[remote-host] login fail addr=${addr}`);
        await delay(failureDelayMs);
        return { status: 401, body: { code: "LOGIN_FAILED" } };
      }
      // The password may have changed while scrypt ran: never issue under a superseded credential.
      if (credentialId() !== current.record.credentialId) return { status: 409, body: { code: "LOGIN_RETRY" } };
      limiter.success(addr);
      log(`[remote-host] login ok addr=${addr}`);
      return { status: 200, body: sessions.issue(current.record.credentialId) };
    },
    authenticate(authorization) {
      const id = credentialId();
      if (!id) return null;
      const header = typeof authorization === "string" ? authorization : "";
      return header.startsWith("Bearer ") ? sessions.authenticate(header.slice(7), id) : null;
    },
    logout(authorization) {
      const header = typeof authorization === "string" ? authorization : "";
      return header.startsWith("Bearer ") ? sessions.revoke(header.slice(7)) : false;
    },
    attach(session, res) {
      sessions.attach(session, res);
    },
    sweep() {
      const id = credentialId();
      if (id) sessions.sweep(id);
    },
    close() {
      sessions.clear();
    },
    sessions,
    limiter,
  };
}

/**
 * Reload a TLS certificate pair when either file changes (e.g. `tailscale cert` renewal) without
 * restarting the service. A pair that does not load (a half-written renewal) keeps the old context
 * and is retried on the next check.
 */
/**
 * What a certificate pair is: a digest of its bytes. File metadata is not enough — a copy can keep
 * the source's size and modification time (Windows CopyFile does), and a symlinked path's own stat
 * says nothing of its target. Taken from the exact bytes a server loaded, it also leaves no window
 * between reading the files and recording what was read.
 */
export function tlsContentIdentity(cert, key) {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return `${digest(cert)}:${digest(key)}`;
}

export function createTlsReloader({ certPath, keyPath, apply, initialIdentity = null, intervalMs = 10 * 60 * 1000, readFile = fs.readFileSync, log = (line) => console.error(line) }) {
  // One read when both name the same file (a combined PEM): the pair always comes from one version.
  const read = () => {
    const cert = readFile(certPath);
    return { cert, key: keyPath === certPath ? cert : readFile(keyPath) };
  };
  // What the server actually started with: the digest of the bytes it loaded.
  let applied = initialIdentity;
  if (applied === null) {
    try {
      const options = read();
      applied = tlsContentIdentity(options.cert, options.key);
    } catch {
      applied = "";
    }
  }
  let timer = null;
  const check = () => {
    let options;
    try {
      options = read();
    } catch {
      return false;
    }
    const next = tlsContentIdentity(options.cert, options.key);
    if (next === applied) return false;
    try {
      tls.createSecureContext(options);
      apply(options);
      applied = next;
      log("[remote-host] tls certificate reloaded");
      return true;
    } catch {
      return false;
    }
  };
  return {
    check,
    start() {
      if (!timer) {
        timer = setInterval(check, intervalMs);
        timer.unref?.();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
