#!/usr/bin/env node
import fs from "node:fs";
import { createListenerOwnedBy } from "./listener-ownership.js";
import {
  readPrivateJson,
  writePrivateJson as writeJsonAtomic,
} from "./app-files.js";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acquireOwnedLock,
  releaseOwnedLock,
  readOwnedLock,
} from "../engine/state.js";
import {
  createPrivateDirectory,
  isPrivatePath,
} from "../shared/platform-files.js";
import { normalizeSetup } from "../shared/game-setup.js";
import { createSessionManager } from "./session-manager.js";
import { startAppServer } from "./app-server.js";
const SELF = fileURLToPath(import.meta.url),
  LOCK = "app.lock.d";
const listenerOwnedBy = createListenerOwnedBy({
  // lsof는 이 머신에서 0.03s지만(2026-09-11 실측) 프로세스 테이블이 크거나 느린
  // 디스크에서는 초 단위로 늘어난다. 만료는 APP_LISTENER_MISMATCH — 살아 있는
  // 서비스를 못 붙는 실패다.
  timeoutMs: process.platform === "win32" ? 15000 : 5000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function appDir(store) {
  const root = path.resolve(store);
  if (!path.isAbsolute(store)) throw new Error("absolute store path required");
  if (!fs.existsSync(root)) createPrivateDirectory(root);
  if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory())
    throw new Error("APP_PATH_UNSAFE");
  const dir = path.join(root, ".app");
  if (!fs.existsSync(dir)) createPrivateDirectory(dir);
  if (fs.lstatSync(dir).isSymbolicLink() || !isPrivatePath(dir))
    throw new Error("APP_PATH_UNSAFE");
  return dir;
}
export async function inspectAppService(store) {
  const dir = appDir(store),
    lock = readOwnedLock(store, LOCK);
  if (!lock || lock.status === "dead") return { status: "stopped" };
  if (lock.status !== "alive") throw new Error("APP_IDENTITY_UNAVAILABLE");
  const file = path.join(dir, "descriptor.json");
  const st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.size > 4096 ||
    !isPrivatePath(file)
  )
    throw new Error("APP_DESCRIPTOR_INVALID");
  const d = readPrivateJson(file, 4096);
  if (
    d.pid !== lock.pid ||
    d.startTime !== lock.startTime ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(d.origin) ||
    !/^[0-9a-f]{64}$/.test(d.token)
  )
    throw new Error("APP_DESCRIPTOR_INVALID");
  if (!(await listenerOwnedBy(d.pid, Number(new URL(d.origin).port))))
    throw new Error("APP_LISTENER_MISMATCH");
  const challenge = await fetch(`${d.origin}/api/app`, {
    headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` },
    signal: AbortSignal.timeout(10000),
  });
  if (challenge.status !== 401) throw new Error("APP_AUTH_INVALID");
  const response = await fetch(`${d.origin}/api/app`, {
    headers: { authorization: `Bearer ${d.token}` },
    signal: AbortSignal.timeout(10000),
  });
  const snapshot = await response.json();
  if (!response.ok || snapshot.instanceId !== d.instanceId)
    throw new Error("APP_IDENTITY_UNAVAILABLE");
  const after = readOwnedLock(store, LOCK),
    afterStat = fs.lstatSync(file);
  if (
    after?.status !== "alive" ||
    after.pid !== lock.pid ||
    after.startTime !== lock.startTime ||
    afterStat.ino !== st.ino ||
    afterStat.dev !== st.dev ||
    JSON.stringify(readPrivateJson(file, 4096)) !== JSON.stringify(d)
  )
    throw new Error("APP_IDENTITY_CHANGED");
  return { status: "running", ...d, url: `${d.origin}/#token=${d.token}` };
}
export async function startAppService(
  store,
  { playerRuntime = "codex", resolver, port = 0 } = {},
) {
  const dir = appDir(store),
    lock = acquireOwnedLock(store, LOCK);
  let server, manager, closing, initializing;
  const close = () => {
    if (closing) return closing;
    const attempt = (async () => {
      await manager?.close();
      await initializing?.catch(() => {});
      await server?.close();
      releaseOwnedLock(lock);
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = null;
    });
    return attempt;
  };
  try {
    const instanceId = randomUUID(),
      token = randomBytes(32).toString("hex");
    manager = createSessionManager({
      storeDir: store,
      instanceId,
      playerRuntime,
      resolver,
    });
    server = await startAppServer({
      manager,
      token,
      storeDir: store,
      port,
      onStop: () => void close(),
    });
    const identity = readOwnedLock(store, LOCK);
    const descriptor = {
      schemaVersion: 1,
      instanceId,
      pid: process.pid,
      startTime: identity.startTime,
      origin: server.origin,
      token,
    };
    writeJsonAtomic(path.join(dir, "descriptor.json"), descriptor);
    initializing = manager.initialize();
    void initializing.catch((error) => manager.initializationFailed(error));
    return {
      ...descriptor,
      manager,
      close,
      url: `${server.origin}/#token=${token}`,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function ensureAppService(
  store,
  { playerRuntime = "codex", setup } = {},
) {
  const prefill = setup === undefined ? null : normalizeSetup(setup);
  const attach = async (service) => {
    if (prefill) {
      const res = await fetch(`${service.origin}/api/prefill`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(prefill),
      });
      if (!res.ok) throw new Error("PREFILL_FAILED");
    }
    return service;
  };
  let existing;
  try {
    existing = await inspectAppService(store);
  } catch (error) {
    const owner = readOwnedLock(store, LOCK);
    if (owner?.status !== "alive") throw error;
    const deadline =
      Date.now() + (process.platform === "win32" ? 120000 : 45000);
    while (Date.now() < deadline) {
      await sleep(100);
      try {
        existing = await inspectAppService(store);
        if (existing.status === "running") return attach(existing);
      } catch {
        /* wait for this live owner's descriptor, never launch a competitor */
      }
    }
    throw error;
  }
  if (existing.status === "running") return attach(existing);
  const dir = appDir(store),
    log = fs.openSync(path.join(dir, "service.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [SELF, "serve", store, "--player-runtime", playerRuntime],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  fs.closeSync(log);
  // 콜드 기동은 이 머신에서 0.38–0.60s였지만(2026-09-11 실측) 느린 기기의 node
  // 부팅과 첫 privacy 증명은 그보다 훨씬 오래 걸릴 수 있다. 만료하면 로비 자체가
  // 열리지 않으므로 상한을 넉넉히 둔다 — 기다림의 천장이지 소비하는 지연이 아니다.
  const deadline = Date.now() + (process.platform === "win32" ? 120000 : 45000);
  let last;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      const service = await inspectAppService(store);
      if (service.status === "running") return attach(service);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("APP_START_TIMEOUT");
}
export async function stopAppService(store) {
  const service = await inspectAppService(store);
  if (service.status !== "running") return;
  const response = await fetch(`${service.origin}/api/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}` },
  });
  if (!response.ok) throw new Error("APP_STOP_FAILED");
  const deadline =
    Date.now() + (process.platform === "win32" ? 305000 : 125000);
  while (Date.now() < deadline) {
    const lock = readOwnedLock(store, LOCK);
    if (!lock || lock.status === "dead") return;
    await sleep(100);
  }
  throw new Error("APP_STOP_UNCONFIRMED");
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.umask(0o077);
  const [command, store, ...rest] = process.argv.slice(2);
  try {
    if (command === "serve") {
      const service = await startAppService(store, {
        playerRuntime: rest[1] ?? "codex",
      });
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(
          signal,
          () =>
            void service.close().catch(() => {
              process.exitCode = 1;
            }),
        );
    } else if (command === "stop") {
      await stopAppService(store);
      console.log("앱 서비스를 정지했습니다.");
    } else {
      const args = [store, ...rest].filter(Boolean);
      const runtimeIndex = args.indexOf("--player-runtime"),
        setupIndex = args.indexOf("--setup-file");
      const setup =
        setupIndex < 0
          ? undefined
          : JSON.parse(fs.readFileSync(args[setupIndex + 1], "utf8"));
      const service = await ensureAppService(command, {
        playerRuntime: runtimeIndex < 0 ? "codex" : args[runtimeIndex + 1],
        setup,
      });
      console.log(service.url);
    }
  } catch (e) {
    console.error(e.code ?? e.message);
    process.exitCode = 1;
  }
}
