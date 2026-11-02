import {pruneJoinAttempts} from '../shared/runtime-bounds.js';
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { loadUiState, publicSnapshot } from "../server/server.js";
import { ensureStudyService } from "./study-service.js";
import { createRoomManager } from "./room-manager.js";
import { createSessionSummaryCache } from "./session-summary.js";
import { RelayDenied } from "./relay-access.js";
import { readHud, readReport, readReveal } from "./host-insights.js";
import { rankPlayers } from "../server/public/final-summary.js";
import { HOST_ID } from "../shared/seat-roles.js";
import { statExact } from "../shared/exact-stat.js";
import { SPECTATOR_ID, viewerRole } from "../shared/viewer-access.js";
import tlsModule from "node:tls";
import net from "node:net";
import {
  createRemoteHostAuth,
  createTlsReloader,
  readHostCredential,
  tlsContentIdentity,
} from "./host-auth.js";
const PUBLIC = fileURLToPath(new URL("../server/public/", import.meta.url));
const SHARED = fileURLToPath(new URL("../shared/", import.meta.url));
const json = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function bodyOf(req) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384)
      throw Object.assign(new Error(), { code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw Object.assign(new Error(), { code: "BAD_JSON" });
  }
}
// #270: every proxied request opens its own connection (agent:false), so a verified listener
// can never be reached through a pooled socket bound to an older relay on the same port, and
// node:http follows no redirect, so the session token never leaves the verified address.
function openUpstream({ port, path: target, method, headers, body, signal, streaming }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, method, headers, agent: false, signal });
    request.once("response", resolve);
    request.on("error", () => reject(Object.assign(new Error(), { code: "APP_UNAVAILABLE" })));
    // Ordinary requests have a five-minute socket inactivity budget; SSE stays long-lived.
    if (!streaming) request.setTimeout(300_000, () => request.destroy());
    request.end(body ?? undefined);
  });
}
function joinLinks(port, code, { tls = false, publicHost = null } = {}) {
  const hosts = [];
  for (const rows of Object.values(os.networkInterfaces() ?? {})) {
    for (const row of rows ?? []) {
      if (row.internal || row.family !== "IPv4") continue;
      hosts.push(row.address);
    }
  }
  if (publicHost) hosts.push(publicHost);
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;
  const scheme = tls ? "https" : "http";
  return hosts.map((host) => `${scheme}://${host}:${port}/join?code=${display}`);
}
function usage(message) {
  throw Object.assign(new Error(message), { code: "USAGE" });
}
// Both listeners serve the same table bundle. app.js imports ../../shared/*.js, so
// a listener that cannot serve shared/ leaves /table with static markup and no script.
const SHARED_ASSETS = [
  "reference.js",
  "reference-coverage.js",
  "preflop-key.js",
  "assistance.js",
  "deal-selection.js",
  "poker-eval.js",
  "decision-facts.js",
  "reference-coverage-v3.js",
  "game-setup.js",
  "pace.js",
  "player-budget.js",
];
const ASSET_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
// Font files are fixed, pinned binaries (see test/ui-assets.test.js); letting the
// browser keep them avoids re-downloading ~830 KB on every table/lobby load.
// Everything else stays no-store so a restarted service never serves stale code.
const cacheControlFor = (name) =>
  path.extname(name) === ".woff2" ? "public, max-age=86400" : "no-store";
// The login page exists only where a password may be typed: the HTTPS remote host listener. The
// participant listener (HTTP by default) serves neither it nor the host lobby page.
const REMOTE_ONLY_ASSETS = new Set(["login.html", "login.js"]);
const HOST_ONLY_PAGES = new Set(["lobby.html"]);
function serveAsset(res, rel, listener = "loopback") {
  const shared = rel.startsWith("shared/");
  const name = shared ? rel.slice(7) : rel;
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(name) ||
    name.startsWith(".") ||
    (shared && !SHARED_ASSETS.includes(name)) ||
    (!shared && listener !== "remote" && REMOTE_ONLY_ASSETS.has(name)) ||
    (!shared && listener === "participant" && HOST_ONLY_PAGES.has(name))
  ) {
    json(res, 404, { code: "NOT_FOUND" });
    return;
  }
  let content;
  try {
    const dir = shared ? SHARED : PUBLIC;
    // Exact names only: on a case-insensitive file system "/Login.html" would otherwise open
    // login.html past the per-listener checks above.
    if (!fs.readdirSync(dir).includes(name)) throw Object.assign(new Error(), { code: "ENOENT" });
    content = fs.readFileSync(path.join(dir, name));
  } catch {
    json(res, 404, { code: "NOT_FOUND" });
    return;
  }
  res.writeHead(200, {
    "content-type": ASSET_TYPES[path.extname(name)] ?? "application/octet-stream",
    "cache-control": cacheControlFor(name),
  });
  res.end(content);
}

const remoteFailure = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/**
 * The hostname a browser sends for this name — lower case, an IPv6 literal compressed and
 * bracketed, a numeric IPv4 spelling normalized — or null when it is not a DNS name or an IP.
 */
export function canonicalRemoteName(raw) {
  const text = String(raw ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  if (!text || !/^[A-Za-z0-9.:-]+$/.test(text)) return null;
  // A colon is only an IPv6 literal here, never a port ("1:2" would parse as host 0.0.0.1).
  if (text.includes(":") && !net.isIPv6(text)) return null;
  let hostname;
  try {
    hostname = new URL(`https://${net.isIPv6(text) ? `[${text}]` : text}/`).hostname;
  } catch {
    return null;
  }
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  return net.isIPv6(bare) || net.isIPv4(hostname) || HOSTNAME_RE.test(hostname) ? hostname : null;
}
/** The canonical Host value (URL.host: the default :443 dropped) of a header, or null. */
function canonicalHostHeader(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(text)) return null;
  try {
    return new URL(`https://${text}`).host;
  } catch {
    return null;
  }
}
/** Canonical Host values a browser sends for these (already canonical) names on this port. */
export function remoteHostForms(names, port) {
  const forms = new Set();
  for (const name of names) forms.add(new URL(`https://${name}:${port}`).host);
  return forms;
}
/**
 * Validate the remote host listener before any listener starts: HTTPS only, at least one name the
 * Host header must match, and a password credential already set for this store.
 */
