import { createLobbyCommandClient } from "./lobby-command-client.js";
import {normalizeSetup} from '../../shared/game-setup.js';
import {formatAmount, readPreference} from './chip-format.js';
import { uuid } from './uuid.js';
import { createShellBridge } from './shell-bridge.js';
import { renderQr, copyText } from './invite.js';
const $ = (id) => document.getElementById(id),
  form = $("setup-form");
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("token")) {
  sessionStorage.setItem("holdem-app-token", fragment.get("token"));
  history.replaceState(null, "", location.pathname);
}
let appliedDefaults = false;
let rejoinFor = null;
let snapshot = null,
  busy = false,
  selecting = false,
  frameId = null,
  confirmation = null,
  viewingRecord = false;
// Local boot screen between "게임 시작" and the server's `starting` state, so the
// click answers at once. Cleared when the command settles.
let preparing = null;
let qrFor = null;
let roomShown = null;
let startingSeen = null;
let bootShown = false;
let validationShown = false;
const shellBridge = createShellBridge({
  frame: $("table"),
  identity: () => (snapshot?.gameId && snapshot.gameEpoch ? { gameId: snapshot.gameId, gameEpoch: snapshot.gameEpoch } : null),
  onContext: paintContext,
});
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
  const { timeoutMs, ...init } = options;
  const response = await fetch(url, {
    ...init,
    headers,
    // 시작 명령은 즉시 accepted를 받고 250ms 간격 폴링으로 진행하지만, 그 폴링
    // 한 건이라도 여기서 끊기면 사용자에게는 시작 실패로 보인다. 앱 서비스는
    // game-loop와 같은 프로세스라 부트 중 응답이 밀릴 수 있다. 서버가 자기 상한
    // 안에서 끝낼 수 있는 일을 클라이언트가 먼저 포기하면 안 되므로, 오래 걸리는
    // 라우트는 `timeoutMs`로 자기 상한을 명시한다.
    signal: options.signal ?? AbortSignal.timeout(timeoutMs ?? 30000),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.code ?? "연결 실패"), {
      status: response.status,
    });
  return data;
}
let interruptBusy=false;
// R3: set the moment pause is clicked (before the command is even accepted) so
// the table is inert at once; released only by a settled pause command, the
// authoritative state, or a different game (see syncTableInert).
let pauseLock=null;
function render() {
  if (!snapshot) return;
  const s = snapshot.state;
  const paused = s === "paused";
  const terminal=['completed','ended'].includes(s);
  viewingRecord=!!(!selecting && terminal && snapshot.gameId);

  syncTableInert();
  const interruptible=['playing','pausing'].includes(s) && snapshot.pendingDecision?.status==='running' && snapshot.pendingDecision.softWait===true;
  $('interrupt-decision').hidden=!interruptible;
  $('interrupt-decision').disabled=interruptBusy;

  $("status").textContent = labels[s] ?? s;
  if (snapshot.pendingDecision?.freshSessionAuthorized) $("status").textContent = '새 세션으로 재시도 중';
  if (snapshot.pendingDecision?.status === 'running' && snapshot.pendingDecision.softWait) $("status").textContent = 'AI가 계속 생각하고 있습니다';
  const recovery = snapshot.pendingDecision && snapshot.pendingDecision.status !== 'running';
  const stopping = !paused && (s === 'pausing' || Boolean(pauseLock));
  let technical = '';
  $("pause-message").textContent = stopping && !recovery ? '일시정지하는 중입니다. 진행 중인 작업을 마치면 멈춥니다.' : recovery
    ? (snapshot.pendingDecision.status === 'unsafe'
      ? snapshot.pendingDecision.code === 'JEV_REQUEST_CLOSE_UNCONFIRMED' ? 'JEV 요청 종료를 확인하지 못했습니다. 앱 서비스를 종료한 뒤 다시 열어 복구하세요.' : snapshot.pendingDecision.code === 'JEV_ENGINE_APPLY_UNCONFIRMED' ? '액션 적용 여부를 확인할 수 없어 재시도할 수 없습니다. 게임을 종료하거나 앱 재개로 기록을 확인하세요.' : '실행 종료를 확인할 수 없어 재시도할 수 없습니다. 게임 종료 후 진단하세요.'
      : snapshot.pendingDecision.retryable === false ? '입력 오류로 재시도할 수 없습니다. 게임을 종료하세요.'
      : `AI 결정을 보존했습니다 (${snapshot.pendingDecision.code ?? '복구 대기'}). 재시도하거나 종료하세요.`) : '일시정지 중입니다.';
  if (recovery) {
    const pending = snapshot.pendingDecision;
    const d = pending.diagnostics;
    // Raw reply details help diagnosis but are not the message: fold them away.
    if (d?.lastRejection) {
      const r = d.lastRejection;
      technical += `직전 회신 action=${r.action}${r.amount === null ? '' : ` amount=${r.amount}`} → ${r.detail}; 자동 교정 ${d.corrections}회. `;
    }
    if (pending.retryWillCorrect) $("pause-message").textContent += ' 재시도하면 교정 안내를 함께 보냅니다.';
    if (pending.freshSessionAvailable) $("pause-message").textContent += ' 같은 무효 회신이 반복되면 이 좌석의 새 세션으로 재시도할 수 있습니다.';
    if (pending.freshSessionAuthorized) $("pause-message").textContent = '새 세션으로 재시도 중';
    if (pending.diagnosticsQuarantined) technical += '진단 기록이 손상되어 격리됨.';
  }
  // A decision waiting for recovery is a warning, not the ordinary paused note.
  $("pause-message").classList.toggle('is-warning', Boolean(recovery));
  $("pause-tech").hidden = !technical;
  $("pause-tech-text").textContent = technical.trim();
  $("pause-progress").hidden = !(stopping && s === 'pausing');
  $("pause-progress").textContent = pauseProgressText(snapshot.pausing) + pauseElapsedText(snapshot.pausing);
  $("retry-decision").hidden = !recovery || snapshot.pendingDecision?.retryable === false;
  $("retry-decision").disabled = busy || !snapshot.allowedCommands.includes('retry-decision');
  $("retry-fresh-session").hidden = !snapshot.pendingDecision?.freshSessionAvailable;
  $("retry-fresh-session").disabled = busy || !snapshot.allowedCommands.includes('retry-decision');
  $("fresh-session-yes").disabled = busy || !snapshot.pendingDecision?.freshSessionAvailable;
  if (!paused || !snapshot.pendingDecision?.freshSessionAvailable) $("fresh-session-dialog").close();
  $("resume").hidden = !!recovery;
  $("setup").hidden = !(selecting || s === "lobby");
  $("game").hidden =
    !viewingRecord &&
    (selecting ||
      !["playing", "pausing", "paused", "stopping", "finalizing"].includes(s));
  document.body.classList.toggle('has-game', !$("game").hidden);
  $("menu").hidden = !["playing", "pausing", "paused"].includes(s);
  // Stays usable while pausing so a closed menu can be reopened to watch progress.
  $("menu").disabled = busy && !pauseLock;
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
  $("result-end").hidden = !snapshot.allowedCommands.includes("end");
  $("result-end").disabled = busy || !snapshot.allowedCommands.includes("end");
  const room = snapshot.room;
  $('seat-management').hidden = room?.status !== 'open';
  if (room?.status !== 'open' || rejoinFor?.roomId !== room?.roomId
    || !room?.participants?.some(row=>row.participantId===rejoinFor?.participantId)) {
    rejoinFor=null;$('rejoin-link').value='';$('rejoin-link').hidden=true;
  }
  $('managed-seats').replaceChildren(...(room?.participants ?? []).map(row=>{
    const item=document.createElement('li');item.dataset.participantId=row.participantId;
    item.textContent=`${row.name}${row.connected ? ' ●' : ' (오프라인)'} `;
    const rejoin=document.createElement('button');rejoin.type='button';rejoin.textContent='재입장 링크';
    rejoin.disabled=busy||room.status!=='open';rejoin.dataset.action='reissue';
    rejoin.onclick=async()=>{
      try {
        const result=await roomOp('reissue',{participantId:row.participantId});
        if(snapshot.room?.roomId!==room.roomId||snapshot.room?.status!=='open')return;
        rejoinFor={roomId:room.roomId,participantId:row.participantId};
        $('rejoin-link').value=new URL(result.link,room.links?.[0]??location.origin).href;
        $('rejoin-link').hidden=false;$('rejoin-link').select();
      } catch(error) {showError(error);}
    };
    const remove=document.createElement('button');remove.type='button';remove.textContent='좌석 비우기';
    remove.disabled=busy||room.status!=='open';remove.dataset.action='remove';
    remove.onclick=()=>roomOp('remove',{participantId:row.participantId}).catch(showError);
    item.append(rejoin,remove);return item;
  }));
  if ($('live-observers')) $('live-observers').hidden = !room || !['open','locked'].includes(room.status);
  for (const id of ['spectator-count','live-spectator-count']) if ($(id)) $(id).textContent=String(room?.spectators?.length ?? 0);
  for (const id of ['room-spectators','live-spectators']) {
    if (!$(id)) continue;
    $(id).replaceChildren(...(room?.spectators ?? []).map(row=>{
      const item=document.createElement('li');
      item.textContent=`${row.name}${row.connected ? ' ●' : ' (오프라인)'} `;
      const remove=document.createElement('button');remove.type='button';remove.textContent='내보내기';
      remove.onclick=()=>roomOp('remove',{participantId:row.participantId}).catch(showError);
      item.append(remove);return item;
    }));
  }
  if ($("room-panel")) {
    $("room-panel").hidden = !room;
    if (room) {
      $("join-code").textContent = room.joinCode ?? "";
      $("room-status").textContent = {open: "참가 대기 중", locked: "게임 중 · 참가 잠김", closed: "세션 닫힘"}[room.status] ?? room.status;
      $("room-status").dataset.status = room.status;
      $("join-links").replaceChildren(
        ...(room.links ?? []).map((link) => {
          const item = document.createElement("li");
          item.textContent = link;
          return item;
        }),
      );
      $("room-participants").replaceChildren(
        ...(room.participants ?? []).map((row) => {
          const item = document.createElement("li");
          item.textContent = `${row.name}${row.connected ? " ●" : ""}`;
          return item;
        }),
      );
      $("room-close").disabled = room.status === "locked";
      // A closed room keeps its status line, but the table size goes back to
      // the AI count (a closed session has no participants to seat).
      const roomLive = ["open", "locked"].includes(room.status);
      $("room-panel").dataset.status = room.status;
      $("ai-count").hidden = roomLive;
      $("ai-count-field").hidden = roomLive;
    } else {
      $("ai-count").hidden = false;
      $("ai-count-field").hidden = false;
    }
  }
  $("result-restart").disabled = busy || !snapshot.allowedCommands.includes("restart");
  $("result-end").textContent = snapshot.recoveryExit?.mode === 'finalize' ? '기록을 버리고 결과 정리' : '게임 종료';
  $("result-modes").hidden = !snapshot.allowedCommands.includes("start");
  $("back").hidden = !(selecting && paused);
  $("start").disabled =
    busy ||
    !snapshot.allowedCommands.some((c) =>
      ["start", "replace-current"].includes(c),
    );
  for (const id of ["resume", "restart", "modes", "end"])
    $(id).disabled = busy || !paused;
  if (!paused && !stopping) $("pause-dialog").close();
  if (!snapshot.gameId || (selecting && terminal)) {
    frameId=null;$("table").removeAttribute('src');
  } else if (frameId!==snapshot.gameId && ['playing','paused','pausing','stopping','finalizing','completed','ended'].includes(s)) {
    frameId=snapshot.gameId;
    $("table").src=`/table?${new URLSearchParams({appGame:snapshot.gameId,epoch:snapshot.gameEpoch,...(terminal?{terminal:'1'}:{})})}`;
  }
  // Shell extras live outside render(): tests run this function alone in a VM.
  if (typeof paintShell === "function") paintShell();
}
// One place decides whether the table accepts input: a local pause lock, a
// non-playing state, or any open dialog. Called from render, dialog close and
// the dialog observer, so closing the menu never unlocks a pending pause.
function syncTableInert() {
  if (!snapshot) return;
  if (pauseLock && (['finalizing','completed','ended','error'].includes(snapshot.state)
    || snapshot.gameId !== pauseLock.gameId || snapshot.gameEpoch !== pauseLock.gameEpoch)) pauseLock = null;
  $("table").inert = Boolean(pauseLock) || (!["playing","finalizing","completed","ended"].includes(snapshot.state)) || Boolean(document.querySelector('dialog[open]'));
  $("table-lock").hidden = !(pauseLock || snapshot.state === 'pausing');
  setLiveText($("table-lock-detail"), snapshot.state === 'pausing' ? pauseProgressText(snapshot.pausing) : '');
  $("table-lock-elapsed").textContent = snapshot.state === 'pausing' ? pauseElapsedText(snapshot.pausing) : '';
}
// What the pause is waiting for, by kind (design §8.1). The elapsed seconds
// are separate so live regions announce a change of reasons, not every tick.
function pauseProgressText(pausing) {
  const w = pausing?.waitingFor ?? {};
  const children = (w.explain ?? 0) + (w.evaluate ?? 0) + (w.solve ?? 0);
  const parts = [w.explain ? `학습 설명 ${w.explain}건` : '', w.evaluate ? `학습 평가 ${w.evaluate}건` : '',
    w.solve ? `솔버 분석 ${w.solve}건` : '', !children && w.training ? `학습 분석 ${w.training}건` : '',
    w.coach ? `코치 노트 ${w.coach}건` : '', w.resolver ? 'AI 코치 연결 확인' : '',
    w.other ? `기타 작업 ${w.other}건` : ''].filter(Boolean);
  return parts.length ? `마무리 중: ${parts.join(' · ')}` : '현재 결정을 마치는 중입니다.';
}
function pauseElapsedText(pausing) {
  const since = Date.parse(pausing?.since ?? '');
  return Number.isFinite(since) ? ` · ${Math.max(0, Math.round((Date.now() - since) / 1000))}초째` : '';
}
// Rewrite a live region only when its words change.
function setLiveText(node, text) { if (node.textContent !== text) node.textContent = text; }
let refreshFailures=0;
async function refresh() {
  snapshot = await api("/api/app");
  refreshFailures=0;
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
const BOOT_ORDER = ["sweep", "runtime-probe", "relay", "player-warmup"];
// Online mode only while a session is open or playing; a closed room object
// lingers in the snapshot for its status line.
const roomIsLive = () => ["open", "locked"].includes(snapshot?.room?.status);
function paintShell() {
  const s = snapshot.state;
  const booting = !!preparing || s === "starting";
  startingSeen = s === "starting" ? startingSeen ?? Date.now() : null;
  $("boot").hidden = !booting;
  // Move focus to the boot screen once: the start button it came from is hidden.
  if (booting && !bootShown) $("boot-title").focus({ preventScroll: true });
  bootShown = booting;
  if (booting) {
    $("setup").hidden = true;
    $("result").hidden = true;
    $("game").hidden = true;
    document.body.classList.remove("has-game");
    paintBoot();
  }
  $("status").classList.toggle("ui-sr-only", s === "lobby" && !booting);
  $("coach-chip").hidden = snapshot.upperStatus !== "probing" || !document.body.classList.contains("has-game");
  if (roomIsLive() !== roomShown) { roomShown = roomIsLive(); updateSetupSummary(); }
  $("room-open").hidden = roomIsLive();
  // Plain-http join links travel unencrypted; TLS sessions need no warning.
  $("tls-warning").hidden = !roomIsLive() || snapshot.room.tls === true;
  for (const id of ["join-code-block", "join-qr", "join-links", "join-copy", "room-rotate", "room-close"]) $(id).hidden = !roomIsLive();
  paintNotices();
  paintResultCard();
  paintInvite();
  if (!document.body.classList.contains("has-game")) paintContext(null);
  else paintContext(shellBridge.context);
}
function paintBoot() {
  const boot = snapshot.state === "starting" ? snapshot.boot : null;
  const stage = boot?.stage === "preparing" || !boot?.stage ? "sweep" : boot.stage;
  const opponent = preparing?.opponent ?? snapshot.setup?.opponentRuntime ?? form.elements.opponentRuntime.value;
  const index = stage === "ready" ? BOOT_ORDER.length : Math.max(0, BOOT_ORDER.indexOf(stage));
  for (const item of $("boot-steps").children) {
    const step = item.dataset.step;
    const at = BOOT_ORDER.indexOf(step);
    item.hidden = (step === "runtime-probe" || step === "player-warmup") && opponent !== "llm" && stage !== step;
    item.dataset.state = at < index ? "done" : at === index ? "active" : "waiting";
  }
  const probe = boot?.probe;
  $("boot-probe").textContent = !probe ? ""
    : probe.ok === null ? `${probe.runtime} 확인 중`
    : probe.ok ? `${probe.runtime} 연결됨` : `${probe.runtime} 사용 불가 · 다음 런타임 확인`;
  $("boot-hint").hidden = $("boot-steps").querySelector('[data-step="runtime-probe"]').hidden;
  // A service that predates the boot field reports no stages: show only the clock.
  const legacy = snapshot.state === "starting" && !Object.hasOwn(snapshot, "boot");
  $("boot-steps").hidden = legacy;
  if (legacy) $("boot-hint").hidden = true;
  const started = Date.parse(boot?.startedAt ?? "") || preparing?.since || startingSeen || Date.now();
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  $("boot-elapsed").textContent = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}
function noticeState(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function paintNotices() {
  const notices = snapshot.notices;
  const items = Array.isArray(notices?.items) ? notices.items : [];
  const unclassified = Number.isSafeInteger(notices?.unclassified) ? notices.unclassified : 0;
  const omitted = Number.isSafeInteger(notices?.omitted) ? notices.omitted : 0;
  const total = items.length + (unclassified > 0 ? 1 : 0) + (omitted > 0 ? 1 : 0);
  $("notices").hidden = total === 0 || !!preparing || snapshot.state === "starting";
  if (total === 0) return;
  const level = items.some((item) => item.level === "error") ? "error" : items.some((item) => item.level === "warn") ? "warn" : "info";
  $("notices").dataset.level = level;
  const itemCount = items.reduce((sum, item) => sum + (Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1), 0);
  $("notices-count").textContent = String(itemCount + unclassified + omitted);
  $("notices-title").textContent = level === "info" ? "알림" : "확인이 필요한 알림";
  const key = `holdem.notices.v1:${snapshot.gameId ?? "lobby"}`;
  const stored = noticeState(key);
  // Only errors open the dropdown by themselves; everything else waits for a click.
  const open = stored ? stored === "open" : level === "error";
  $("notices-toggle").setAttribute("aria-expanded", String(open));
  $("notices-list").hidden = !open;
  $("notices-list").replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.dataset.level = item.level;
    li.textContent = item.count > 1 ? `${item.text} (${item.count}건)` : item.text;
    return li;
  }), ...(omitted > 0 ? [Object.assign(document.createElement("li"), {
    textContent: `그 밖의 알림 ${omitted}건`,
  })] : []), ...(unclassified > 0 ? [Object.assign(document.createElement("li"), {
    textContent: `진단 알림 ${unclassified}건 — 앱 로그에서 확인할 수 있어요.`,
  })] : []));
  const diagnostic = $("notices-list").lastElementChild;
  if (unclassified > 0 && diagnostic) diagnostic.dataset.kind = "diagnostic";
}
// The table's BB/chips selector writes the shared preference; follow it here.
window.addEventListener("storage", (event) => {
  if (event.key === "holdem.display-unit.v1" && document.body.classList.contains("has-game")) paintContext(shellBridge.context);
});
$("notices-toggle").onclick = () => {
  const open = $("notices-toggle").getAttribute("aria-expanded") !== "true";
  try { sessionStorage.setItem(`holdem.notices.v1:${snapshot?.gameId ?? "lobby"}`, open ? "open" : "closed"); } catch { /* per-tab only */ }
  $("notices-toggle").setAttribute("aria-expanded", String(open));
  $("notices-list").hidden = !open;
};
const RESULT_PRIMARY = {
  completed: ["result-restart", "review", "result-modes"],
  ended: ["review", "result-restart", "result-modes"],
  error: ["recover", "result-end", "result-restart"],
  external: ["recover", "result-modes"],
};
function paintResultCard() {
  const order = RESULT_PRIMARY[snapshot.state] ?? [];
  const primary = order.find((id) => !$(id).hidden);
  for (const id of ["review", "result-restart", "result-end", "result-modes", "recover"]) {
    const button = $(id);
    const danger = id === "result-end";
    button.classList.toggle("ui-btn--primary", id === primary && !danger);
    button.classList.toggle("ui-btn--secondary", id !== primary && !danger && id !== "result-modes");
  }
}
function paintInvite() {
  const link = roomIsLive() ? snapshot.room.links?.[0] ?? null : null;
  if (link === qrFor) return;
  qrFor = link;
  $("join-copy-status").textContent = "";
  $("join-copy-fallback").hidden = true;
  if (!link) { $("join-qr").replaceChildren(); return; }
  renderQr($("join-qr"), link);
}
function paintContext(context) {
  const node = $("shell-context");
  if (!context) { node.hidden = true; node.replaceChildren(); return; }
  const parts = [];
  const add = (label, value, className = "") => {
    const span = document.createElement("span");
    span.append(`${label} `);
    const strong = document.createElement("span");
    strong.className = `ui-num ${className}`.trim();
    strong.textContent = value;
    span.append(strong);
    parts.push(span);
  };
  if (context.handNo !== null) add("핸드", context.handLimit ? `${context.handNo}/${context.handLimit}` : String(context.handNo));
  if (context.blinds) add(context.level ? `레벨 ${context.level} ·` : "블라인드", `${context.blinds[0].toLocaleString("ko-KR")}/${context.blinds[1].toLocaleString("ko-KR")}`);
  if (context.sessionNet !== null) {
    // Same BB/chips preference as the table's own unit selector.
    const net = formatAmount(context.sessionNet, context.blinds?.[1] ?? null, readPreference(), true).primary;
    add("손익", net, context.sessionNet > 0 ? "ui-pos" : context.sessionNet < 0 ? "ui-neg" : "");
  }
  if (context.conn !== "on") add("연결", context.conn === "retry" ? "재연결 중" : "종료");
  node.replaceChildren(...parts);
  node.hidden = parts.length === 0;
}
const errorMessages = {
  JEV_API_KEY_MISSING: '서버에 TYPESAFE_API_KEY를 설정한 뒤 다시 시작하세요.',
  JEV_SDK_UNAVAILABLE: '서버에서 npm ci로 JEV SDK를 설치하세요.',
  JEV_CONFIG_UNSUPPORTED: '저장된 JEV 버전을 지원하는 앱이 필요합니다. 기록은 보존됩니다.',
  OPPONENT_RUNTIME_MISMATCH: '저장된 상대 AI 방식과 요청 설정이 다릅니다.',
  JEV_AUTH_FAILED: 'TypeSafe API 키 인증에 실패했습니다. 서버 키 설정을 확인하세요.',
  JEV_RATE_LIMITED: 'TypeSafe 요청 한도에 도달했습니다. 잠시 후 재시도하세요.',
  JEV_SERVICE_UNAVAILABLE: 'TypeSafe 서비스를 사용할 수 없습니다. 잠시 후 재시도하세요.',
  BAD_PLAYER_RECOVERY: '저장된 AI 결정 기록을 검증할 수 없어 이어서 할 수 없습니다. 기록은 보존한 채 게임을 종료하거나 같은 설정으로 새 게임을 시작할 수 있습니다.',
  RETRY_NOT_APPLIED: '재시도 인가가 실행되기 전에 앱이 중단됐습니다. 필요하면 재시도를 다시 선택하세요.',
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
  ROOM_UNBOUND: "온라인 세션이 이 게임에 결합되어 있지 않습니다. 게임을 종료하거나 같은 설정으로 새로 시작하세요.",
  ROOM_FULL: "참가 인원이 가득 찼습니다.",
  JOIN_LOCKED: "이 주소는 잠시 참가가 잠겼습니다. 나중에 다시 시도하세요.",
  ROOM_LOCKED: "게임이 진행 중이라 참가하거나 세션을 닫을 수 없습니다.",
  NAME_TAKEN: "이미 쓰인 이름입니다. 다른 이름을 선택하세요.",
  UNAUTHORIZED:
    "접속 링크가 만료됐습니다. start game으로 로비 링크를 다시 열어 주세요.",
  NO_PLAYER_RUNTIME:
    "사용 가능한 LLM 플레이어가 없습니다. 런타임 연결을 확인해 주세요.",
};
function showError(e) {
  $("error").dataset.kind = e?.code === "INVALID_SETUP" ? "setup" : "";
  $("error").textContent =
    errorMessages[e.code] ?? errorMessages[e.message] ??
    "요청을 완료하지 못했습니다. 연결과 현재 게임 상태를 확인해 주세요.";
}
const commands = createLobbyCommandClient({
  request: api,
  storage: sessionStorage,
  onPoll: refresh,
});
async function command(kind, setup, extra = {}) {
  if (busy) return;
  let refocusStart = false;
  let menuAfter = false;
  viewingRecord = false;
  busy = true;
  if (["start", "replace-current", "restart"].includes(kind)) {
    preparing = { since: Date.now(), opponent: setup?.opponentRuntime ?? snapshot.setup?.opponentRuntime ?? null };
  }
  render();
  $("error").textContent = "";
  try {
    const payload = {
      requestId: uuid(),
      expectedInstanceId: snapshot.instanceId,
      expectedAppRevision: snapshot.appRevision,
      expectedGameId: snapshot.gameId,
      expectedSelectionVersion: snapshot.selectionVersion,
      kind,
      ...(kind === 'retry-decision' ? { decisionId: snapshot.pendingDecision?.decisionId } : {}),
      ...(setup ? { setup } : {}),
      ...extra,
    };
    await commands.send(payload);
    if (kind === "pause") pauseLock = null;
    selecting = false;
    await refresh();
    menuAfter = snapshot.state === "paused";
  } catch (e) {
    refocusStart = !!preparing && kind === "start";
    preparing = null;
    // A refused pause is final; an unanswered one stays locked until recovered.
    if (kind === "pause" && !commands.pending) pauseLock = null;
    showError(e);
    await refresh().catch(() => {});
  } finally {
    preparing = null;
    busy = false;
    render();
    // A rejected start returns to the untouched form with focus on the button
    // (only now is it enabled again). A settled pause focuses the menu's primary
    // only if the menu is still open: one the user dismissed while pausing stays
    // closed, and the menu button reopens it.
    if (refocusStart && !$("setup").hidden) $("start").focus();
    if (menuAfter && $("pause-dialog").open) openPauseMenu();
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
  viewingRecord = false;
  $("pause-dialog").close();
  render();
  $("ai-count").focus();
}
$('interrupt-decision').onclick=async()=>{
  if(interruptBusy || !snapshot?.pendingDecision)return;
  const request={expectedGameId:snapshot.gameId,gameEpoch:snapshot.gameEpoch,decisionId:snapshot.pendingDecision.decisionId,generation:snapshot.pendingDecision.generation};
  interruptBusy=true;render();
  try {
    const result=await api('/api/app/interrupt-decision',{method:'POST',body:JSON.stringify(request),timeoutMs:30000});
    if(snapshot.gameId===request.expectedGameId)$('error').textContent=result.interrupted?'결정을 중단했습니다. 재시도하거나 게임을 종료할 수 있습니다.':'중단 완료를 확인하지 못했습니다. 현재 결정 상태를 확인하세요.';
    await refresh();
  } catch(error){showError(error);}
  finally {interruptBusy=false;render();}
};
function openPauseMenu() {
  if (!$("pause-dialog").open) $("pause-dialog").showModal();
  const primary = [$("resume"), $("retry-decision")].find((node) => !node.hidden && !node.disabled);
  primary?.focus();
}
// The menu opens at once; the pause command runs behind it (R3, design §8.1).
$("menu").onclick = () => {
  if (snapshot.state !== "playing" || pauseLock) { openPauseMenu(); return; }
  if (busy) return;
  pauseLock = { gameId: snapshot.gameId, gameEpoch: snapshot.gameEpoch };
  render();
  openPauseMenu();
  void command("pause");
};
$("resume").onclick = () => command("resume");
$("retry-decision").onclick = () => command('retry-decision');
$("retry-fresh-session").onclick = () => $("fresh-session-dialog").showModal();
$("fresh-session-no").onclick = () => $("fresh-session-dialog").close();
$("fresh-session-yes").onclick = () => {
  $("fresh-session-dialog").close();
  if (snapshot.pendingDecision?.freshSessionAvailable) void command('retry-decision', undefined, {freshSession: true});
};
$("recover").onclick = () => command("resume");
$("restart").onclick = () => confirm(() => command("restart"));
$("end").onclick = () => confirm(() => command("end"));
$("modes").onclick = chooseMode;
$("result-modes").onclick = chooseMode;
$("result-restart").onclick = () => snapshot.state === 'error' ? confirm(() => command('restart')) : command('restart');
$("result-end").onclick = () => confirm(() => command('end'));
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
  updateSetupSummary();
};
const OPPONENT_HELP = {
  policy: "로컬 정책 AI가 즉시 결정해 가장 빨리 시작합니다. 상대의 행동 결정에는 외부 호출이 없습니다(코치·리뷰는 연결된 AI 모델을 씁니다).",
  llm: "LLM이 생각한 뒤 행동합니다. 결정마다 몇 초가 걸리고 판단 이유를 남깁니다.",
  jev: "외부 API(TypeSafe AI)로 모든 AI 좌석을 움직입니다. 서버에 API 키가 필요하며, 각 AI의 자기 패와 공개 플레이 정보를 전송합니다.",
};
const PACE_LABELS = { instant: "즉시", fast: "빠름", normal: "보통", slow: "느림" };
function paintSeatDots(total) {
  const svg = $("seat-dots");
  const ns = "http://www.w3.org/2000/svg";
  const felt = document.createElementNS(ns, "ellipse");
  felt.setAttribute("class", "felt");
  for (const [key, value] of Object.entries({ cx: 60, cy: 32, rx: 44, ry: 20 })) felt.setAttribute(key, String(value));
  const seats = Array.from({ length: total }, (_, index) => {
    const angle = Math.PI / 2 + (index * 2 * Math.PI) / total;
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("class", index === 0 ? "seat me" : "seat");
    dot.setAttribute("cx", (60 + 54 * Math.cos(angle)).toFixed(1));
    dot.setAttribute("cy", (32 + 26 * Math.sin(angle)).toFixed(1));
    dot.setAttribute("r", "4.5");
    return dot;
  });
  svg.replaceChildren(felt, ...seats);
}
function setupFromForm() {
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
        "pace",
      ].map((k) => [k, data.get(k)]),
    );
  // The AI wait budget only exists for remote players; policy games use the
  // server defaults (and their hidden inputs can never block a start).
  const remote = data.get("opponentRuntime") !== "policy";
  for (const k of [
    ...(remote ? ["playerSoftMs", "playerHardMs"] : []),
    ...(roomIsLive()
      ? []
      : ["aiCount"]),
    ...(setup.mode === "cash-training"
      ? ["stackBb", "hands"]
      : ["stack", "levelEvery"]),
  ])
    setup[k] = Number(data.get(k));
  if (roomIsLive()) {
    setup.totalSeats = Number($("total-seats")?.value || 6);
    setup.hints = "off";
    setup.dealBias = "off";
  }
  if (setup.mode === "cash-training" && data.get("cashStackUnit") === "chips") {
    delete setup.stackBb;
    setup.stack = Number(data.get("cashStack"));
  }
  for (const k of ["mirrorSelf", "exploitSelf"]) setup[k] = data.has(k);
  return setup;
}
function updateSetupSummary() {
  $('llm-settings').hidden=form.elements.opponentRuntime.value==='policy';
  $('opponent-help').textContent=OPPONENT_HELP[form.elements.opponentRuntime.value] ?? '';
  const roomSeats=roomIsLive() ? Number($('total-seats')?.value || 6) : null;
  if (roomSeats) $('seats').textContent=`호스트 포함 총 ${roomSeats}명 · 빈 자리는 AI`;
  paintSeatDots(roomSeats ?? Number($('ai-count').value)+1);
  $('llm-budget-help').textContent=`알림 ${Number(form.elements.playerSoftMs.value)/1000}초 · 호출 최대 ${Number(form.elements.playerHardMs.value)/60000}분`;
  try {
    const setup=normalizeSetup(setupFromForm());
    const bb=Number(setup.blinds.split('/')[1]);
    const amount=formatAmount(setup.stack??setup.stackBb*bb,bb);
    $('setup-summary').textContent=`${setup.mode==='cash-training'?'캐시 트레이닝':'토너먼트'} · ${{policy:'로컬 정책',llm:'LLM',jev:'JEV'}[setup.opponentRuntime]} · 총 ${setup.aiCount+1}명 · ${amount.primary} / ${amount.secondary} · ${setup.blinds} 칩${setup.hands?` · ${setup.hands}핸드`:''}`;
    $('setup-assistance').textContent=[setup.dealBias!=='off'?'유리한 딜 · 평가 제외':null,setup.hints==='on'?'행동 전 힌트 켬':null,setup.showdownPolicy==='open'?'쇼다운 모두 공개':null,setup.replayReveal==='all'?'복기 카드 모두 공개':null].filter(Boolean).join(' · ');
    $('details-value').textContent=`${setup.blinds} · ${amount.primary}${setup.hands?` · ${setup.hands}핸드`:''} · ${PACE_LABELS[setup.pace] ?? ''}`;
    if (validationShown) markFieldError(null);
    if ($('error').dataset.kind === 'setup') { $('error').textContent=''; $('error').dataset.kind=''; }
  } catch(e) {if (validationShown) markFieldError(e);$('setup-summary').textContent=`설정 확인 필요 · ${FIELD_ERRORS[e.field] ?? '입력값을 확인하세요.'}`;$('setup-assistance').textContent='유효한 설정을 입력하면 시작 전 요약을 확인할 수 있습니다.';}
}
const FIELD_ERRORS = {
  blinds: '블라인드는 "작은 블라인드/큰 블라인드" 숫자로 입력하세요. 예: 25/50',
  stackBb: '시작 스택(BB)을 확인하세요.',
  stack: '시작 스택(칩)을 확인하세요.',
  hands: '핸드 수를 확인하세요.',
  levelEvery: '블라인드 상승 주기를 확인하세요.',
  aiCount: 'AI 플레이어 수를 확인하세요.',
  totalSeats: '총 인원을 확인하세요.',
  mirrorSelf: '내 성향 상대 두 종류를 함께 쓰려면 AI가 2명 이상이어야 합니다.',
  exploitSelf: '내 성향 상대 두 종류를 함께 쓰려면 AI가 2명 이상이어야 합니다.',
  'playerSoftMs/playerHardMs': '대기 시간은 1 이상의 정수(ms)이고, 최대 대기는 알림보다 길며 3,600,000ms(1시간) 이하여야 합니다.',
};
function fieldInputs(field) {
  // The total-chips check reports "stack" even when the stack was entered in BB.
  if (field === 'stack' && new FormData(form).get('mode') === 'cash-training') {
    return [form.elements.cashStackUnit.value === 'chips' ? form.elements.cashStack : form.elements.stackBb];
  }
  // A pair error ("playerSoftMs/playerHardMs") marks both inputs, focusing the first.
  return String(field).split('/').map((name) => form.elements.namedItem(name) ?? (name === 'totalSeats' ? $('total-seats') : null))
    .filter((input) => input && typeof input.setAttribute === 'function');
}
/** Shows the failing field inline (aria-invalid + message). Returns the input. */
function markFieldError(error) {
  for (const node of document.querySelectorAll('#setup-form [aria-invalid="true"]')) {
    node.removeAttribute('aria-invalid');
    node.removeAttribute('aria-describedby');
  }
  for (const node of document.querySelectorAll('#setup-form .field-error')) node.remove();
  const inputs = error?.field ? fieldInputs(error.field) : [];
  if (!inputs.length) return null;
  const message = document.createElement('p');
  message.className = 'ui-error field-error';
  message.id = `field-error-${String(error.field).replace(/[^a-zA-Z]/g, '-')}`;
  message.textContent = FIELD_ERRORS[error.field] ?? '이 값을 확인하세요.';
  const last = inputs.at(-1);
  (last.closest('.ui-field, .ui-check') ?? last.parentElement).append(message);
  for (const input of inputs) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', message.id);
  }
  return inputs[0];
}
form.addEventListener('input',updateSetupSummary);
form.onsubmit = (e) => {
  e.preventDefault();
  const setup=setupFromForm();
  try{normalizeSetup(setup);}catch(error){
    validationShown=true;showError(error);
    const input=markFieldError(error);
    if(input){input.closest('details')?.setAttribute('open','');input.focus();}
    else form.querySelector('details').open=true;
    return;
  }
  if (snapshot.state === "paused")
    confirm(() => command("replace-current", setup));
  else command("start", setup);
};
$("review").onclick = () => {
  viewingRecord = true;
  $("table").inert = false;
  $("game").hidden = false;
  document.body.classList.add('has-game');
  if(frameId!==snapshot.gameId || !$("table").getAttribute('src')) {
    frameId=snapshot.gameId;
    $("table").src=`/table?${new URLSearchParams({appGame:snapshot.gameId,epoch:snapshot.gameEpoch,terminal:'1'})}`;
  }
};
$("study").onclick = async () => {
  const tab = window.open("about:blank", "_blank");
  try {
    // `/api/study`는 요청 안에서 ensureStudyService를 끝까지 돈다. 콜드 기동은
    // 서버 쪽 COLD_START_MS(POSIX 60s, Windows 120s)까지 쓸 수 있고, Windows는
    // attach 경로조차 ACL 증명이 동기 PowerShell 자식이라 27–35s가 걸린 실측이
    // 있다. 10s 기본값은 그 일을 항상 중도 포기해 빈 탭만 닫았다.
    const result = await api("/api/study", { method: "POST", timeoutMs: 150000 });
    if (tab) {
      tab.opener = null;
      tab.location = result.url;
    } else throw new Error("학습 창을 열려면 팝업을 허용하세요.");
  } catch (e) {
    tab?.close();
    showError(e);
  }
};
for(const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close',syncTableInert);
new MutationObserver(syncTableInert).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
form.onchange();
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
  } catch (e) {
    showError(e);
  } finally {
    if (!commands.pending) pauseLock = null;
    busy = false;
    render();
    if (snapshot?.state === "paused") openPauseMenu();
  }
}
async function roomOp(op, extra = {}) {
  const result=await api("/api/room", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...extra }),
  });
  await refresh();
  return result;
}
$("room-open")?.addEventListener("click", () => roomOp("open", {
  hostName: $("host-name")?.value || "호스트",
  totalSeats: Number($("total-seats")?.value || 6),
  actionTimeoutSec: Number($("action-timeout")?.value || 60),
}));
$("room-rotate")?.addEventListener("click", () => roomOp("rotate-code"));
$("live-room-rotate")?.addEventListener("click", () => roomOp("rotate-code").catch(showError));
$("room-close")?.addEventListener("click", () => roomOp("close"));
$("join-copy").addEventListener("click", async () => {
  const link = snapshot?.room?.links?.[0];
  if (!link) return;
  const result = await copyText(link, { fallback: $("join-copy-fallback") });
  $("join-copy-status").textContent = result === "copied" ? "링크를 복사했어요." : result === "selected" ? "선택된 링크를 복사해 전달하세요." : "복사하지 못했어요. 위 링크를 직접 전달하세요.";
});
await recoverCommand();
setInterval(() => {
  if (!busy)
    void (commands.pending ? recoverCommand() : refresh().catch(error=>{if(++refreshFailures>=3){$("status").textContent="로비 재접속 중…";showError(error);}}));
}, 1000);
