#!/usr/bin/env node
// 실제 game-loop 경로에서 Codex Sol/low 플레이어의 지연을 관측하는 **선택 실행** 러너(#312).
//
// 무엇을 하는가: 새 임시 store에 legacy game-loop(`--player-runtime codex --opponent-runtime llm`)를 띄운다. 그러면 앱이 여는
// 것과 같은 loop가 AI 좌석 수만큼 시작 warmup을 병렬로 열고, 결정·코치·리뷰를 돌린다. 인간 좌석은 relay가 쓰는
// `ui-snapshot.json`으로 차례를 읽고 relay의 `POST /api/action`으로 check(가능하면) 또는 fold만 둔다. 게임이 끝나면 그 store에 `player-latency-report`를
// 돌리고 측정 전에 고정한 판정 O0–O5를 붙여 JSON 하나로 남긴다.
//
// 지키는 규칙:
//   - 기본 실행은 계획만 출력하고 아무것도 띄우지 않는다. 실제 실행은 `--live`일 때만이다.
//   - store는 리포 밖에 아직 없는 경로여야 하고 러너가 배타적으로 만든다. 출력 파일 셋도 spawn 전에 배타 생성한다.
//     실제 store·이전 증거를 건드리지 않는다. relay 포트는 항상 임시 포트(`--port 0`)다.
//   - 인간 좌석 말고는 아무것도 대신하지 않는다. 결정 실패(`recovery_required`·`unsafe`)·halt는 관측 결과로 기록하고
//     `--retry-decision` 재시도를 하지 않는다(#312: 무조건 retry·자동 check/fold로 해결하지 않는다).
//   - 사람 차례는 토큰 없이 relay가 원자 교체로 쓰는 `ui-snapshot.json`에서 읽는다. 세션 토큰은 사람 차례의 POST에만 싣고,
//     보낼 때마다 lock.json·loop-state가 가리키는 relay가 기록된 identity로 살아 있고 그 포트의 listener인지 다시 확인한다.
//   - 실제 실행은 macOS·Linux만이다. Windows의 SIGTERM은 loop의 정지 핸들러를 거치지 않고 프로세스를 끝낸다.
//   - 신호는 이 러너가 띄운 loop pid 하나에만, SIGTERM 한 번 보낸다. loop가 SIGTERM 핸들러를 설치한 뒤(세션 loop-state가
//     생긴 뒤)에만 보낸다. 정해진 시간 안에 끝나지 않으면 SIGKILL 없이 종료 미확인으로 기록하고 store를 그대로 둔다.
//   - loop가 끝난 뒤 그 store의 학습 서비스만 공식 경로(`inspectStudyService`→`stopStudyService`)로 정지한다. relay가 살아
//     있으면 기록만 한다.
//   - 출력에는 결정 id·세션 id·토큰·프롬프트·응답 원문이 없다. loop.log에서는 허용한 필드만 투영한다. 보존된 store와
//     loop stdout·stderr 파일은 원시 증거라 공유 산출물이 아니다.
// 이 관측은 표본이다. 분포 보장·운영 안정성의 인증이 아니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ownedIdentityStatus, serverProcessStartTime } from '../engine/state.js';
import { createListenerOwnedBy } from './listener-ownership.js';
import { buildLatencyReport, formatSignature, projectCallCategory, projectCallCode, projectTiming, WARMUP_PURPOSES } from './player-latency-report.js';
import { RUNTIME_TABLE } from './player-runtime.js';
import { inspectStudyService, stopStudyService } from './study-service.js';

export const OBSERVATION_SCHEMA = 'player-latency-observation/1';
export const OBSERVATION_LIMITS = Object.freeze({
  defaultHands: 20, maxHands: 60,
  defaultAi: 5, maxAi: 8,
  defaultMaxPlayerCalls: 400, maxMaxPlayerCalls: 2000,
  defaultBudgetMs: 60 * 60_000, maxBudgetMs: 3 * 60 * 60_000,
  defaultBootTimeoutMs: 10 * 60_000, maxBootTimeoutMs: 30 * 60_000,
  minMs: 100,
  pollMs: 250, stopGraceMs: 120_000, seatAttempts: 20, requestTimeoutMs: 2_000,
  failureList: 50,
});
// 판정 기준(설계 §3.1·§9, 측정 전 고정). 60초 초과 시작 warmup은 위반이 아니라 건수·구간 보고 대상이다.
export const OBSERVATION_CRITERIA = Object.freeze({
  warmupReportMs: 60_000, warmupCapMs: 120_000, decisionSoftMs: 25_000, decisionSoftRatio: 0.05, decisionHardMs: 300_000,
  runtime: 'codex', playerModel: /^gpt-\d{1,3}(?:\.\d{1,3})?-sol$/,
});
export const PACES = Object.freeze(['instant', 'fast', 'normal', 'slow']);
const OPTION_KEYS = Object.freeze(['hands', 'ai', 'pace', 'maxPlayerCalls', 'budgetMs', 'bootTimeoutMs']);
const CLOSED_CONFLICTS = new Set(['STALE_DECISION', 'DECISION_CLOSED', 'NOT_YOUR_TURN']);
const LEGALITY = new Set(['illegal_action', 'response_format']);
const NON_TRANSPORT = new Set(['termination', ...LEGALITY]);
const CAVEATS = Object.freeze([
  '표본은 관측이다. 분포 보장·운영 안정성의 증명이 아니다. 같은 시작 묶음의 warmup은 서로 독립이 아니다.',
  'turn 구간은 CLI가 보고한 이벤트 사이의 관측값이다(provider 대기의 대리값, 직접 측정 아님).',
  '호스트 부하(다른 프로세스)는 통제하지 않았다. 시작·끝 loadavg와 다른 codex 프로세스 수를 싣는다.',
  '인간 좌석은 자동 check/fold다. 실제 사람 게임과 팟 구성·결정 맥락 분포가 다를 수 있다. 앱이 관리하는 실행(managed)이 아니라 legacy loop다.',
  '--max-player-calls는 완료된 플레이어 호출 수에 대한 정지 임계값이다. 이미 시작된 호출이 더 끝날 수 있고 probe·상위 호출은 세지 않는다.',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_LOOP = path.join(ROOT, 'tools', 'game-loop.js');

function observeError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export function validateObservationOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !OPTION_KEYS.includes(key))) {
    throw observeError('BAD_ARGS', `${OPTION_KEYS.join('·')}만 받습니다.`);
  }
  const L = OBSERVATION_LIMITS;
  const pick = (key, fallback, min, max) => {
    const value = raw[key] === undefined ? fallback : raw[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw observeError('BAD_ARGS', `${key}는 ${min}~${max} 정수입니다.`);
    return value;
  };
  const pace = raw.pace === undefined ? 'normal' : raw.pace;
  if (!PACES.includes(pace)) throw observeError('BAD_ARGS', `pace는 ${PACES.join('|')}입니다.`);
  return {
    hands: pick('hands', L.defaultHands, 1, L.maxHands),
    ai: pick('ai', L.defaultAi, 1, L.maxAi),
    pace,
    maxPlayerCalls: pick('maxPlayerCalls', L.defaultMaxPlayerCalls, 1, L.maxMaxPlayerCalls),
    budgetMs: pick('budgetMs', L.defaultBudgetMs, L.minMs, L.maxBudgetMs),
    bootTimeoutMs: pick('bootTimeoutMs', L.defaultBootTimeoutMs, L.minMs, L.maxBootTimeoutMs),
  };
}