export function prepareRemoteHost({ port, listen = null, names = [], tlsCert = null, tlsKey = null, appDir = null, authOptions = {}, requestTimeoutMs = 15_000, tlsReloadMs = 10 * 60 * 1000, sweepMs = 60_000 }, storeDir) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    remoteFailure("REMOTE_HOST_PORT_INVALID", "--remote-host-port는 0~65535 정수여야 합니다.");
  if (!Array.isArray(names) || names.length === 0)
    remoteFailure("REMOTE_HOST_NAME_REQUIRED", "--remote-host-name이 하나 이상 필요합니다.");
  const canonical = [];
  for (const raw of names) {
    const name = canonicalRemoteName(raw);
    if (!name) remoteFailure("REMOTE_HOST_NAME_INVALID", `원격 호스트 이름이 올바르지 않습니다: ${raw}`);
    // Pages tell the local lobby from a remote one by this exact hostname.
    if (name === "127.0.0.1")
      remoteFailure("REMOTE_HOST_NAME_INVALID", "127.0.0.1은 로컬 로비 주소라 원격 호스트 이름으로 쓸 수 없습니다.");
    if (!canonical.includes(name)) canonical.push(name);
  }
  // No default: binding every interface is a choice the operator makes explicitly.
  if (typeof listen !== "string" || listen.trim() === "")
    remoteFailure("REMOTE_HOST_LISTEN_REQUIRED", "--remote-host-listen 주소가 필요합니다(예: Tailscale IP).");
  if (!tlsCert || !tlsKey)
    remoteFailure("REMOTE_HOST_TLS_REQUIRED", "원격 호스트 리스너는 --remote-tls-cert와 --remote-tls-key가 필요합니다.");
  let tlsOptions, tlsIdentity;
  try {
    tlsOptions = { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) };
    tlsModule.createSecureContext(tlsOptions);
    tlsIdentity = tlsContentIdentity(tlsOptions.cert, tlsOptions.key);
  } catch {
    remoteFailure("REMOTE_HOST_TLS_INVALID", "원격 호스트 인증서·키를 읽지 못했거나 서로 맞지 않습니다.");
  }
  const dir = appDir ?? path.join(storeDir, ".app");
  if (!readHostCredential(dir))
    remoteFailure("HOST_PASSWORD_NOT_SET", "원격 호스트 비밀번호가 없습니다. 먼저 `node tools/app-service.js host-password <store>`를 실행하세요.");
  return { port, listen: listen.trim(), names: canonical, tlsCert, tlsKey, tlsOptions, tlsIdentity, appDir: dir, authOptions, requestTimeoutMs, tlsReloadMs, sweepMs };
}
// The remote host listener serves exactly these host routes; everything else is decided before
// authentication (participant and unknown routes 404, local-only ones refused), so a route added
// to the shared host API later is not reachable remotely until it is listed here.
const REMOTE_HOST_ROUTES = [
  /^\/api\/app$/,
  /^\/api\/room$/,
  /^\/api\/commands$/,
  /^\/api\/commands\/[^/]+$/,
  /^\/api\/app\/interrupt-decision$/,
  /^\/api\/game\/[0-9a-f-]{36}\/(summary|hud|report|reveal|skip-result|snapshot|events|action-status|training-detail|action)$/,
];
export function remoteRouteOf(pathname) {
  if (pathname === "/api/host/login") return "login";
  if (pathname === "/api/host/logout") return "logout";
  if (pathname === "/api/stop" || pathname === "/api/prefill") return "forbidden";
  if (pathname === "/api/study") return "study";
  return REMOTE_HOST_ROUTES.some((route) => route.test(pathname)) ? "host" : "not-found";
}
// Both sides are canonical URL.host values, so "name" and "name:443" compare equal.
function sameRemoteOrigin(originHeader, host) {
  try {
    const origin = new URL(originHeader);
    return origin.protocol === "https:" && origin.host === host;
  } catch {
    return false;
  }
}
export function remoteOrigin(name, port) {
  return new URL(`https://${name}:${port}`).origin;
}
function createSocketTracker(maxPerAddr, maxTotal) {
  const counts = new Map();
  let live = 0;
  return (socket) => {
    const addr = socket.remoteAddress ?? "unknown";
    const n = counts.get(addr) ?? 0;
    if (n >= maxPerAddr || live >= maxTotal) {
      socket.destroy();
      return false;
    }
    counts.set(addr, n + 1);
    live += 1;
    socket.on("close", () => {
      const left = (counts.get(addr) ?? 1) - 1;
      if (left <= 0) counts.delete(addr);
      else counts.set(addr, left);
      live = Math.max(0, live - 1);
    });
    return true;
  };
}

