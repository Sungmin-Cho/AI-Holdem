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
import { HOST_ID } from "../shared/seat-roles.js";
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
  "game-setup.js",
  "player-budget.js",
];
const ASSET_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
function serveAsset(res, rel) {
  const shared = rel.startsWith("shared/");
  const name = shared ? rel.slice(7) : rel;
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(name) ||
    name.startsWith(".") ||
    (shared && !SHARED_ASSETS.includes(name))
  ) {
    json(res, 404, { code: "NOT_FOUND" });
    return;
  }
  let content;
  try {
    content = fs.readFileSync(path.join(shared ? SHARED : PUBLIC, name));
  } catch {
    json(res, 404, { code: "NOT_FOUND" });
    return;
  }
  res.writeHead(200, {
    "content-type": ASSET_TYPES[path.extname(name)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(content);
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
}) {
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    usage("--tls-cert와 --tls-key는 함께 필요합니다.");
  }
  let origin;
  const room = manager.room ?? createRoomManager({ storeDir });
  try { room.recover({}); } catch { /* no room yet */ }
  const tls = Boolean(tlsCert && tlsKey);
  const tlsOptions = tls
    ? { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }
    : null;
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
  function rateLimitJoin(addr) {
    const now = Date.now();
    const row = joinAttempts.get(addr) ?? { count: 0, start: now };
    if (now - row.start > 60_000) {
      row.count = 0;
      row.start = now;
    }
    row.count += 1;
    joinAttempts.set(addr, row);
    return row.count > 10;
  }
  async function proxyGame({ req, res, url, gameId, endpoint, seat }) {
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
    if (endpoint === "action" && snapshot.state !== "playing") {
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
      json(res, 409, { code: "SESSION_INACTIVE" });
      return;
    }
    const lock = JSON.parse(
      fs.readFileSync(path.join(current.sessionDir, "lock.json")),
    );
    const engine = JSON.parse(
      fs.readFileSync(path.join(current.sessionDir, "state.json")),
    );
    if (
      lock.serverPid !== manager.session.loop.serverPid ||
      lock.sessionToken !== engine.sessionToken ||
      lock.controlProtocolVersion !== 1
    )
      throw Object.assign(new Error(), { code: "RELAY_UNAVAILABLE" });
    const query = new URLSearchParams(url.searchParams);
    query.delete("seat");
    query.set("token", lock.sessionToken);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const options = {
      method: req.method,
      signal: controller.signal,
      headers: {
        "x-session-token": lock.sessionToken,
        "x-seat": seat,
      },
    };
    if (req.method === "POST") {
      const body = await bodyOf(req);
      if ("token" in body)
        throw Object.assign(new Error(), { code: "BAD_COMMAND" });
      const payload = { ...body };
      delete payload.seat;
      if (seat !== HOST_ID) delete payload.note;
      options.body = JSON.stringify(payload);
      options.headers["content-type"] = "application/json";
    }
    const upstream = await fetch(
      `http://127.0.0.1:${lock.port}/api/${endpoint}?${query}`,
      options,
    );
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    for await (const chunk of upstream.body) {
      if (current.gameId !== manager.current?.gameId) {
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
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
      );
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
      if (req.method === "GET" && pathname === "/api/app") {
        const view = manager.snapshot();
        const host = room.hostView();
        const publishedPort = publicPort == null
          ? null
          : publicServer?.address()?.port ?? publicPort;
        json(res, 200, {
          ...view,
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
      const match =
        /^\/api\/game\/([0-9a-f-]{36})\/(snapshot|events|action-status|training-detail|action)$/.exec(
          pathname,
        );
      if (!match) {
        json(res, 404, { code: "NOT_FOUND" });
        return;
      }
      const [, gameId, endpoint] = match;
      await proxyGame({ req, res, url, gameId, endpoint, seat: HOST_ID });
    } catch (error) {
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
          json(res, 200, room.join({ code: body.code, name: body.name, addr }));
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
              final = {
                stacks: (engine.seats ?? []).map((seat) => ({
                  playerId: seat.playerId,
                  name: seat.name,
                  stack: seat.stack,
                  out: seat.out === true,
                })),
                result: engine.result ?? null,
                winnerId: engine.winnerId ?? null,
              };
            } catch {
              final = null;
            }
          }
          json(res, 200, {
            room: room.participantView(me.participantId),
            me: { participantId: me.participantId, name: me.name, playerId: me.playerId },
            game: {
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
      if (pathname === "/api/p/leave" && req.method === "POST") {
        try {
          const me = participantAuth();
          room.remove(me.participantId);
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, error.code === "UNAUTHORIZED" ? 401 : error.code === "ROOM_LOCKED" ? 409 : 404, { code: error.code ?? "UNAUTHORIZED" });
        }
        return;
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
        if (!me.playerId) {
          json(res, 409, { code: "NOT_SEATED" });
          return;
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
          seat: me.playerId,
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
      serveAsset(res, rel);
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
  if (publicPort != null) {
    await new Promise((resolve, reject) => {
      publicServer.once("error", reject);
      publicServer.listen(publicPort, publicListen, resolve);
    });
  }
  return {
    server,
    origin,
    publicPort: publicPort == null ? null : publicServer.address()?.port ?? publicPort,
    publicOrigin: publicPort == null
      ? null
      : `${tls ? "https" : "http"}://127.0.0.1:${publicServer.address()?.port ?? publicPort}`,
    close: async () => {
      if (publicPort != null) {
        publicServer.closeAllConnections();
        await new Promise((resolve) => publicServer.close(resolve));
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
function publicReceipt(row) {
  return {
    requestId: row.requestId,
    status: row.status,
    error: row.error,
    result: row.result,
  };
}