/** game-loop에 넘기는 인자. 런타임·상대·포트는 고정이다. */
export function loopArgs(options, storeDir) {
  const o = validateObservationOptions(options);
  return ['--store-dir', storeDir, '--ai', String(o.ai), '--player-runtime', 'codex', '--opponent-runtime', 'llm',
    '--hands', String(o.hands), '--pace', o.pace, '--port', '0'];
}

export function observationPlan(options) {
  const o = validateObservationOptions(options);
  return {
    options: o,
    loopArgs: loopArgs(o, '<store-dir>'),
    expectedStartWarmups: o.ai,
    playerCallStopThreshold: o.maxPlayerCalls,
    criteria: { ...OBSERVATION_CRITERIA, playerModel: String(OBSERVATION_CRITERIA.playerModel) },
  };
}

// 경로가 존재하는 가장 깊은 조상의 실제 경로 + 나머지. macOS의 /tmp → /private/tmp 같은 링크를 풀어 리포 포함 여부를 본다.
function realish(target) {
  let base = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(base), ...rest.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(base);
      if (parent === base) return target;
      rest.push(path.basename(base));
      base = parent;
    }
  }
}

const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  // '..name' 같은 이름은 부모가 아니다. 부모는 정확히 '..' 또는 '..' + 구분자로 시작하는 경로다.
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const lstatOrNull = (file) => {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/** 출력 파일 이름들. JSON과 loop의 stdout·stderr. */
export const outputFiles = (out) => ({ json: out, stdout: `${out}.loop.stdout`, stderr: `${out}.loop.stderr` });

/** 전제 검사(읽기만 한다). 거부하면 아무것도 만들거나 띄우지 않는다. 실제 소유는 `claimTargets`가 배타 생성으로 얻는다. */
export function checkTargets({ storeDir, out }, { repoRoot = ROOT } = {}) {
  if (typeof storeDir !== 'string' || !path.isAbsolute(storeDir)) throw observeError('BAD_ARGS', '--store-dir는 절대 경로입니다.');
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw observeError('BAD_ARGS', '--out은 절대 경로입니다.');
  const store = path.resolve(storeDir);
  const output = path.resolve(out);
  const repo = realish(path.resolve(repoRoot));
  if (inside(realish(store), repo)) throw observeError('STORE_IN_REPO', `${store}는 리포 안입니다.`);
  if (lstatOrNull(store)) throw observeError('STORE_EXISTS', `${store}가 이미 있습니다. 실행마다 새 경로를 씁니다.`);
  if (!lstatOrNull(path.dirname(store))?.isDirectory()) throw observeError('BAD_ARGS', '--store-dir의 부모 디렉터리가 없습니다.');
  if (inside(realish(output), realish(store))) throw observeError('BAD_ARGS', '--out은 store 밖이어야 합니다.');
  if (!lstatOrNull(path.dirname(output))?.isDirectory()) throw observeError('BAD_ARGS', '--out의 디렉터리가 없습니다.');
  for (const file of Object.values(outputFiles(output))) {
    if (lstatOrNull(file)) throw observeError('OUT_EXISTS', `${file}가 이미 있습니다.`);
  }
  return { storeDir: store, out: output };
}

/**
 * store를 비재귀 `mkdir`로, 출력 파일 셋을 `wx`로 배타 생성한다. 하나라도 실패하면 이번에 만든 것만 지우고 던진다
 * (이미 있던 파일은 지우거나 덮지 않는다). 돌려준 fd는 호출자가 닫는다.
 */
export function claimTargets({ storeDir, out }) {
  const files = outputFiles(out);
  const created = [];
  const fds = {};
  try {
    try { fs.mkdirSync(storeDir, { mode: 0o700 }); } catch (error) {
      throw error.code === 'EEXIST' ? observeError('STORE_EXISTS', `${storeDir}가 이미 있습니다.`) : error;
    }
    created.push(['dir', storeDir]);
    for (const key of ['stdout', 'stderr', 'json']) {
      try { fds[key] = fs.openSync(files[key], 'wx', 0o600); } catch (error) {
        throw error.code === 'EEXIST' ? observeError('OUT_EXISTS', `${files[key]}가 이미 있습니다.`) : error;
      }
      created.push(['file', files[key]]);
    }
    return fds;
  } catch (error) {
    for (const fd of Object.values(fds)) { try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } }
    for (const [kind, target] of created.reverse()) {
      try { if (kind === 'dir') fs.rmdirSync(target); else fs.unlinkSync(target); } catch { /* 남기면 운영자가 본다 */ }
    }
    throw error;
  }
}