export async function startAppServer({
  manager,
  token,
  storeDir,
  port = 0,
  publicPort = null,
  publicListen = "0.0.0.0",
  publicHost = null,
  tlsCert = null,
  tlsKey = null,
  onStop = () => {},
  summaryCache = createSessionSummaryCache(),
  remoteHost = null,
  tlsReloadMs = 10 * 60 * 1000,
}) {
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    usage("--tls-cert와 --tls-key는 함께 필요합니다.");
  }
  const remote = remoteHost ? prepareRemoteHost(remoteHost, storeDir) : null;
  let origin;
  const room = manager.room ?? createRoomManager({ storeDir });
  // The session manager already recovered its bound roster with engine players.
  if (!manager.room) { try { room.recover({}); } catch { /* no room yet */ } }
  const tls = Boolean(tlsCert && tlsKey);
  const tlsOptions = tls
    ? { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }
    : null;
  // Check the participant pair before any listener opens: creating the HTTPS server later would
  // throw after the loopback listener is already up.
  if (tls) {
    try {
      tlsModule.createSecureContext(tlsOptions);
    } catch {
      usage("--tls-cert와 --tls-key를 읽지 못했거나 서로 맞지 않습니다.");
    }
  }
  const connections = new Map();
  const addrCounts = new Map();
  const sseByParticipant = new Map();
  const joinAttempts = new Map();
  let liveConnections = 0;
  const MAX_PER_ADDR = 32;
  const MAX_TOTAL = 128;
  const MAX_SSE = 4;
  function trackSocket(socket) {
    const addr = socket.remoteAddress ?? "unknown";
    const n = addrCounts.get(addr) ?? 0;
    if (n >= MAX_PER_ADDR || liveConnections >= MAX_TOTAL) {
      socket.destroy();
      return false;
    }
    addrCounts.set(addr, n + 1);
    liveConnections += 1;
    socket.on("close", () => {
      const left = (addrCounts.get(addr) ?? 1) - 1;
      if (left <= 0) addrCounts.delete(addr);
      else addrCounts.set(addr, left);
      liveConnections = Math.max(0, liveConnections - 1);
    });
    return true;
  }
  function attachResponse(participantId, res, { sse = false } = {}) {
    if (!participantId) return true;
    const set = connections.get(participantId) ?? new Set();
    if (sse) {
      const open = sseByParticipant.get(participantId) ?? 0;
      if (open >= MAX_SSE) return false;
      sseByParticipant.set(participantId, open + 1);
    }
    set.add(res);
    connections.set(participantId, set);
    const drop = () => {
      set.delete(res);
      if (sse) {
        const open = (sseByParticipant.get(participantId) ?? 1) - 1;
        if (open <= 0) sseByParticipant.delete(participantId);
        else sseByParticipant.set(participantId, open);
      }
    };
    res.on("close", drop);
    res.on("finish", drop);
    return true;
  }
  function revokeParticipant(participantId) {
    const set = connections.get(participantId);
    if (!set) return;
    for (const res of set) {
      try { res.destroy(); } catch { /* already closed */ }
    }
    connections.delete(participantId);
    sseByParticipant.delete(participantId);
  }
  room.addRevokeListener?.((event) => revokeParticipant(event.participantId));
  const summaries = summaryCache;
  const summaryRequests = new Map();
  const summaryStates = new Set(['finalizing','completed','ended']);
  let summaryGameId = manager.current?.gameId;
  const summaryInput = () => ({gameId:manager.current.gameId,sessionDir:manager.current.sessionDir});
  function stateChanged(snapshot) {
    if (summaryGameId !== snapshot.gameId) {
      summaries.clear(); summaryRequests.clear(); summaryGameId=snapshot.gameId;
    }
    if (summaryStates.has(snapshot.state) && manager.current?.gameId===snapshot.gameId) {
      void summaries.get(summaryInput()).catch(()=>{});
    }
  }
  async function serveSummary(req,res,gameId,authenticate=null) {
    if (req.method !== 'GET') {json(res,405,{code:'METHOD_NOT_ALLOWED'});return;}
    const snapshot=manager.snapshot();
    if(manager.current?.gameId!==gameId || req.headers['x-game-epoch']!==snapshot.gameEpoch) {
      json(res,409,{code:'STALE_GAME'});return;
    }
    if(!summaryStates.has(snapshot.state)){json(res,409,{code:'SESSION_ACTIVE'});return;}
    if(authenticate) {
      const key=req.headers.authorization,now=Date.now();
      for(const [value,time] of summaryRequests)if(now-time>=2000)summaryRequests.delete(value);
      if(summaryRequests.has(key)){json(res,429,{code:'RATE_LIMIT'});return;}
      summaryRequests.set(key,now);
    }
    try {
      const summary=await summaries.get(summaryInput());
      // A cold build yields. Recheck room credentials and game identity before disclosure.
      if(authenticate)authenticate();
      const latest=manager.snapshot();
      if(manager.current?.gameId!==gameId || latest.gameEpoch!==snapshot.gameEpoch || !summaryStates.has(latest.state)) {
        json(res,409,{code:'STALE_GAME'});return;
      }
      json(res,200,summary);
    } catch(error){const code=['UNAUTHORIZED','NOT_SEATED'].includes(error.code)?error.code:'SUMMARY_UNAVAILABLE';json(res,code==='UNAUTHORIZED'?401:code==='NOT_SEATED'?409:503,{code});}
  }
  // Host-only learning aids (hud, report, reveal): the current game and epoch
  // only, a closed projection, and no participant or spectator route.
  const insightCache = new Map();
  async function serveInsight(req,res,gameId,kind) {
    if (req.method !== 'GET') {json(res,405,{code:'METHOD_NOT_ALLOWED'});return;}
    const snapshot=manager.snapshot(),current=manager.current;
    if(current?.gameId!==gameId || req.headers['x-game-epoch']!==snapshot.gameEpoch) {json(res,409,{code:'STALE_GAME'});return;}
    try {
      let body;
      if(kind==='reveal') {
        let phase=null;
        try {phase=readCommitFile('loop-state.json').phase;} catch {committedCache.clear();}
        body=readReveal(current.sessionDir,phase);
      } else {
        // One build per committed state file; the report reads every archived hand. The identity is
        // exact (#308): a Number-valued ino past 2^53 (Windows) can match a replacement.
        const stat=statExact(path.join(current.sessionDir,'state.json'));
        const key=JSON.stringify([kind,gameId,String(stat.dev),String(stat.ino),stat.size,stat.mtimeMs,stat.ctimeMs]);
        body=insightCache.get(kind)?.key===key?insightCache.get(kind).body:null;
        if(!body){body=kind==='hud'?readHud(current.sessionDir):readReport(current.sessionDir);insightCache.set(kind,{key,body});}
      }
      const latest=manager.snapshot();
      if(manager.current?.gameId!==gameId || latest.gameEpoch!==snapshot.gameEpoch) {json(res,409,{code:'STALE_GAME'});return;}
      json(res,200,body);
    } catch(error) {
      json(res,error.code==='REVEAL_NOT_READY'?409:503,{code:error.code==='REVEAL_NOT_READY'?'REVEAL_NOT_READY':'INSIGHT_UNAVAILABLE'});
    }
  }
  const committedCache = new Map();
  const readCommitFile = name => {
    const file = path.join(manager.current.sessionDir, name);
    // Exact identity (#308): the committed view decides role changes and token revocation.
    const stat = statExact(file);
    const key = JSON.stringify([file,String(stat.dev),String(stat.ino),stat.size,stat.mtimeMs,stat.ctimeMs]);
    if (committedCache.get(name)?.key === key) return committedCache.get(name).data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    committedCache.set(name,{key,data});
    return data;
  };
  const committedView = () => {
    try {
      const raw = readCommitFile('ui-snapshot.json');
      const loop = readCommitFile('loop-state.json');
      // The UI file precedes receipt reconciliation. Only the loop's successful
      // publish acknowledgement authorizes role changes and token revocation.
      const viewPublishId = raw.projectionAnchor?.publishId;
      if (!Number.isSafeInteger(viewPublishId) || viewPublishId < 1 || viewPublishId > raw.publishId
        || !Number.isSafeInteger(loop.lastPublishId) || loop.lastPublishId < viewPublishId) return null;
      return raw.view ?? null;
    } catch { committedCache.clear(); return null; }
  };
  function rateLimitJoin(addr) {
    const now = Date.now();
    const row = joinAttempts.get(addr) ?? { count: 0, start: now };
    if (now - row.start > 60_000) {
      row.count = 0;
      row.start = now;
    }
    row.count += 1;
    joinAttempts.set(addr, row);
    pruneJoinAttempts(joinAttempts, now);
    return row.count > 10;
  }
  async function proxyGame({ req, res, url, gameId, endpoint, seat, recheck = null, remote = false }) {
    const expectedMethod = endpoint === "action" ? "POST" : "GET";
    if (req.method !== expectedMethod) {
      json(res, 405, { code: "METHOD_NOT_ALLOWED" });
      return;
    }
    const current = manager.current,
      snapshot = manager.snapshot();
    if (
      current?.gameId !== gameId ||
      req.headers["x-game-epoch"] !== snapshot.gameEpoch
    ) {
      json(res, 409, { code: "STALE_GAME" });
      return;
    }
    for (const key of url.searchParams.keys())
      if (!["after", "ref"].includes(key)) {
        json(res, 400, { code: "BAD_QUERY" });
        return;
      }
    // #235: while pausing/paused the relay's action gate decides, so a refusal can
    // carry durable per-request cancellation proof. Other non-playing states keep
    // the unproven refusal: a retry after recovery there is legitimate.
    if (
      endpoint === "action" &&
      snapshot.state !== "playing" &&
      !(["pausing", "paused"].includes(snapshot.state) && manager.session)
    ) {
      json(res, 409, { code: "GAME_PAUSED" });
      return;
    }
    if (!manager.session) {
      if (
        endpoint === "snapshot" &&
        ["ended", "completed"].includes(snapshot.state)
      ) {
        const engine = JSON.parse(
          fs.readFileSync(path.join(current.sessionDir, "state.json")),
        );
        json(
          res,
          200,
          publicSnapshot(
            loadUiState(current.sessionDir, engine.sessionToken),
            seat === HOST_ID ? null : null,
            seat,
          ),
        );
        return;
      }
      const terminal=["ended","completed"].includes(snapshot.state);
      json(res, terminal?409:503, { code: terminal?"SESSION_INACTIVE":"SESSION_UNAVAILABLE" });
      return;
    }
    // #270: the relay is never addressed from lock.json alone. The loop's capability pins its
    // verified relay in this same tick (before any body wait); `use` re-proves it afterwards
    // and runs `send` in the same synchronous step as the last check.
    const session = manager.session,
      loop = session.loop,
      sessionDir = current.sessionDir,
      selectionVersion = current.selectionVersion;
    if (typeof loop?.captureRelayAccess !== "function") {
      json(res, 503, { code: "RELAY_UNAVAILABLE" });
      return;
    }
    const capability = loop.captureRelayAccess();
    const query = new URLSearchParams(url.searchParams);
    query.delete("seat");
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const headers = { "x-seat": seat };
    let body = null;
    if (req.method === "POST") {
      const parsed = await bodyOf(req);
      if ("token" in parsed)
        throw Object.assign(new Error(), { code: "BAD_COMMAND" });
      const payload = { ...parsed };
      delete payload.seat;
      if (seat !== HOST_ID) delete payload.note;
      body = JSON.stringify(payload);
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const revalidate = () => {
      const latest = manager.snapshot();
      if (
        manager.current?.gameId !== gameId ||
        manager.current?.sessionDir !== sessionDir ||
        manager.current?.selectionVersion !== selectionVersion ||
        latest.gameEpoch !== snapshot.gameEpoch
      )
        throw new RelayDenied("STALE_GAME", "STALE");
      // A failure reconciliation can replace these objects while keeping the selected
      // game/epoch. Refuse this request, but let the transport retry the same game.
      if (res.destroyed || manager.current !== current || manager.session !== session || session.loop !== loop)
        throw new RelayDenied("RELAY_UNAVAILABLE", "CHANGED");
      if (
        endpoint === "action" &&
        latest.state !== "playing" &&
        !(["pausing", "paused"].includes(latest.state))
      )
        throw new RelayDenied("GAME_PAUSED", "STALE");
      recheck?.();
    };
    let access = null;
    let upstream;
    try {
      upstream = await capability.use(
        { gameEpoch: snapshot.gameEpoch, revalidate },
        (granted) => {
          access = granted;
          query.set("token", granted.sessionToken);
          headers["x-session-token"] = granted.sessionToken;
          return openUpstream({
            port: granted.port,
            path: `/api/${endpoint}?${query}`,
            method: req.method,
            headers,
            body,
            signal: controller.signal,
            streaming: endpoint === "events",
          });
        },
      );
    } catch (error) {
      if (!(error instanceof RelayDenied)) throw error;
      if (res.destroyed) return;
      json(res, ["STALE_GAME", "GAME_PAUSED"].includes(error.code) ? 409 : 503, { code: error.code });
      return;
    }
    res.writeHead(upstream.statusCode, {
      "content-type": upstream.headers["content-type"] ?? "application/json",
      "cache-control": "no-store",
    });
    if (remote && endpoint === "snapshot") {
      // The study service is loopback-only: its capability link never leaves for a remote device.
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          controller.abort();
          res.destroy();
          return;
        }
        chunks.push(chunk);
      }
      if (current.gameId !== manager.current?.gameId || !access.stillBound()) {
        controller.abort();
        res.end();
        return;
      }
      let text = Buffer.concat(chunks).toString("utf8");
      try {
        const value = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "studyUrl")) {
          delete value.studyUrl;
          text = JSON.stringify(value);
        }
      } catch {
        /* not JSON: nothing to strip */
      }
      res.end(text);
      return;
    }
    for await (const chunk of upstream) {
      if (current.gameId !== manager.current?.gameId || !access.stillBound()) {
        controller.abort();
        break;
      }
      if (!res.write(chunk))
        await new Promise((resolve, reject) => {
          const done = () => {
            cleanup();
            resolve();
          };
          const closed = () => {
            cleanup();
            reject(new Error("CLIENT_CLOSED"));
          };
          const cleanup = () => {
            res.off("drain", done);
            res.off("close", closed);
            res.off("error", closed);
          };
          res.once("drain", done);
          res.once("close", closed);
          res.once("error", closed);
          if (res.destroyed) closed();
        });
    }
    res.end();
  }
  // Everything a host may do once authenticated. The loopback listener authenticates with the
  // per-start service token, the remote host listener with a password session (tools/host-auth.js);
  // neither accepts the other's credential.
  async function hostApi(req, res, url, pathname, { remote = false } = {}) {
    if (req.method === "GET" && pathname === "/api/app") {
      const view = manager.snapshot();
      const host = room.hostView();
      const publishedPort = publicPort == null
        ? null
        : publicServer?.address()?.port ?? publicPort;
      json(res, 200, {
        ...view,
        viewerRole: viewerRole(committedView(), HOST_ID),
        room: host
          ? {
              ...host,
              tls,
              links: host.joinCode && publishedPort != null
                ? joinLinks(publishedPort, room.load().joinCode, { tls, publicHost })
                : [],
            }
          : null,
      });
      return;
    }
    if (req.method === "POST" && pathname === "/api/room") {
      const body = await bodyOf(req);
      const op = body?.op;
      if (op === "open") json(res, 200, room.open(body));
      else if (op === "update") json(res, 200, room.update(body));
      else if (op === "rotate-code") json(res, 200, { joinCode: room.rotateCode() });
      else if (op === "reissue") json(res, 200, room.reissue(body.participantId));
      else if (op === "remove") { room.remove(body.participantId); json(res, 200, { ok: true }); }
      else if (op === "close") json(res, 200, room.close());
      else json(res, 400, { code: "BAD_COMMAND" });
      return;
    }
    if (req.method === "POST" && pathname === "/api/commands") {
      const result = manager.command(await bodyOf(req));
      json(
        res,
        result.status === "accepted" ? 202 : 200,
        publicReceipt(result),
      );
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/api/commands/")) {
      json(res, 200, publicReceipt(manager.receipt(pathname.slice(14))));
      return;
    }
    if (req.method === "POST" && pathname === "/api/prefill") {
      manager.setPrefill(await bodyOf(req));
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && pathname === "/api/study") {
      const service = await ensureStudyService(storeDir);
      json(res, 200, { url: service.studyUrl });
      return;
    }
    if (req.method === "POST" && pathname === "/api/stop") {
      json(res, 202, { ok: true });
      setImmediate(onStop);
      return;
    }
    const summaryMatch=/^\/api\/game\/([0-9a-f-]{36})\/summary$/.exec(pathname);
    if(summaryMatch){await serveSummary(req,res,summaryMatch[1]);return;}
    const insightMatch=/^\/api\/game\/([0-9a-f-]{36})\/(hud|report|reveal)$/.exec(pathname);
    if(insightMatch){await serveInsight(req,res,insightMatch[1],insightMatch[2]);return;}
    if(pathname==='/api/app/interrupt-decision') {
      if(req.method!=='POST'){json(res,405,{code:'METHOD_NOT_ALLOWED'});return;}
      const body=await bodyOf(req);
      if(!body || Array.isArray(body) || Object.keys(body).length!==4 ||
        !['expectedGameId','gameEpoch','decisionId','generation'].every(key=>Object.hasOwn(body,key)) ||
        typeof body.expectedGameId!=='string' || typeof body.gameEpoch!=='string' ||
        typeof body.decisionId!=='string' || !body.decisionId || !Number.isSafeInteger(body.generation) || body.generation<1) {
        json(res,400,{code:'BAD_COMMAND'});return;
      }
      const snapshot=manager.snapshot();
      if(manager.current?.gameId!==body.expectedGameId || snapshot.gameEpoch!==body.gameEpoch || !manager.session) {
        json(res,409,{code:'STALE_GAME'});return;
      }
      const {gameEpoch,decisionId,generation}=body;
      json(res,200,await manager.session.loop.interruptDecision({gameEpoch,decisionId,generation}));return;
    }
    const skipMatch = /^\/api\/game\/([0-9a-f-]{36})\/skip-result$/.exec(pathname);
    if (skipMatch) {
      if (req.method !== "POST") { json(res, 405, {code:"METHOD_NOT_ALLOWED"}); return; }
      const snapshot = manager.snapshot();
      if (manager.current?.gameId !== skipMatch[1] ||
          req.headers["x-game-epoch"] !== snapshot.gameEpoch || !manager.session) {
        json(res, 409, {code:"STALE_GAME"}); return;
      }
      const body = await bodyOf(req);
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !Number.isSafeInteger(body.handNo) || body.handNo < 1) {
        json(res, 400, {code:"BAD_COMMAND"}); return;
      }
      json(res, 200, manager.session.loop.skipHandResult(body.handNo));
      return;
    }
    const match =
      /^\/api\/game\/([0-9a-f-]{36})\/(snapshot|events|action-status|training-detail|action)$/.exec(
        pathname,
      );
    if (!match) {
      json(res, 404, { code: "NOT_FOUND" });
      return;
    }
    const [, gameId, endpoint] = match;
    await proxyGame({ req, res, url, gameId, endpoint, seat: HOST_ID, remote });
  }
  function hostError(res, error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const code = error.code ?? "APP_UNAVAILABLE";
    json(
      res,
      code === "ENOENT"
        ? 404
        : code === "PAYLOAD_TOO_LARGE"
          ? 413
          : [
                "BAD_JSON",
                "BAD_COMMAND",
                "INVALID_SETUP",
                "BAD_QUERY",
              ].includes(code)
            ? 400
            : 409,
      { code },
    );
  }
  function hostSecurityHeaders(res) {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    );
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        json(res, 403, { code: "BAD_ORIGIN" });
        return;
      }
      const url = new URL(req.url, origin),
        pathname = url.pathname;
      hostSecurityHeaders(res);
      if (pathname === "/api/join" || pathname.startsWith("/api/p/")) {
        json(res, 404, { code: "NOT_FOUND" });
        return;
      }
      if (!pathname.startsWith("/api/")) {
        if (req.method !== "GET") {
          json(res, 405, { code: "METHOD_NOT_ALLOWED" });
          return;
        }
        const rel =
          pathname === "/"
            ? "lobby.html"
            : pathname === "/table"
              ? "index.html"
              : pathname === "/join"
                ? "join.html"
              : pathname.slice(1);
        serveAsset(res, rel);
        return;
      }
      if (!equal(req.headers.authorization, `Bearer ${token}`)) {
        json(res, 401, { code: "UNAUTHORIZED" });
        return;
      }
      await hostApi(req, res, url, pathname);
    } catch (error) {
      hostError(res, error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const publicHandler = async (req, res) => {
    try {
      const expectedScheme = tls ? "https:" : "http:";
      if (req.headers.origin) {
        const originUrl = new URL(req.headers.origin);
        if (originUrl.host !== req.headers.host || originUrl.protocol !== expectedScheme) {
          json(res, 403, { code: "BAD_ORIGIN" });
          return;
        }
      }
      const url = new URL(req.url, `${expectedScheme}//${req.headers.host}`),
        pathname = url.pathname;
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (pathname === "/api/join" && req.method === "POST") {
        const body = await bodyOf(req);
        const addr = req.socket.remoteAddress;
        if (rateLimitJoin(addr)) {
          json(res, 429, { code: "RATE_LIMIT" });
          return;
        }
        try {
          const game = manager.snapshot();
          if (committedView()?.gameOver && room.load()?.status === 'locked') game.state = 'finalizing';
          json(res, 200, room.join({ code: body.code, name: body.name, addr, game }));
        } catch (error) {
          const code = error.code ?? "BAD_CODE";
          if (code === "BAD_CODE") await new Promise((r) => setTimeout(r, 250));
          json(res, code === "BAD_CODE" ? 401 : code === "ROOM_NOT_FOUND" ? 404 : code === "RATE_LIMIT" ? 429 : 409, { code });
        }
        return;
      }
      const participantAuth = () => {
        const header = req.headers.authorization ?? "";
        const tokenValue = header.startsWith("Bearer ") ? header.slice(7) : "";
        return room.authenticate(tokenValue);
      };
      if (pathname === "/api/p/state" && req.method === "GET") {
        try {
          const me = participantAuth();
          room.touch(me.participantId);
          attachResponse(me.participantId, res);
          const snap = manager.snapshot();
          let final;
          if (["ended", "completed"].includes(snap.state) && manager.current) {
            try {
              const engine = JSON.parse(
                fs.readFileSync(path.join(manager.current.sessionDir, "state.json")),
              );
              const ranking=rankPlayers({summary:summaries.peek(snap.gameId),view:{seats:engine.seats,mode:engine.config?.mode,sessionNet:engine.sessionNet}});
              const byId=new Map(ranking.map(row=>[row.playerId,row]));
              final = {
                stacks: (engine.seats ?? []).map((seat) => ({
                  playerId: seat.playerId,
                  name: seat.name,
                  stack: seat.stack,
                  out: seat.out === true,
                  ...(Number.isSafeInteger(byId.get(seat.playerId)?.net)?{net:byId.get(seat.playerId).net,rank:byId.get(seat.playerId).rank}:{}),
                })),
                result: engine.result ?? null,
                winnerId: engine.winnerId ?? null,
                // Additive: lets the join page format amounts like the host
                // (cash in the fixed big blind, tournaments in chips).
                mode: engine.config?.mode ?? null,
                bigBlind: engine.config?.mode === 'cash-training' && Number.isSafeInteger(engine.config?.blinds0?.[1]) ? engine.config.blinds0[1] : null,
              };
            } catch {
              final = null;
            }
          }
          json(res, 200, {
            room: room.participantView(me.participantId),
            me: { participantId: me.participantId, name: me.name, playerId: me.playerId,
              roomRole:me.roomRole, viewerGeneration:me.viewerGeneration,
              viewerRole:viewerRole(committedView(), me.roomRole === 'spectator' ? SPECTATOR_ID : me.playerId) },
            game: {
              aiProvider: snap.setup?.opponentRuntime ?? null,
              gameId: snap.gameId,
              gameEpoch: snap.gameEpoch,
              state: snap.state === "lobby" ? "lobby" : snap.state,
              ...(final ? { final } : {}),
            },
          });
        } catch (error) {
          json(res, error.code === "UNAUTHORIZED" ? 401 : 404, { code: error.code ?? "UNAUTHORIZED" });
        }
        return;
      }
      if (pathname === '/api/p/seat-request' && req.method === 'POST') {
        try {
          participantAuth();
          const body = await bodyOf(req);
          // Body streaming yields to token reissue/removal. Recheck credentials
          // immediately before the synchronous capacity/role mutation.
          const me = participantAuth();
          if (manager.snapshot().pendingRequestId) throw Object.assign(new Error(), {code:'ROOM_LOCKED'});
          // Synchronous room mutation serializes against start/other admissions.
          const state = room.requestSeat(me.participantId, body);
          json(res, 200, state);
        } catch (error) {
          json(res, error.code === 'UNAUTHORIZED' ? 401 : 409, {code:error.code ?? 'BAD_COMMAND'});
        }
        return;
      }
      if (pathname === "/api/p/leave" && req.method === "POST") {
        try {
          const me = participantAuth();
          if (room.load()?.status === 'locked' && me.roomRole === 'seated'
            && me.boundGameId === manager.current?.gameId
            && committedView()?.seats?.some(row => row.playerId === me.playerId && row.out === true)) {
            room.leaveEliminated(me.participantId);
          } else room.remove(me.participantId);
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, error.code === "UNAUTHORIZED" ? 401 : error.code === "ROOM_LOCKED" ? 409 : 404, { code: error.code ?? "UNAUTHORIZED" });
        }
        return;
      }
      const publicSummary=/^\/api\/p\/game\/([0-9a-f-]{36})\/summary$/.exec(pathname);
      if(publicSummary) {
        const authenticate=()=>{
          const me=participantAuth();
          if(me.roomRole!=='spectator' && (!me.playerId || me.boundGameId!==manager.current?.gameId))throw Object.assign(new Error(),{code:'NOT_SEATED'});
          return me;
        };
        try {const me=authenticate();room.touch(me.participantId);attachResponse(me.participantId,res);}
        catch(error){json(res,error.code==='UNAUTHORIZED'?401:409,{code:error.code??'UNAUTHORIZED'});return;}
        await serveSummary(req,res,publicSummary[1],authenticate);return;
      }
      const pMatch =
        /^\/api\/p\/game\/([0-9a-f-]{36})\/(snapshot|events|action-status|action)$/.exec(
          pathname,
        );
      if (pMatch) {
        let me;
        try {
          me = participantAuth();
        } catch (error) {
          json(res, 401, { code: error.code ?? "UNAUTHORIZED" });
          return;
        }
        room.touch(me.participantId);
        const spectator = me.roomRole === 'spectator';
        if (!spectator && (!me.playerId || me.boundGameId !== manager.current?.gameId)) {
          json(res, 409, { code: "NOT_SEATED" });
          return;
        }
        if (spectator && ['action','action-status'].includes(pMatch[2])) {
          json(res, 403, {code:'SPECTATOR_READ_ONLY'}); return;
        }
        const sse = pMatch[2] === "events";
        if (!attachResponse(me.participantId, res, { sse })) {
          json(res, 429, { code: "RATE_LIMIT" });
          return;
        }
        await proxyGame({
          req,
          res,
          url,
          gameId: pMatch[1],
          endpoint: pMatch[2],
          seat: spectator ? SPECTATOR_ID : me.playerId,
          // The seat or credential may change while a body or an OS check is pending.
          recheck: () => {
            let now;
            try { now = participantAuth(); } catch { throw new RelayDenied("STALE_GAME", "STALE"); }
            if (
              now.participantId !== me.participantId ||
              now.playerId !== me.playerId ||
              now.roomRole !== me.roomRole ||
              now.boundGameId !== me.boundGameId ||
              (!spectator && now.boundGameId !== manager.current?.gameId)
            )
              throw new RelayDenied("STALE_GAME", "STALE");
          },
        });
        return;
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/.app/")) {
        json(res, 404, { code: "NOT_FOUND" });
        return;
      }
      if (req.method !== "GET") {
        json(res, 405, { code: "METHOD_NOT_ALLOWED" });
        return;
      }
      const rel = pathname === "/join" ? "join.html" : pathname === "/table" ? "index.html" : pathname.slice(1);
      serveAsset(res, rel, "participant");
    } catch (error) {
      if (!res.headersSent) json(res, 400, { code: error.code ?? "BAD_JSON" });
    }
  };
  const publicServer = tls
    ? https.createServer(tlsOptions, publicHandler)
    : http.createServer(publicHandler);
  publicServer.maxConnections = MAX_TOTAL;
  publicServer.headersTimeout = 10_000;
  // Node's default requestTimeout would cut long-lived SSE proxies; match server/server.js.
  publicServer.timeout = 0;
  publicServer.requestTimeout = 0;
  publicServer.on("connection", (socket) => {
    if (!trackSocket(socket)) return;
  });
  // Everything after the loopback listener opens is one startup: if any later step fails, close
  // every listener and timer opened so far. The caller holds no handle yet, and an open listener
  // would keep a failed serve alive instead of exiting for launchd to retry.
  let remoteServer = null,
    remoteAuth = null,
    remoteSweep = null,
    remoteReloader = null,
    remoteHosts = new Set();
  let publicReloader = null;
  const closeAll = async () => {
    clearInterval(remoteSweep);
    remoteReloader?.stop();
    publicReloader?.stop();
    remoteAuth?.close();
    for (const listener of [remoteServer, publicServer, server]) {
      if (!listener?.listening) continue;
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  };
  // Remote host listener (opt-in): HTTPS, an allowlisted Host header, and a password session. It
  // serves the host lobby and table, never the participant routes, and refuses the service token.
  const remoteHandler = async (req, res) => {
    try {
      const host = canonicalHostHeader(req.headers.host);
      if (!host || !remoteHosts.has(host)) {
        json(res, 403, { code: "BAD_ORIGIN" });
        return;
      }
      const url = new URL(req.url, `https://${host}`),
        pathname = url.pathname;
      hostSecurityHeaders(res);
      if (!pathname.startsWith("/api/")) {
        if (req.method !== "GET") {
          json(res, 405, { code: "METHOD_NOT_ALLOWED" });
          return;
        }
        serveAsset(res, pathname === "/" ? "lobby.html" : pathname === "/table" ? "index.html" : pathname === "/login" ? "login.html" : pathname.slice(1), "remote");
        return;
      }
      // Navigations may arrive from anywhere; API calls only from this origin.
      if ((req.headers.origin && !sameRemoteOrigin(req.headers.origin, host))
        || req.headers["sec-fetch-site"] === "cross-site") {
        json(res, 403, { code: "BAD_ORIGIN" });
        return;
      }
      const route = remoteRouteOf(pathname);
      if (route === "not-found") {
        json(res, 404, { code: "NOT_FOUND" });
        return;
      }
      if (route === "forbidden") {
        json(res, 403, { code: "REMOTE_FORBIDDEN" });
        return;
      }
      if (route === "study") {
        json(res, 409, { code: "STUDY_LOCAL_ONLY" });
        return;
      }
      if (route === "login") {
        if (req.method !== "POST") {
          json(res, 405, { code: "METHOD_NOT_ALLOWED" });
          return;
        }
        const addr = req.socket.remoteAddress ?? "unknown";
        // A locked address is refused before its body is read (and checked again after).
        const locked = remoteAuth.lockout(addr);
        if (locked) {
          for (const [name, value] of Object.entries(locked.headers)) res.setHeader(name, value);
          json(res, locked.status, locked.body);
          return;
        }
        const body = await bodyOf(req);
        const result = await remoteAuth.login({ addr, body });
        for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
        json(res, result.status, result.body);
        return;
      }
      const session = remoteAuth.authenticate(req.headers.authorization);
      if (!session) {
        json(res, 401, { code: "UNAUTHORIZED" });
        return;
      }
      if (route === "logout") {
        if (req.method !== "POST") {
          json(res, 405, { code: "METHOD_NOT_ALLOWED" });
          return;
        }
        remoteAuth.logout(req.headers.authorization);
        json(res, 200, { ok: true });
        return;
      }
      // A logout, expiry or new password ends this request too (SSE included).
      remoteAuth.attach(session, res);
      await hostApi(req, res, url, pathname, { remote: true });
    } catch (error) {
      hostError(res, error);
    }
  };
  try {
    if (publicPort != null) {
      await new Promise((resolve, reject) => {
        publicServer.once("error", reject);
        publicServer.listen(publicPort, publicListen, resolve);
      });
      // A participant port on HTTPS picks up a renewed certificate the same way, without a restart.
      if (tls) {
        publicReloader = createTlsReloader({
          certPath: tlsCert,
          keyPath: tlsKey,
          intervalMs: tlsReloadMs,
          initialIdentity: tlsContentIdentity(tlsOptions.cert, tlsOptions.key),
          apply: (options) => publicServer.setSecureContext(options),
        });
        publicReloader.start();
      }
    }
    if (remote) {
      remoteAuth = createRemoteHostAuth({ appDir: remote.appDir, ...remote.authOptions });
      // requestTimeout bounds receiving a request (headers and body), never a long response such as
      // SSE: an unauthenticated client cannot hold a socket by never finishing its login body.
      remoteServer = https.createServer({
        ...remote.tlsOptions,
        handshakeTimeout: 10_000,
        requestTimeout: remote.requestTimeoutMs,
        headersTimeout: Math.min(10_000, remote.requestTimeoutMs),
        connectionsCheckingInterval: Math.min(1_000, remote.requestTimeoutMs),
      }, remoteHandler);
      remoteServer.maxConnections = 64;
      remoteServer.timeout = 0;
      const trackRemote = createSocketTracker(32, 64);
      remoteServer.on("connection", (socket) => {
        trackRemote(socket);
      });
      await new Promise((resolve, reject) => {
        remoteServer.once("error", reject);
        remoteServer.listen(remote.port, remote.listen, resolve);
      });
      remoteHosts = remoteHostForms(remote.names, remoteServer.address().port);
      remoteSweep = setInterval(() => remoteAuth.sweep(), remote.sweepMs);
      remoteSweep.unref?.();
      remoteReloader = createTlsReloader({
        certPath: remote.tlsCert,
        keyPath: remote.tlsKey,
        intervalMs: remote.tlsReloadMs,
        initialIdentity: remote.tlsIdentity,
        apply: (options) => remoteServer.setSecureContext(options),
      });
      remoteReloader.start();
    }
    stateChanged(manager.snapshot());
    return {
      stateChanged,
      server,
      origin,
      publicPort: publicPort == null ? null : publicServer.address()?.port ?? publicPort,
      publicOrigin: publicPort == null
        ? null
        : `${tls ? "https" : "http"}://127.0.0.1:${publicServer.address()?.port ?? publicPort}`,
      remoteHostPort: remoteServer ? remoteServer.address().port : null,
      remoteHostOrigins: remoteServer
        ? remote.names.map((name) => remoteOrigin(name, remoteServer.address().port))
        : [],
      close: closeAll,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
function publicReceipt(row) {
  return {
    requestId: row.requestId,
    status: row.status,
    error: row.error,
    result: row.result,
  };
}
