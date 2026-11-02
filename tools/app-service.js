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
import { childSpawnOptions } from "../shared/child-spawn-options.js";
import { lstatExact } from "../shared/exact-stat.js";
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
import { hashPassword, writeHostCredential } from "./host-auth.js";
import { boundedNetworkCall } from "./bounded-network-call.js";
const SELF = fileURLToPath(import.meta.url),
  LOCK = "app.lock.d";
const listenerOwnedBy = createListenerOwnedBy({
  // lsof는 이 머신에서 0.03s지만(2026-09-11 실측) 프로세스 테이블이 크거나 느린
  // 디스크에서는 초 단위로 늘어난다. 만료는 APP_LISTENER_MISMATCH — 살아 있는
  // 서비스를 못 붙는 실패다.
  timeoutMs: process.platform === "win32" ? 15000 : 5000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// #343: the CLI is a one-shot process, so each request to the app — and the read of its answer —
// ends at its budget whatever fetch does (tools/bounded-network-call.js). A fetch that never
// settled used to empty the event loop: exit 13, no message, and a stop that left the app running.
// Inspect keeps the 10s each of its two requests always had. Prefill and stop had none; the app
// answers both at once (prefill as soon as it has read the body, stop with 202 before it stops),
// so the same 10s is a ceiling on waiting, never a delay that is spent.
const INSPECT_REQUEST_MS = 10_000;
const CONTROL_REQUEST_MS = 10_000;
async function requestApp(budgetMs, url, init, readBody = null) {
  const call = boundedNetworkCall(budgetMs);
  try {
    const response = await call.settle(fetch(url, { ...init, signal: call.signal }));
    const body = readBody ? await call.settle(readBody(response)) : undefined;
    return { response, body };
  } finally {
    call.release();
  }
}
// A transport failure or an expired budget of a control request is that request's closed code.
async function controlRequest(code, url, init) {
  try {
    return (await requestApp(CONTROL_REQUEST_MS, url, init)).response;
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}
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
  // Exact identity (#308): a Number-valued ino past 2^53 (Windows) can match a replacement.
  const st = lstatExact(file);
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
  // A transport failure or an expired budget is thrown as fetch gave it: the ensure waits retry it.
  const { response: challenge } = await requestApp(INSPECT_REQUEST_MS, `${d.origin}/api/app`, {
    headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` },
  });
  if (challenge.status !== 401) throw new Error("APP_AUTH_INVALID");
  const { response, body: snapshot } = await requestApp(
    INSPECT_REQUEST_MS,
    `${d.origin}/api/app`,
    { headers: { authorization: `Bearer ${d.token}` } },
    (answer) => answer.json(),
  );
  if (!response.ok || snapshot.instanceId !== d.instanceId)
    throw new Error("APP_IDENTITY_UNAVAILABLE");
  const after = readOwnedLock(store, LOCK),
    afterStat = lstatExact(file);
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
  {
    playerRuntime = "codex",
    resolver,
    port = 0,
    publicPort = null,
    publicHost = null,
    tlsCert = null,
    tlsKey = null,
    remoteHost = null,
  } = {},
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
      onChange: snapshot => server?.stateChanged(snapshot),
    });
    server = await startAppServer({
      manager,
      token,
      storeDir: store,
      port,
      publicPort,
      publicHost,
      tlsCert,
      tlsKey,
      remoteHost: remoteHost ? { ...remoteHost, appDir: dir } : null,
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
      publicPort: server.publicPort,
      publicOrigin: server.publicOrigin,
      remoteHostPort: server.remoteHostPort,
      remoteHostOrigins: server.remoteHostOrigins,
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
      const res = await controlRequest("PREFILL_FAILED", `${service.origin}/api/prefill`, {
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
    childSpawnOptions({ detached: true, stdio: ["ignore", log, log] }),
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
  const response = await controlRequest("APP_STOP_FAILED", `${service.origin}/api/stop`, {
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
export function parseServeArgs(rest) {
  let playerRuntime = "codex";
  let publicPort = Number(process.env.HOLDEM_PUBLIC_PORT ?? 8899);
  let publicHost = null;
  let tlsCert = null;
  let tlsKey = null;
  let remotePort = null;
  let remoteListen = null;
  const remoteNames = [];
  let remoteTlsCert = null;
  let remoteTlsKey = null;
  let remoteSeen = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const next = rest[i + 1];
    if (flag === "--player-runtime") { playerRuntime = next; i += 1; }
    else if (flag === "--public-port") { publicPort = Number(next); i += 1; }
    else if (flag === "--public-host") { publicHost = next; i += 1; }
    else if (flag === "--tls-cert") { tlsCert = next; i += 1; }
    else if (flag === "--tls-key") { tlsKey = next; i += 1; }
    else if (flag === "--remote-host-port") { remotePort = Number(next); remoteSeen = true; i += 1; }
    else if (flag === "--remote-host-listen") { remoteListen = next; remoteSeen = true; i += 1; }
    else if (flag === "--remote-host-name") { remoteNames.push(next); remoteSeen = true; i += 1; }
    else if (flag === "--remote-tls-cert") { remoteTlsCert = next; remoteSeen = true; i += 1; }
    else if (flag === "--remote-tls-key") { remoteTlsKey = next; remoteSeen = true; i += 1; }
  }
  // Any remote flag without the port is a half configuration: refuse it rather than run without it.
  if (remoteSeen && remotePort === null)
    throw Object.assign(new Error("원격 호스트 옵션에는 --remote-host-port가 필요합니다."), { code: "REMOTE_HOST_PORT_INVALID" });
  const remoteHost = remotePort === null ? null : {
    port: remotePort,
    listen: remoteListen,
    names: remoteNames,
    tlsCert: remoteTlsCert,
    tlsKey: remoteTlsKey,
  };
  return { playerRuntime, publicPort, publicHost, tlsCert, tlsKey, remoteHost };
}
async function readHiddenLine(question) {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004")
          return finish(Object.assign(new Error("취소했습니다."), { code: "CANCELLED" }));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
/** A TTY asks twice without echo; anything else reads the first line of stdin. */
export async function readNewHostPassword({ stdin = process.stdin } = {}) {
  if (stdin.isTTY) {
    const first = await readHiddenLine("새 원격 호스트 비밀번호(12자 이상): ");
    const second = await readHiddenLine("한 번 더 입력: ");
    if (first !== second)
      throw Object.assign(new Error("두 입력이 다릅니다."), { code: "PASSWORD_MISMATCH" });
    return first;
  }
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
}
export async function setHostPassword(store, password) {
  if (typeof store !== "string" || !path.isAbsolute(store))
    throw Object.assign(new Error("absolute store path required"), { code: "USAGE" });
  const record = await hashPassword(password);
  writeHostCredential(appDir(store), record);
  return record.credentialId;
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.umask(0o077);
  const [command, store, ...rest] = process.argv.slice(2);
  try {
    if (command === "serve") {
      const service = await startAppService(store, parseServeArgs(rest));
      for (const origin of service.remoteHostOrigins ?? [])
        console.log(`remote host: ${origin}/`);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(
          signal,
          () =>
            void service.close().catch(() => {
              process.exitCode = 1;
            }),
        );
    } else if (command === "host-password") {
      await setHostPassword(store, await readNewHostPassword());
      console.log(
        "원격 호스트 비밀번호를 저장했습니다. 이전 비밀번호로 만든 원격 세션은 다음 요청부터 끊깁니다.",
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
    // A DOMException's code is a legacy number (a timeout's is 23): print its message instead.
    console.error(typeof e.code === "string" ? e.code : e.message);
    process.exitCode = 1;
  }
}