/** 인간 좌석의 행동: check할 수 있으면 check, 아니면 fold. */
export function seatActionFor(legal) {
  return legal?.canCheck === true ? 'check' : 'fold';
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** `current.json`의 `sessionRel`로 정한 세션 디렉터리. 아직 없거나 형식이 틀리면 null. */
export function sessionDirOf(storeDir) {
  const current = readJsonOrNull(path.join(storeDir, '.session-store', 'current.json'));
  const rel = current?.sessionRel;
  if (typeof rel !== 'string' || !/^sessions\/[A-Za-z0-9-]{1,80}$/.test(rel)) return null;
  return path.join(storeDir, '.session-store', ...rel.split('/'));
}

/** loop.log의 이벤트 이름을 이어서 센다. 이름만 보고 나머지 필드는 버린다. 쓰는 중인 마지막 줄은 다음 읽기로 미룬다. */
export function createEventCounter() {
  let file = null;
  let offset = 0;
  let rest = '';
  const counts = {};
  const reset = () => { offset = 0; rest = ''; for (const key of Object.keys(counts)) delete counts[key]; };
  return {
    read(target) {
      if (target !== file) { file = target; reset(); }
      let fd;
      try { fd = fs.openSync(target, 'r'); } catch { return { ...counts }; }
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) reset();
        if (size > offset) {
          const buffer = Buffer.alloc(size - offset);
          const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
          offset += read;
          const lines = (rest + buffer.subarray(0, read).toString('utf8')).split('\n');
          rest = lines.pop();
          for (const line of lines) {
            let event;
            try { event = JSON.parse(line)?.event; } catch { event = null; }
            if (typeof event === 'string' && /^[a-z0-9-]{1,64}$/.test(event)) counts[event] = (counts[event] ?? 0) + 1;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      return { ...counts };
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const short = (value, max = 64) => (typeof value === 'string' && value.length <= max ? value : null);

/**
 * loop.log 최종 판독(허용 필드만). 이벤트 이름별 수, `runtime-models`, 서로 다른 결정 수(id는 내부 대응에만),
 * 실패·임계 초과 플레이어 호출의 위치 목록, timing 미관측 수.
 */
export function scanLoopLog(file, { limit = OBSERVATION_LIMITS.failureList } = {}) {
  const out = { eventCounts: {}, runtimeModels: null, decisions: 0, failures: [], failuresOmitted: 0, rejections: [], rejectionsOmitted: 0,
    timingMissing: 0, unparsable: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const decisions = new Set();
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { out.unparsable += 1; continue; }
    const event = short(row?.event);
    if (!event || !/^[a-z0-9-]{1,64}$/.test(event)) continue;
    out.eventCounts[event] = (out.eventCounts[event] ?? 0) + 1;
    if (event === 'runtime-models') {
      const tier = (value) => ({ runtime: short(value?.runtime), model: short(value?.model, 128), source: short(value?.source) });
      out.runtimeModels = { player: tier(row.player), upper: tier(row.upper) };
    }
    if (event === 'player-decision-rejected') {
      // 거절의 위치만 싣는다(시각·코드·세부 분류·호출 번호). 회신 원문(raw)·투영·결정 id는 버린다.
      if (out.rejections.length < limit) {
        out.rejections.push({ at: short(row.at, 40), code: short(row.code), detail: short(row.detail), callNo: Number.isSafeInteger(row.callNo) ? row.callNo : null });
      } else out.rejectionsOmitted += 1;
    }
    if (event !== 'player-call') continue;
    if (row.purpose === 'decision' && typeof row.decisionId === 'string') decisions.add(row.decisionId);
    // 구간 시각과 실패 위치(turn 종료 종류·닫힌 오류 분류·exit 코드·신호)는 집계 도구와 같은 허용 목록이다.
    const timing = projectTiming(row.timing);
    if (!timing) out.timingMissing += 1;
    const elapsedMs = finite(row.elapsedMs);
    const over = row.purpose === 'decision' ? elapsedMs !== null && elapsedMs > OBSERVATION_CRITERIA.decisionSoftMs
      : elapsedMs !== null && elapsedMs > OBSERVATION_CRITERIA.warmupReportMs;
    if (row.code !== 'RESPONSE_RECEIVED' || over) {
      if (out.failures.length < limit) {
        // 호출 종류·code·분류는 닫힌 목록으로만 싣는다(목록 밖은 'other').
        const purpose = row.purpose == null ? null : ['decision', ...WARMUP_PURPOSES].includes(row.purpose) ? row.purpose : 'other';
        out.failures.push({ at: short(row.at, 40), purpose, code: projectCallCode(row.code), category: projectCallCategory(row.category), elapsedMs, timing });
      } else out.failuresOmitted += 1;
    }
  }
  out.decisions = decisions.size;
  return out;
}

/** loop-state의 결정 metrics 요약(결정 단위, 교정 호출 포함 elapsed). id는 싣지 않는다. */
export function summarizeMetrics(state) {
  const rows = Array.isArray(state?.metrics) ? state.metrics : null;
  if (!rows) return null;
  // 임계 초과는 원래 값(단조 시계 차, 소수 ms)으로 센다. 반올림은 표시값(중앙값·p95·최대)에만 한다.
  const elapsed = rows.map((row) => finite(row?.elapsedMs)).filter((value) => value !== null).sort((a, b) => a - b);
  const at = (p) => (elapsed.length ? Math.round(elapsed[Math.min(elapsed.length - 1, Math.max(0, Math.ceil(p * elapsed.length) - 1))]) : null);
  const outcomes = {};
  const runtimes = {};
  for (const row of rows) {
    const outcome = short(row?.outcome) ?? 'unknown';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const runtime = short(row?.runtime) ?? 'unknown';
    runtimes[runtime] = (runtimes[runtime] ?? 0) + 1;
  }
  return {
    count: rows.length, withElapsed: elapsed.length, dropped: Number.isSafeInteger(state.metricsDropped) ? state.metricsDropped : null,
    medianMs: at(0.5), p95Ms: at(0.95), maxMs: elapsed.length ? Math.round(elapsed.at(-1)) : null,
    overSoft25s: elapsed.filter((value) => value > OBSERVATION_CRITERIA.decisionSoftMs).length,
    overHard300s: elapsed.filter((value) => value > OBSERVATION_CRITERIA.decisionHardMs).length,
    outcomes, runtimes,
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);
  return { n: sorted.length, median: at(0.5), max: sorted.at(-1) ?? null };
}

/**
 * 사람 차례 판독(토큰 없음). relay가 게시를 커밋할 때마다 원자 교체로 쓰는 세션의 `ui-snapshot.json`에서 현재 결정과
 * 호스트 view의 합법 행동만 읽는다. 쓰는 중이거나 형식이 틀리면 null(다음 주기에 다시 본다).
 */
export function readHumanTurn(sessionDir) {
  const raw = sessionDir ? readJsonOrNull(path.join(sessionDir, 'ui-snapshot.json')) : null;
  const legal = raw?.view?.legal;
  const decision = raw?.decision ?? (legal ? { decisionId: legal.decisionId, toAct: legal.toAct ?? 'user' } : null);
  if (typeof decision?.decisionId !== 'string' || typeof decision.toAct !== 'string') return null;
  // 합법 행동은 같은 결정의 것일 때만 믿는다. 없으면 행동을 정하지 않는다.
  const sameLegal = legal && legal.decisionId === decision.decisionId;
  return { decisionId: decision.decisionId, toAct: decision.toAct, canCheck: sameLegal ? legal.canCheck === true : null };
}

/**
 * 토큰을 실은 요청의 전송 경계(설계 §9.7·§10). 요청마다 다음을 확인한 뒤에만 보낸다.
 *   1) 세션 lock.json의 relay 기록(serverPid·serverStartTime·port·sessionToken)이 loop-state의 port·sessionToken과 같다.
 *   2) 그 pid가 그 포트의 listener다(OS 조회, 비동기).
 *   3) 조회를 기다린 뒤 pid가 기록된 시작 시각으로 살아 있다(identity, 동기 OS 조회).
 *   4) 그 뒤 lock·loop-state를 다시 읽어 바이트가 처음과 같고 정지 중이 아니다. 이 마지막 확인과 같은 동기 구간에서
 *      `send`를 부른다(identity 조회 동안 다른 프로세스가 바꾼 바인딩도 잡는다).
 * 남는 경쟁: 마지막 관찰 뒤 connect까지 사이에 relay가 포트를 놓고 다른 프로세스가 묶는 경우는 막지 못한다
 * (tools/relay-access.js와 같은 잔여). 캐시는 없다.
 */
export function createRelayGuard({ identityStatus, listenerOwnedBy, requestTimeoutMs = OBSERVATION_LIMITS.requestTimeoutMs,
  isStopping = () => false } = {}) {
  const denied = {};
  const deny = (reason) => { denied[reason] = (denied[reason] ?? 0) + 1; return null; };
  const read = (sessionDir) => {
    let lockRaw;
    let stateRaw;
    try {
      lockRaw = fs.readFileSync(path.join(sessionDir, 'lock.json'), 'utf8');
      stateRaw = fs.readFileSync(path.join(sessionDir, 'loop-state.json'), 'utf8');
    } catch { return { reason: 'LOCK_MISSING' }; }
    let lock;
    let state;
    try { lock = JSON.parse(lockRaw); state = JSON.parse(stateRaw); } catch { return { reason: 'LOCK_BAD' }; }
    if (!Number.isSafeInteger(lock?.serverPid) || lock.serverPid <= 0 || typeof lock.serverStartTime !== 'string'
      || !Number.isSafeInteger(lock.port) || typeof lock.sessionToken !== 'string') return { reason: 'LOCK_BAD' };
    if (lock.port !== state?.port || lock.sessionToken !== state?.sessionToken) return { reason: 'LOCK_STATE_MISMATCH' };
    return { lockRaw, stateRaw, lock };
  };
  return {
    /** 확인을 통과하면 `send({ port, sessionToken })`의 결과를, 아니면 null을 돌려준다. */
    async use(sessionDir, send) {
      if (isStopping()) return deny('STOPPING');
      const first = read(sessionDir);
      if (first.reason) return deny(first.reason);
      let owned = null;
      try { owned = await listenerOwnedBy(first.lock.serverPid, first.lock.port, { timeoutMs: requestTimeoutMs }); } catch { owned = null; }
      if (owned !== true) return deny(owned === false ? 'LISTENER_MISMATCH' : 'LISTENER_UNKNOWN');
      // 여기서부터 send까지 await가 없다. 마지막 OS 판독은 identity이고, 그 뒤 파일을 다시 읽어 바인딩이 그대로인지 본다.
      let status = 'unknown';
      try { status = identityStatus(first.lock.serverPid, first.lock.serverStartTime); } catch { status = 'unknown'; }
      if (status !== 'alive') return deny('IDENTITY_UNKNOWN');
      const last = read(sessionDir);
      if (last.reason) return deny(last.reason);
      if (last.lockRaw !== first.lockRaw || last.stateRaw !== first.stateRaw) return deny('CHANGED');
      if (isStopping()) return deny('STOPPING');
      return send({ port: last.lock.port, sessionToken: last.lock.sessionToken });
    },
    denied() { return { ...denied }; },
  };
}

/**
 * 인간 좌석 자동 응답(설계 §9.6). 사람 차례(`readHumanTurn`)에만, 결정마다 requestId와 행동을 한 번 정하고 같은 요청만
 * 다시 보낸다. 409 지난 결정·이미 접수는 닫는다. 그 밖의 실패는 같은 요청을 결정마다 `attempts`번까지 다시 보내고,
 * 넘으면 `stuck`이다. relay 확인을 통과하지 못해 보내지 못한 주기는 시도로 세지 않는다. 사람 차례를 처음 본 시각부터
 * 200(접수)까지를 "접수 확인 지연"으로 잰다. 요청은 한 번에 하나다.
 * `post(body)`는 보낸 응답 `{ status, body }`, 보내지 않았으면 null을 돌려준다(예외는 응답 없음).
 */
export function createSeatDriver({ now = Date.now, attempts = OBSERVATION_LIMITS.seatAttempts, post } = {}) {
  const closed = new Set();
  const pending = new Map();
  const stats = { check: 0, fold: 0, stale: 0, alreadyReceived: 0, actionErrors: 0, unsent: 0, acceptedMs: [] };
  let stuck = false;
  return {
    async tick(turn) {
      if (turn?.toAct !== 'user' || closed.has(turn.decisionId)) return;
      const id = turn.decisionId;
      if (!pending.has(id)) {
        if (turn.canCheck === null) return; // 같은 결정의 합법 행동이 아직 없다
        pending.set(id, { seenAt: now(), tries: 0, action: seatActionFor({ canCheck: turn.canCheck }),
          body: JSON.stringify({ decisionId: id, requestId: randomUUID(), action: seatActionFor({ canCheck: turn.canCheck }) }) });
      }
      const entry = pending.get(id);
      let response;
      try {
        response = await post(entry.body);
      } catch {
        response = { status: null, body: null };
      }
      if (response === null) { stats.unsent += 1; return; }
      if (response.status === 200) {
        closed.add(id);
        pending.delete(id);
        stats[entry.action] += 1;
        stats.acceptedMs.push(now() - entry.seenAt);
        return;
      }
      const code = response.body?.code;
      if (response.status === 409 && (CLOSED_CONFLICTS.has(code) || code === 'ACTION_ALREADY_RECEIVED')) {
        closed.add(id);
        pending.delete(id);
        if (code === 'ACTION_ALREADY_RECEIVED') stats.alreadyReceived += 1;
        else stats.stale += 1;
        return;
      }
      stats.actionErrors += 1;
      entry.tries += 1;
      if (entry.tries >= attempts) stuck = true;
    },
    get stuck() { return stuck; },
    summary() {
      return { check: stats.check, fold: stats.fold, stale: stats.stale, alreadyReceived: stats.alreadyReceived,
        actionErrors: stats.actionErrors, unsent: stats.unsent, acceptedMs: distribution(stats.acceptedMs) };
    },
  };
}

/** relay `/api/action`에 본문을 보낸다. 응답 본문 읽기까지 deadline과 취소를 적용하고, 재지정(redirect)은 따르지 않는다. */
export function createActionPost({ fetchImpl = fetch, requestTimeoutMs = OBSERVATION_LIMITS.requestTimeoutMs, cancel = null } = {}) {
  return async ({ port, sessionToken }, body) => {
    const signal = cancel ? AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), cancel]) : AbortSignal.timeout(requestTimeoutMs);
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/action?token=${encodeURIComponent(sessionToken)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, body: parsed };
  };
}

const sumOf = (list, pick) => list.reduce((total, item) => total + (pick(item) ?? 0), 0);
const failedOf = (groups, match) => sumOf(groups, (group) => Object.entries(group.outcomes?.failed ?? {})
  .filter(([category]) => match(category)).reduce((total, [, count]) => total + count, 0));

/**
 * 판정 O0–O5(설계 §3.1·§9). 위반(O1–O5)은 실행 건전성(O0)과 무관하게 센다. `pass`는 여섯이 모두 참일 때만이다.
 * `run`은 러너가 기록한 실행 정보(loop.log 판독·metrics 요약 포함), `latency`는 그 store의 `player-latency-report/1`(없으면 null)이다.
 */
export function evaluateObservation({ run, latency, options }) {
  const C = OBSERVATION_CRITERIA;
  const groups = latency?.groups ?? [];
  const warm = groups.filter((group) => group.kind === 'start-warmup');
  const otherWarm = groups.filter((group) => group.kind !== 'start-warmup' && group.kind !== 'decision');
  const decisionGroups = groups.filter((group) => group.kind === 'decision');
  const metrics = run.metrics ?? null;
  const rm = run.runtimeModels ?? null;
  const isSol = (model) => C.playerModel.test(String(model));

  const o0Reasons = [];
  if (run.exit?.code !== 0 || run.exit?.signal) o0Reasons.push('LOOP_EXIT');
  if (run.finalPhase !== 'done') o0Reasons.push('NOT_DONE');
  if (run.handsCompleted !== options.hands) o0Reasons.push('HANDS_INCOMPLETE');
  if (run.stopReason !== null) o0Reasons.push(`STOP_${run.stopReason}`);
  if (run.terminationConfirmed !== true) o0Reasons.push('TERMINATION_UNCONFIRMED');
  if (run.exit?.error) o0Reasons.push('SPAWN_FAILED');
  if (run.runnerErrors?.length) o0Reasons.push('RUNNER_ERROR');
  if (run.childErrors?.length) o0Reasons.push('CHILD_ERROR');
  if (run.study?.ok !== true) o0Reasons.push('STUDY_CLEANUP');
  if (run.relay?.alive !== false) o0Reasons.push('RELAY_NOT_CONFIRMED_DEAD');
  // §9.1 표본 적격: 실제로 codex Sol 플레이어와 codex 상위가 선택된 실행만 대상 표본이다.
  if (rm?.player?.runtime !== C.runtime || !isSol(rm?.player?.model) || rm?.upper?.runtime !== C.runtime
    || run.runtimes?.player !== C.runtime || run.runtimes?.upper !== C.runtime
    || groups.some((group) => group.runtime !== C.runtime || !isSol(group.model))) o0Reasons.push('NOT_TARGET_RUNTIME');
  // §9.4 완전성: 건너뛴 줄·응답 지연 결측·metrics 폐기·결정 수 불일치는 위반 0으로 환산하지 않는다.
  if (!latency) o0Reasons.push('NO_LATENCY_REPORT');
  else if (Object.values(latency.skipped ?? {}).some((value) => value !== 0)
    || groups.some((group) => group.answeredMs?.n !== group.outcomes?.answered)) o0Reasons.push('LATENCY_INCOMPLETE');
  if (!metrics || metrics.dropped !== 0 || metrics.withElapsed !== metrics.count || metrics.count !== run.decisions) o0Reasons.push('METRICS_INCOMPLETE');
  if (run.logUnparsable > 0) o0Reasons.push('LOG_UNPARSABLE');

  const o1 = { terminationFailures: failedOf(groups, (category) => category === 'termination'), runnerUnconfirmed: run.terminationConfirmed !== true };
  o1.pass = o1.terminationFailures === 0 && !o1.runnerUnconfirmed;

  const warmMax = warm.reduce((max, group) => Math.max(max, group.answeredMs?.max ?? 0), 0);
  const o2 = {
    calls: sumOf(warm, (group) => group.calls), expected: options.ai,
    answered: sumOf(warm, (group) => group.outcomes?.answered),
    timeouts: sumOf(warm, (group) => group.outcomes?.timeout),
    maxMs: warm.length ? warmMax : null,
    over60s: sumOf(warm, (group) => group.over?.over60s),
    over60sCalls: (run.failures ?? []).filter((call) => call.purpose === 'start-warmup' && (call.elapsedMs ?? 0) > C.warmupReportMs),
  };
  o2.pass = o2.calls === options.ai && o2.answered === options.ai && o2.timeouts === 0 && (o2.maxMs ?? 0) <= C.warmupCapMs;

  // §9.3 O3는 결정 단위다: metrics의 elapsedMs는 교정 호출을 포함한 결정 전체 대기다. metrics는 적용에 성공한 결정만
  // 싣는다. 복구 대기로 끝난 결정은 loop-state의 pendingDecision.elapsedMs(그때까지의 관측값, 하한)로 따로 센다.
  const unresolved = run.finalPending ? { status: run.finalPending.status, elapsedMs: run.finalPending.elapsedMs ?? null } : null;
  const pendingMs = unresolved?.elapsedMs ?? null;
  const o3 = {
    decisions: metrics?.count ?? 0,
    unresolved,
    overSoft25s: (metrics?.overSoft25s ?? 0) + (pendingMs !== null && pendingMs > C.decisionSoftMs ? 1 : 0),
    overHard300s: (metrics?.overHard300s ?? 0) + (pendingMs !== null && pendingMs > C.decisionHardMs ? 1 : 0),
    medianMs: metrics?.medianMs ?? null, p95Ms: metrics?.p95Ms ?? null, maxMs: metrics?.maxMs ?? null,
    callTimeouts: sumOf(decisionGroups, (group) => group.outcomes?.timeout),
    softWaits: run.eventCounts?.['player-soft-wait'] ?? 0,
    outcomes: metrics?.outcomes ?? {},
  };
  const judged = o3.decisions + (unresolved ? 1 : 0);
  o3.softRatio = judged ? Math.round((o3.overSoft25s / judged) * 10_000) / 10_000 : null;
  o3.pass = o3.decisions > 0 && unresolved === null && o3.callTimeouts === 0 && o3.overHard300s === 0
    && o3.overSoft25s / judged <= C.decisionSoftRatio;

  const o4 = {
    transportFailures: failedOf(groups, (category) => !NON_TRANSPORT.has(category)),
    otherWarmupTimeouts: sumOf(otherWarm, (group) => group.outcomes?.timeout),
    otherWarmups: otherWarm.map((group) => ({ kind: group.kind, calls: group.calls, answered: group.outcomes?.answered })),
    loopHalt: run.finalHalt ?? null,
    pendingDecision: run.finalPending ?? null,
    stopForFailure: ['DECISION_FAILURE', 'HALT'].includes(run.stopReason),
  };
  o4.pass = o4.transportFailures === 0 && o4.otherWarmupTimeouts === 0 && o4.loopHalt === null && o4.pendingDecision === null && !o4.stopForFailure;

  // §9.2 O5 합법성(#297 K2): 거절된 회신 0. 제품의 자동 교정이 성공해도 최초 거절을 지우지 않는다.
  const o5 = {
    decisionRejected: run.eventCounts?.['player-decision-rejected'] ?? 0,
    illegalAction: failedOf(groups, (category) => category === 'illegal_action'),
    responseFormat: failedOf(groups, (category) => category === 'response_format'),
  };
  o5.rejections = run.rejections ?? [];
  o5.pass = o5.decisionRejected === 0 && o5.illegalAction === 0 && o5.responseFormat === 0;

  const o0 = { pass: o0Reasons.length === 0, reasons: o0Reasons, models: [...new Set(groups.map((group) => `${group.runtime}/${group.model}`))].sort() };
  return { pass: o0.pass && o1.pass && o2.pass && o3.pass && o4.pass && o5.pass, o0, o1, o2, o3, o4, o5 };
}

/** 측정 SHA: 러너의 리포 루트가 git 작업 트리의 최상위일 때만 HEAD. 아니면(예: archive 사본 아래) null. */
export function gitShaOf(root, exec) {
  const top = exec('git', ['rev-parse', '--show-toplevel']);
  if (top === null || realish(top) !== realish(root)) return null;
  const sha = exec('git', ['rev-parse', 'HEAD']);
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function defaultEnvironment() {
  const exec = (command, args) => {
    try { return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
    catch { return null; }
  };
  return {
    sha: () => gitShaOf(ROOT, exec),
    codexVersion: () => exec('codex', ['--version']),
    loadavg: () => os.loadavg().map((value) => Math.round(value * 100) / 100),
    // 관측만 한다: 명령줄에 codex 네이티브 바이너리 경로가 있는 프로세스 수. 신호는 보내지 않는다.
    codexProcesses: () => {
      if (process.platform === 'win32') return null;
      const text = exec('ps', ['-axo', 'command']);
      return text === null ? null : text.split('\n').filter((line) => /\/vendor\/[^ ]*\/bin\/codex(?: |$)/.test(line)).length;
    },
  };
}

function defaultSpawnLoop(args, { stdout, stderr }) {
  return spawn(process.execPath, [GAME_LOOP, ...args], { cwd: ROOT, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true });
}

async function cleanupStudy(storeDir, { inspect, stop }) {
  try {
    const handle = await inspect(storeDir);
    if (handle?.status !== 'running') return { ok: true, status: short(handle?.status) ?? null, stopped: false };
    await stop(storeDir, { expectedInstanceId: handle.instanceId });
    return { ok: true, status: 'running', stopped: true };
  } catch (error) {
    return { ok: false, status: null, stopped: false, code: short(error?.code) ?? 'ERROR' };
  }
}

// relay가 아직 같은 프로세스(pid + 기록된 시작 시각)로 살아 있는가. 신호는 보내지 않는다.
function relayCheck(sessionDir, identityStatus) {
  const lock = sessionDir ? readJsonOrNull(path.join(sessionDir, 'lock.json')) : null;
  const pid = Number.isSafeInteger(lock?.serverPid) && lock.serverPid > 0 ? lock.serverPid : null;
  if (pid === null) return { recorded: false, alive: false };
  let status = 'unknown';
  try { status = identityStatus(pid, lock.serverStartTime); } catch { status = 'unknown'; }
  // 'dead'만 종료를 증명한다. 'unknown'(pid 재사용·판독 불가)은 살아 있다고도 죽었다고도 하지 않는다.
  return { recorded: true, alive: status === 'alive' ? true : status === 'dead' ? false : null, identity: status };
}

/** 실제 실행(`--live`)을 지원하는 플랫폼. Windows의 SIGTERM은 loop의 정지 핸들러를 거치지 않고 프로세스를 끝낸다. */
export const LIVE_PLATFORMS = Object.freeze(['darwin', 'linux']);

/**
 * 관측 1회. `targets`는 `checkTargets`를 통과한 값이다. 의존성(`deps`)은 시험용 주입점이다: spawnLoop·fetchImpl·now·sleep·
 * signal·identityStatus·listenerOwnedBy·inspectStudy·stopStudy·environment·stopSignal·readHumanTurn·writeReport·pollMs·stopGraceMs·
 * requestTimeoutMs.
 * spawn 뒤의 어떤 예외도 같은 정지 경로(핸들러 설치 확인 → SIGTERM 한 번 → 제한된 대기 → 미확인이면 unref)를 거친다.
 */
export async function observeOnce(rawOptions, targets, deps = {}) {
  const options = validateObservationOptions(rawOptions);
  const { storeDir } = targets;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // 신호는 소유한 ChildProcess 핸들로 보낸다. exit를 받은 뒤의 kill()은 아무 프로세스에도 닿지 않는다(pid 재사용 방지).
  const signal = deps.signal ?? ((child, name) => child.kill(name));
  const identityStatus = deps.identityStatus ?? ((pid, startTime) => ownedIdentityStatus(pid, startTime, serverProcessStartTime));
  const env = { ...defaultEnvironment(), ...(deps.environment ?? {}) };
  const pollMs = deps.pollMs ?? OBSERVATION_LIMITS.pollMs;
  const stopGraceMs = deps.stopGraceMs ?? OBSERVATION_LIMITS.stopGraceMs;
  const requestTimeoutMs = deps.requestTimeoutMs ?? OBSERVATION_LIMITS.requestTimeoutMs;

  const run = {
    startedAt: new Date(now()).toISOString(), finishedAt: null, sha: env.sha(), node: process.version, codexCli: env.codexVersion(),
    platform: `${process.platform}-${process.arch}`, options, storeDir,
    effort: { player: RUNTIME_TABLE.codex.playerArgs, upper: RUNTIME_TABLE.codex.upperArgs },
    loadavg: { start: env.loadavg(), end: null }, codexProcesses: { start: env.codexProcesses(), end: null },
    loopPid: null, loopStartTime: null, exit: null, finalPhase: null, handsCompleted: null, finalHalt: null, finalPending: null,
    stopReason: null, stopRequestedAt: null, stopSignalledAt: null, preHandler: false, terminationConfirmed: null,
    runnerErrors: [], childErrors: [], outputError: null,
    playingAfterMs: null, elapsedMs: null, playerCalls: 0, playerCallsAtStop: null,
    runtimes: null, runtimeModels: null, metrics: null, decisions: 0, eventCounts: {}, failures: [], failuresOmitted: 0,
    rejections: [], rejectionsOmitted: 0, timingMissing: 0, logUnparsable: 0, relayUnverified: {}, study: null, relay: null,
  };
  const fds = claimTargets(targets);
  const writeReport = deps.writeReport ?? ((fd, text) => {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0);
    fs.fsyncSync(fd);
  });
  const writeOut = (value) => writeReport(fds.json, `${JSON.stringify(value, null, 2)}\n`);
  // 예산은 spawn 직전부터 단조 시계로 잰다(loop 시작 시각 조회·manifest 쓰기 시간도 예산에 든다).
  const clock = deps.now ?? (() => performance.now());
  const startedAt = clock();
  let child;
  try {
    child = (deps.spawnLoop ?? defaultSpawnLoop)(loopArgs(options, storeDir), { stdout: fds.stdout, stderr: fds.stderr });
  } catch (error) {
    fs.closeSync(fds.json);
    throw error;
  } finally {
    fs.closeSync(fds.stdout);
    fs.closeSync(fds.stderr);
  }
  run.loopPid = child.pid ?? null;
  let exit = null;
  // spawn이 실패하면 Node는 pid를 두지 않고 'error'를 낸다. 그래서 spawn 실패는 이벤트 순서가 아니라 pid 부재로 판정한다.
  // pid가 있는 자식의 'error'(신호 전달 실패 등)는 'spawn' 이벤트 전에 와도 종료의 증거가 아니다 — 기록만 하고 실제 exit를 기다린다.
  const spawnFailed = child.pid === undefined;
  let spawned = false;
  const exited = new Promise((resolve) => {
    child.once('spawn', () => { spawned = true; });
    child.once('exit', (code, sig) => { exit ??= { code, signal: sig }; resolve(); });
    child.on('error', (error) => {
      if (!spawnFailed) {
        if (run.childErrors.length < 10) run.childErrors.push(short(error?.code) ?? 'ERROR');
        return;
      }
      exit ??= { code: null, signal: null, error: short(error?.code) ?? 'SPAWN_FAILED' };
      resolve();
    });
  });
  const cancel = new AbortController();
  let signalledAt = null;
  let stopAskedAt = null;
  const requestStop = (reason) => {
    if (run.stopReason !== null) return;
    run.stopReason = reason;
    run.stopRequestedAt = new Date(now()).toISOString();
    run.playerCallsAtStop = run.playerCalls;
    cancel.abort();
  };
  const runnerError = (error) => {
    if (run.runnerErrors.length < 10) run.runnerErrors.push(short(error?.code) ?? 'ERROR');
    requestStop('RUNNER_ERROR');
  };
  const onOperator = () => requestStop('OPERATOR_STOP');
  deps.stopSignal?.addEventListener('abort', onOperator, { once: true });
  if (deps.stopSignal?.aborted) onOperator();

  const counter = createEventCounter();
  const guard = createRelayGuard({ identityStatus, listenerOwnedBy: deps.listenerOwnedBy ?? createListenerOwnedBy(), requestTimeoutMs,
    isStopping: () => run.stopReason !== null });
  const postAction = createActionPost({ fetchImpl: deps.fetchImpl ?? fetch, requestTimeoutMs, cancel: cancel.signal });
  let sessionDir = null;
  const seat = createSeatDriver({ now, post: (body) => guard.use(sessionDir, (access) => postAction(access, body)) });
  let playing = false;
  let stateSeen = false;
  try {
    try { run.loopStartTime = run.loopPid ? serverProcessStartTime(run.loopPid) : null; } catch { run.loopStartTime = null; }
    // 러너가 비정상으로 죽어도 운영자가 loop를 확인할 수 있게 manifest를 먼저 남긴다(복구는 pid·시작 시각과 store의 loop.lock.d로).
    try {
      writeOut({ schema: OBSERVATION_SCHEMA, status: 'running', startedAt: run.startedAt, storeDir, loopPid: run.loopPid, loopStartTime: run.loopStartTime });
    } catch (error) { runnerError(error); }
    while (exit === null) {
      try {
        sessionDir ??= sessionDirOf(storeDir);
        const state = sessionDir ? readJsonOrNull(path.join(sessionDir, 'loop-state.json')) : null;
        if (state) stateSeen = true;
        if (sessionDir) {
          run.eventCounts = counter.read(path.join(sessionDir, 'loop.log'));
          run.playerCalls = run.eventCounts['player-call'] ?? 0;
        }
        if (run.stopReason === null) {
          const elapsed = clock() - startedAt;
          if (state?.halt) requestStop('HALT');
          else if (['recovery_required', 'unsafe'].includes(state?.pendingDecision?.status)) requestStop('DECISION_FAILURE');
          else if (run.playerCalls >= options.maxPlayerCalls) requestStop('CALL_CAP');
          else if (elapsed > options.budgetMs) requestStop('BUDGET');
          else if (!playing && elapsed > options.bootTimeoutMs) requestStop('BOOT_TIMEOUT');
          else if (seat.stuck) requestStop('SEAT_DRIVER_STUCK');
        }
        if (!playing && typeof state?.phase === 'string' && state.phase !== 'bootstrap') {
          playing = true;
          run.playingAfterMs = Math.round(clock() - startedAt);
        }
        if (run.stopReason === null && playing && state?.phase === 'playing') await seat.tick((deps.readHumanTurn ?? readHumanTurn)(sessionDir));
      } catch (error) {
        runnerError(error);
      }
      // await 뒤에는 exit를 다시 본다. 이미 끝난 loop에는 신호를 보내지 않는다.
      if (exit !== null) break;
      if (run.stopReason !== null) {
        stopAskedAt ??= clock();
        // §9.8: SIGTERM 핸들러는 bootstrap이 loop-state를 처음 쓰기 전에 설치된다. 그 전에는 신호를 미룬다.
        // spawn 확인('spawn' 이벤트) 전에도 미룬다 — 신호를 보낼 자식이 확정되지 않았다.
        if (signalledAt === null && stateSeen && spawned) {
          signalledAt = clock();
          run.stopSignalledAt = new Date(now()).toISOString();
          try { signal(child, 'SIGTERM'); } catch { /* 이미 끝났으면 exit가 온다 */ }
        }
        if (clock() - (signalledAt ?? stopAskedAt) > stopGraceMs) {
          run.preHandler = signalledAt === null;
          break;
        }
      }
      await Promise.race([exited, sleep(pollMs)]);
    }
  } finally {
    deps.stopSignal?.removeEventListener('abort', onOperator);
    // 종료 미확인이면 더 신호를 보내지 않는다. 러너가 그 자식 때문에 끝나지 못하는 일만 막는다.
    if (exit === null) child.unref();
  }

  run.terminationConfirmed = exit !== null;
  run.exit = exit;
  run.elapsedMs = Math.round(clock() - startedAt);
  run.relayUnverified = guard.denied();
  try {
    sessionDir ??= sessionDirOf(storeDir);
    const finalState = sessionDir ? readJsonOrNull(path.join(sessionDir, 'loop-state.json')) : null;
    run.finalPhase = short(finalState?.phase);
    run.handsCompleted = Number.isSafeInteger(finalState?.handNo) ? finalState.handNo : null;
    run.finalHalt = finalState?.halt ? (short(finalState.halt.code) ?? 'UNKNOWN') : null;
    const pendingDecision = finalState?.pendingDecision;
    run.finalPending = pendingDecision?.status
      ? { status: short(pendingDecision.status) ?? 'unknown', code: short(pendingDecision.code), category: short(pendingDecision.category),
        elapsedMs: finite(pendingDecision.elapsedMs) }
      : null;
    run.runtimes = finalState ? { player: short(finalState.playerRuntime), upper: short(finalState.upperRuntime) } : null;
    run.metrics = summarizeMetrics(finalState);
    if (sessionDir) {
      const scan = scanLoopLog(path.join(sessionDir, 'loop.log'));
      Object.assign(run, { eventCounts: scan.eventCounts, runtimeModels: scan.runtimeModels, decisions: scan.decisions,
        failures: scan.failures, failuresOmitted: scan.failuresOmitted, rejections: scan.rejections, rejectionsOmitted: scan.rejectionsOmitted,
        timingMissing: scan.timingMissing, logUnparsable: scan.unparsable });
      run.playerCalls = scan.eventCounts['player-call'] ?? 0;
    }
  } catch (error) {
    if (run.runnerErrors.length < 10) run.runnerErrors.push(short(error?.code) ?? 'ERROR');
  }
  if (run.terminationConfirmed) {
    run.study = await cleanupStudy(storeDir, { inspect: deps.inspectStudy ?? inspectStudyService, stop: deps.stopStudy ?? stopStudyService });
    run.relay = relayCheck(sessionDir, identityStatus);
  } else {
    run.study = { ok: false, status: null, stopped: false, code: 'LOOP_ALIVE' };
    run.relay = { recorded: null, alive: null, code: 'LOOP_ALIVE' };
  }

  let latency = null;
  let latencyError = null;
  try {
    latency = buildLatencyReport(storeDir);
  } catch (error) {
    latencyError = short(error?.code) ?? 'ERROR';
  }
  run.finishedAt = new Date(now()).toISOString();
  run.loadavg.end = env.loadavg();
  run.codexProcesses.end = env.codexProcesses();
  const report = {
    schema: OBSERVATION_SCHEMA,
    status: 'finished',
    run,
    seat: seat.summary(),
    latency,
    latencyError,
    criteria: evaluateObservation({ run, latency, options }),
    caveats: CAVEATS,
  };
  try {
    writeOut(report);
  } catch (error) {
    // 보고서를 파일에 남기지 못해도 호출자(main)가 stdout으로 낸다.
    run.outputError = short(error?.code) ?? 'ERROR';
  } finally {
    fs.closeSync(fds.json);
  }
  return report;
}

export function formatObservation(report) {
  const { run, criteria: c, seat } = report;
  const sec = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
  const lines = [
    `운영 경로 지연 관측 — ${run.startedAt} ~ ${run.finishedAt}, ${run.sha?.slice(0, 7) ?? 'SHA 없음'}, ${run.codexCli ?? 'codex ?'}`,
    `loop: exit ${JSON.stringify(run.exit)} · phase ${run.finalPhase} · 핸드 ${run.handsCompleted}/${run.options.hands} · 정지 사유 ${run.stopReason ?? '없음'} · 종료 확인 ${run.terminationConfirmed}${run.preHandler ? '(핸들러 설치 전)' : ''}`,
    `런타임 ${JSON.stringify(run.runtimeModels)} · effort ${JSON.stringify(run.effort)}`,
    `플레이어 호출 ${run.playerCalls}(정지 시 ${run.playerCallsAtStop ?? '-'}) · playing까지 ${sec(run.playingAfterMs)} · 경과 ${sec(run.elapsedMs)} · loadavg ${JSON.stringify(run.loadavg)} · 다른 codex ${JSON.stringify(run.codexProcesses)}`,
    `인간 좌석: check ${seat.check} · fold ${seat.fold} · 지난 결정 ${seat.stale} · 이미 접수 ${seat.alreadyReceived} · 오류 ${seat.actionErrors} · 미전송 ${seat.unsent} · 접수 확인 중앙 ${sec(seat.acceptedMs.median)} · 최대 ${sec(seat.acceptedMs.max)} · relay 미확인 ${JSON.stringify(run.relayUnverified)}`,
    `정리: 학습 서비스 ${JSON.stringify(run.study)} · relay ${JSON.stringify(run.relay)}`,
    `O0 건전성 ${c.o0.pass ? '참' : `거짓(${c.o0.reasons.join(',')})`} · 모델 ${c.o0.models.join(', ') || '-'}`,
    `O1 종료 ${c.o1.pass ? '참' : '거짓'} · O2 시작 warmup ${c.o2.pass ? '참' : '거짓'}(${c.o2.answered}/${c.o2.expected}, 최대 ${sec(c.o2.maxMs)}, 60초 초과 ${c.o2.over60s})`,
    `O3 결정 ${c.o3.pass ? '참' : '거짓'}(결정 ${c.o3.decisions}, 미해결 ${c.o3.unresolved ? JSON.stringify(c.o3.unresolved) : '없음'}, 중앙 ${sec(c.o3.medianMs)}, p95 ${sec(c.o3.p95Ms)}, 최대 ${sec(c.o3.maxMs)}, 25초 초과 ${c.o3.overSoft25s}, 호출 timeout ${c.o3.callTimeouts})`,
    `O4 실패 ${c.o4.pass ? '참' : '거짓'} · O5 합법성 ${c.o5.pass ? '참' : '거짓'}(거절 ${c.o5.decisionRejected})`,
    `판정: ${c.pass ? 'pass' : 'pass 아님'}`,
  ];
  // #312 진단: 응답 없는 플레이어 호출의 위치(어느 단계에서 어떻게 끝났나). 집계 보고서의 서명을 그대로 옮긴다.
  for (const group of report.latency?.groups ?? []) {
    for (const row of group.failureSignatures ?? []) lines.push(`응답 없음(${group.kind}): ${formatSignature(row)} ×${row.calls}`);
  }
  for (const caveat of report.caveats) lines.push(`주의: ${caveat}`);
  return lines.join('\n');
}

const USAGE = `사용법: node tools/observe-player-latency.js --store-dir <절대 경로> --out <절대 경로 .json> [--live]
  [--hands N] [--ai N] [--pace instant|fast|normal|slow] [--max-player-calls N] [--budget-ms N] [--boot-timeout-ms N] [--json]
  --live 없이 실행하면 계획만 출력하고 아무것도 띄우지 않는다. store는 리포 밖의 아직 없는 경로여야 한다.
  실제 실행은 macOS·Linux만 지원한다(Windows의 SIGTERM은 loop의 정지 핸들러를 거치지 않는다).
  종료 코드: 0 = pass · 3 = 실행했지만 pass 아님 · 2 = 인자·전제 오류 · 1 = 실행 오류(spawn 실패·종료 미확인·보고서 쓰기 실패)`;

export function parseObservationArgs(argv) {
  const parsed = { live: false, json: false, storeDir: null, out: null, options: {} };
  const numeric = { '--hands': 'hands', '--ai': 'ai', '--max-player-calls': 'maxPlayerCalls', '--budget-ms': 'budgetMs', '--boot-timeout-ms': 'bootTimeoutMs' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--store-dir' || arg === '--out' || arg === '--pace') {
      if (typeof value !== 'string' || value.startsWith('--')) throw observeError('BAD_ARGS', `${arg}에는 값이 필요합니다.`);
      if (arg === '--pace') parsed.options.pace = value;
      else parsed[arg === '--out' ? 'out' : 'storeDir'] = value;
      i += 1;
    } else if (Object.hasOwn(numeric, arg)) {
      if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) throw observeError('BAD_ARGS', `${arg}에는 정수가 필요합니다.`);
      parsed.options[numeric[arg]] = Number(value);
      i += 1;
    } else throw observeError('BAD_ARGS', `알 수 없는 인자 ${String(arg).slice(0, 40)}`);
  }
  validateObservationOptions(parsed.options);
  if (parsed.storeDir === null || parsed.out === null) throw observeError('BAD_ARGS', '--store-dir와 --out이 필요합니다.');
  return parsed;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  let parsed;
  let targets;
  try {
    parsed = parseObservationArgs(argv);
    targets = checkTargets(parsed, { repoRoot: deps.repoRoot ?? ROOT });
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.live && !LIVE_PLATFORMS.includes(deps.platform ?? process.platform)) {
    stderr.write(`PLATFORM_UNSUPPORTED: --live는 ${LIVE_PLATFORMS.join('·')}에서만 실행합니다.\n${USAGE}\n`);
    return 2;
  }
  if (!parsed.live) {
    const plan = observationPlan(parsed.options);
    stdout.write(parsed.json ? `${JSON.stringify({ executed: false, targets, plan }, null, 2)}\n` : `실행하지 않음(--live 없음). 계획: ${JSON.stringify({ targets, plan })}\n`);
    return 0;
  }
  // 첫 신호는 loop에 SIGTERM 한 번을 보내 정상 정지시키고, 정리 결과를 쓴 뒤 끝낸다. 둘째 신호부터는 기본 동작이다.
  const signals = deps.signalSource ?? process;
  const controller = new AbortController();
  const handlers = new Map();
  const detach = () => { for (const [name, handler] of handlers) signals.removeListener(name, handler); handlers.clear(); };
  for (const name of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      detach();
      stderr.write(`${name} 수신: loop를 정상 정지시키고 정리 결과를 남깁니다.\n`);
      controller.abort();
    };
    handlers.set(name, handler);
    signals.on(name, handler);
  }
  let report;
  try {
    report = await observeOnce(parsed.options, targets, { ...deps, stopSignal: controller.signal });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return ['STORE_EXISTS', 'OUT_EXISTS'].includes(error.code) ? 2 : 1;
  } finally {
    detach();
  }
  if (report.run.outputError) {
    // 파일에 남기지 못한 보고서는 형식 선택과 무관하게 전체 JSON을 stdout에 낸다(요약은 stderr).
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    stderr.write(`${formatObservation(report)}\n보고서를 ${targets.out}에 쓰지 못했습니다(${report.run.outputError}). stdout의 JSON이 보고서입니다.\n`);
  } else {
    stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatObservation(report)}\n`);
  }
  if (report.run.terminationConfirmed !== true) {
    stderr.write(`종료 미확인: loop pid ${report.run.loopPid}(시작 ${report.run.loopStartTime ?? '?'})가 정지 요청 뒤 끝나지 않았습니다${report.run.preHandler ? '(SIGTERM 핸들러 설치 전이라 신호를 보내지 않았습니다)' : ''}. store를 보존했습니다: ${targets.storeDir}\n`);
    return 1;
  }
  if (report.run.exit?.error) {
    stderr.write(`실행 오류: loop를 띄우지 못했습니다(${report.run.exit.error}).\n`);
    return 1;
  }
  if (report.run.outputError) return 1;
  return report.criteria.pass ? 0 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`실행 오류: ${error.code ?? 'ERROR'} ${error.message}\n`);
    process.exitCode = 1;
  }
}
