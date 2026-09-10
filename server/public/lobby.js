import { createLobbyCommandClient } from "./lobby-command-client.js";
const $ = (id) => document.getElementById(id),
  form = $("setup-form");
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("token")) {
  sessionStorage.setItem("holdem-app-token", fragment.get("token"));
  history.replaceState(null, "", location.pathname);
}
let appliedDefaults = false;
let snapshot = null,
  busy = false,
  selecting = false,
  frameId = null,
  confirmation = null,
  viewingRecord = false;
const labels = {
  lobby: "로비",
  starting: "게임 준비 중",
  playing: "게임 중",
  pausing: "현재 행동을 마친 뒤 일시정지 중",
  paused: "일시정지",
  stopping: "게임 종료 중",
  finalizing: "결과 정리 중",
  completed: "게임 완료",
  ended: "게임 종료",
  error: "확인이 필요합니다",
  external: "다른 게임 실행 중",
};
async function api(url, options = {}) {
  const headers = {
    authorization: `Bearer ${sessionStorage.getItem("holdem-app-token") ?? ""}`,
    ...options.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.code ?? "연결 실패"), {
      status: response.status,
    });
  return data;
}
function render() {
  if (!snapshot) return;
  const s = snapshot.state;
  const paused = s === "paused";
  $("table").inert = !viewingRecord && s !== "playing";
  $("status").textContent = labels[s] ?? s;
  if (snapshot.pendingDecision?.status === 'running' && snapshot.pendingDecision.softWait) $("status").textContent = 'LLM이 계속 생각하고 있습니다';
  const recovery = snapshot.pendingDecision && snapshot.pendingDecision.status !== 'running';
  $("pause-message").textContent = recovery
    ? (snapshot.pendingDecision.status === 'unsafe'
      ? '자식 프로세스 종료를 확인할 수 없어 재시도할 수 없습니다. 게임 종료 후 진단하세요.'
      : `LLM 결정을 보존했습니다 (${snapshot.pendingDecision.code ?? '복구 대기'}). 재시도하거나 종료하세요.`) : '일시정지 중입니다.';
  $("retry-decision").hidden = !recovery;
  $("retry-decision").disabled = busy || !snapshot.allowedCommands.includes('retry-decision');
  $("resume").hidden = !!recovery;
  $("setup").hidden = !(selecting || s === "lobby");
  $("game").hidden =
    !viewingRecord &&
    (selecting ||
      !["playing", "pausing", "paused", "stopping", "finalizing"].includes(s));
  $("menu").hidden = !["playing", "pausing", "paused"].includes(s);
  $("menu").disabled = busy || s === "pausing";
  $("menu").textContent = paused ? "일시정지 메뉴" : "일시정지 · 메뉴";
  $("result").hidden =
    selecting || !["completed", "ended", "error", "external"].includes(s);
  $("result-title").textContent = labels[s] ?? s;
  $("result-message").textContent =
    s === "ended"
      ? "중도 종료했습니다. 진행 중이던 핸드는 성적에 포함하지 않습니다."
      : s === "completed"
        ? "게임을 완료했습니다."
        : (errorMessages[snapshot.error] ?? "현재 게임 상태를 확인해 주세요.");
  $("recover").hidden = !snapshot.allowedCommands.includes("resume");
  $("review").hidden = !["completed", "ended"].includes(s);
  $("result-restart").hidden = !snapshot.allowedCommands.includes("restart");
  $("result-modes").hidden = !snapshot.allowedCommands.includes("start");
  $("back").hidden = !(selecting && paused);
  $("start").disabled =
    busy ||
    !snapshot.allowedCommands.some((c) =>
      ["start", "replace-current"].includes(c),
    );
  for (const id of ["resume", "restart", "modes", "end"])
    $(id).disabled = busy || !paused;
  if (!paused) $("pause-dialog").close();
  if (
    !snapshot.gameId ||
    (["ended", "completed"].includes(s) && !viewingRecord)
  ) {
    frameId = null;
    $("table").removeAttribute("src");
  } else if (
    frameId !== snapshot.gameId &&
    ["playing", "paused", "pausing"].includes(s)
  ) {
    frameId = snapshot.gameId;
    $("table").src =
      `/table?${new URLSearchParams({ appGame: snapshot.gameId, epoch: snapshot.gameEpoch })}`;
  }
}
async function refresh() {
  snapshot = await api("/api/app");
  if (!appliedDefaults && snapshot.defaultSetup) {
    const defaults = snapshot.defaultSetup;
    for (const [key, value] of Object.entries(defaults)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (key === "mode") {
        for (const radio of field) radio.checked = radio.value === value;
      } else if (field.type === "checkbox") field.checked = value;
      else field.value = String(value);
    }
    if (defaults.mode === "cash-training" && defaults.stack !== undefined) {
      form.elements.cashStackUnit.value = "chips";
      form.elements.cashStack.value = String(defaults.stack);
    }
    appliedDefaults = true;
    form.onchange();
  }
  render();
}
const errorMessages = {
  INVALID_SETUP: "설정이 서로 맞지 않습니다. 인원, 스택, 핸드 수를 확인하세요.",
  TENDENCY_INSUFFICIENT:
    "내 성향 상대를 사용하려면 적격 기록 60핸드 이상이 필요합니다.",
  STALE_APP: "상태가 갱신됐습니다. 현재 화면을 확인한 뒤 다시 선택하세요.",
  COMMAND_PENDING: "이전 요청을 처리 중입니다. 잠시 기다려 주세요.",
  ACTIVE_GAME:
    "다른 실행에서 게임이 진행 중입니다. 그 게임을 먼저 정리해 주세요.",
  CURRENT_CHANGED:
    "다른 실행에서 현재 게임이 변경됐습니다. 로비를 새로고침해 주세요.",
  RECOVERY_REQUIRED:
    "저장된 진행 정보를 자동으로 복구하지 못했습니다. 기록은 보존되어 있습니다.",
  SESSION_RECOVERABLE: "저장된 게임이 있습니다. 불러온 뒤 계속할 수 있습니다.",
  UNAUTHORIZED:
    "접속 링크가 만료됐습니다. start game으로 로비 링크를 다시 열어 주세요.",
  NO_PLAYER_RUNTIME:
    "사용 가능한 LLM 플레이어가 없습니다. 런타임 연결을 확인해 주세요.",
};
function showError(e) {
  $("error").textContent =
    errorMessages[e.message] ??
    "요청을 완료하지 못했습니다. 연결과 현재 게임 상태를 확인해 주세요.";
}
const commands = createLobbyCommandClient({
  request: api,
  storage: sessionStorage,
  onPoll: refresh,
});
async function command(kind, setup) {
  if (busy) return;
  viewingRecord = false;
  busy = true;
  render();
  $("error").textContent = "";
  try {
    const payload = {
      requestId: crypto.randomUUID(),
      expectedInstanceId: snapshot.instanceId,
      expectedAppRevision: snapshot.appRevision,
      expectedGameId: snapshot.gameId,
      expectedSelectionVersion: snapshot.selectionVersion,
      kind,
      ...(kind === 'retry-decision' ? { decisionId: snapshot.pendingDecision?.decisionId } : {}),
      ...(setup ? { setup } : {}),
    };
    await commands.send(payload);
    selecting = false;
    await refresh();
    if (snapshot.state === "paused") $("pause-dialog").showModal();
  } catch (e) {
    showError(e);
    await refresh().catch(() => {});
  } finally {
    busy = false;
    render();
  }
}
function confirm(fn) {
  confirmation = fn;
  $("confirm-dialog").showModal();
}
$("confirm-yes").onclick = () => {
  $("confirm-dialog").close();
  const fn = confirmation;
  confirmation = null;
  fn?.();
};
$("confirm-no").onclick = () => {
  $("confirm-dialog").close();
  confirmation = null;
};
function chooseMode() {
  selecting = true;
  $("pause-dialog").close();
  render();
  $("ai-count").focus();
}
$("menu").onclick = () =>
  snapshot.state === "paused"
    ? $("pause-dialog").showModal()
    : command("pause");
