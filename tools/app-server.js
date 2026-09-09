import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { loadUiState, publicSnapshot } from "../server/server.js";
import { ensureStudyService } from "./study-service.js";
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
export async function startAppServer({
  manager,
  token,
  storeDir,
  port = 0,
  onStop = () => {},
}) {
  let origin;
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
              : pathname.slice(1);
        const shared = rel.startsWith("shared/");
        const name = shared ? rel.slice(7) : rel;
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith(".")) {
          json(res, 404, { code: "NOT_FOUND" });
          return;
        }
        if (
          shared &&
          ![
            "reference.js",
            "reference-coverage.js",
            "preflop-key.js",
            "assistance.js",
          ].includes(name)
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
        const type =
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[path.extname(name)] ?? "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
        });
        res.end(content);
        return;
      }
      if (!equal(req.headers.authorization, `Bearer ${token}`)) {
        json(res, 401, { code: "UNAUTHORIZED" });
        return;
      }
      if (req.method === "GET" && pathname === "/api/app") {
        json(res, 200, manager.snapshot());
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
      query.set("token", lock.sessionToken);
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const options = {
        method: req.method,
        signal: controller.signal,
        headers: { "x-session-token": lock.sessionToken },
      };
      if (req.method === "POST") {
        const body = await bodyOf(req);
        if ("token" in body)
          throw Object.assign(new Error(), { code: "BAD_COMMAND" });
        options.body = JSON.stringify(body);
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
  return {
    server,
    origin,
    close: async () => {
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