$("resume").onclick = () => command("resume");
$("retry-decision").onclick = () => command('retry-decision');
$("recover").onclick = () => command("resume");
$("restart").onclick = () => confirm(() => command("restart"));
$("end").onclick = () => confirm(() => command("end"));
$("modes").onclick = chooseMode;
$("result-modes").onclick = chooseMode;
$("result-restart").onclick = () => command("restart");
$("close-menu").onclick = () => $("pause-dialog").close();
$("back").onclick = () => {
  selecting = false;
  render();
  $("pause-dialog").showModal();
};
form.onchange = () => {
  const mode = new FormData(form).get("mode");
  $("cash-fields").hidden = mode !== "cash-training";
  const chips = form.elements.cashStackUnit.value === "chips";
  $("cash-chip-field").hidden = !chips;
  $("cash-bb-field").hidden = chips;
  $("tournament-fields").hidden = mode !== "tournament";
  const count = Number($("ai-count").value);
  $("seats").textContent = `나 1명 + AI ${count}명 = 총 ${count + 1}명`;
};
form.onsubmit = (e) => {
  e.preventDefault();
  const data = new FormData(form),
    setup = Object.fromEntries(
      [
        "mode",
        "blinds",
        "opponentRuntime",
        "hints",
        "dealBias",
        "showdownPolicy",
        "replayReveal",
      ].map((k) => [k, data.get(k)]),
    );
  for (const k of [
    "playerSoftMs",
    "playerHardMs",
    "aiCount",
    ...(setup.mode === "cash-training"
      ? ["stackBb", "hands"]
      : ["stack", "levelEvery"]),
  ])
    setup[k] = Number(data.get(k));
  if (setup.mode === "cash-training" && data.get("cashStackUnit") === "chips") {
    delete setup.stackBb;
    setup.stack = Number(data.get("cashStack"));
  }
  for (const k of ["mirrorSelf", "exploitSelf"]) setup[k] = data.has(k);
  if (snapshot.state === "paused")
    confirm(() => command("replace-current", setup));
  else command("start", setup);
};
$("review").onclick = () => {
  viewingRecord = true;
  $("table").inert = false;
  $("game").hidden = false;
  $("table").src =
    `/table?${new URLSearchParams({ appGame: snapshot.gameId, epoch: snapshot.gameEpoch, terminal: "1" })}`;
};
$("study").onclick = async () => {
  const tab = window.open("about:blank", "_blank");
  try {
    const result = await api("/api/study", { method: "POST" });
    if (tab) {
      tab.opener = null;
      tab.location = result.url;
    } else throw new Error("학습 창을 열려면 팝업을 허용하세요.");
  } catch (e) {
    tab?.close();
    showError(e);
  }
};
await refresh().catch(showError);
async function recoverCommand() {
  if (busy || !commands.pending) return;
  busy = true;
  render();
  try {
    await commands.recover();
    selecting = false;
    $("error").textContent = "";
    await refresh();
    if (snapshot.state === "paused") $("pause-dialog").showModal();
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    render();
  }
}
await recoverCommand();
setInterval(() => {
  if (!busy)
    void (commands.pending ? recoverCommand() : refresh().catch(showError));
}, 1000);
