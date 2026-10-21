#!/usr/bin/env node
// 게임 store의 game-loop 기록(loop.log)에서 플레이어 CLI 호출 지연을 런타임·모델·호출 종류별로 집계하는 **읽기 전용** 도구(#312).
//
// 지키는 규칙:
//   - 파일은 읽기 전용(`fs.openSync(file, 'r')`)으로만 연다. 쓰기·잠금·임시 파일이 없다. 심볼릭 링크는 따라가지 않는다.
//   - 기록 줄은 닫힌 이벤트 목록과 필드 허용 목록으로만 읽는다. 보고서에는 결정 id·세션 id·프롬프트·응답 원문이 없다.
//   - 분모를 같이 싣는다: 호출 수와 결과 분포(응답·timeout·중단·실패 분류). timeout의 경과는 상한에서 잘린 검열값이라
//     지연 분포에 넣지 않고 따로 센다. 임계 초과(warmup 60초, 결정 soft 25초·hard 300초)는 응답한 호출에서만 센다.
//   - 결정은 호출 단위로 센다. 세션 파일이 namespace이고, 그 안에서 (decisionId, generation, callNo)마다 `player-call`
//     (purpose decision)을 우선하고 없는 호출만 `player-attempt`로 채운다. callNo가 없는 옛 행은 같은 (decisionId,
//     generation) 안에서 순번으로 대응한다(호출 수 = 두 쪽 중 많은 쪽). 같은 호출을 두 번 세지 않고, 복구 warmup만
//     `player-call`로 남은 기록이나 버전이 섞인 재개 기록에서도 결정을 잃지 않는다. 식별 값은 내부에서만 쓴다.
//   - 시작 warmup의 호출별 기록이 없는 예전 LLM 세션은 `server-spawn` → `bootstrap-playing` 간격을 따로 싣는다. relay 기동이
//     포함된 **상한 대리값**이지 호출 지연이 아니다. `bootstrap-playing`이 없는 시작은 분위수에 넣지 않고 따로 센다.
//   - 쓰는 중인 마지막 줄·손상 줄·상한을 넘는 줄과 파일은 건너뛰고 개수만 센다.
// 이 집계는 관측 기록의 요약이다. 분포 보장·안정성 증명이 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PLAYER_BUDGET } from '../shared/player-budget.js';

export const REPORT_SCHEMA = 'player-latency-report/1';
export const REPORT_LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024, lineBytes: 1024 * 1024, outliers: 20 });
export const WARMUP_PURPOSES = Object.freeze(['start-warmup', 'restore-warmup', 'repair-warmup', 'fresh-warmup']);
const WARMUP_OVER_MS = 60_000;
const EVENTS = new Set(['runtime-models', 'player-call', 'player-attempt', 'player-warmup-batch', 'server-spawn', 'bootstrap-playing']);
const TIMING_KEYS = ['bootMs', 'turnMs', 'exitToCloseMs'];

function reportError(code, message) {
  return Object.assign(new Error(message), { code });
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value, max = 64) => (typeof value === 'string' && value.length <= max ? value : null);

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// 심볼릭 링크가 아닌 실제 디렉터리/일반 파일인가(링크는 따라가지 않는다).
function lstatKind(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return 'link';
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/**
 * store(`.session-store/sessions/<세션>/loop.log`) 또는 game dir(`loop.log`)의 기록 파일 목록. 경로의 디렉터리와 파일은
 * 모두 심볼릭 링크가 아니어야 한다 — 링크를 거쳐 store 밖의 기록을 읽지 않는다.
 */
export function findLoopLogs(root) {
  const resolved = path.resolve(root);
  const store = path.join(resolved, '.session-store');
  const sessions = path.join(store, 'sessions');
  if (lstatKind(store) === 'dir' && lstatKind(sessions) === 'dir') {
    return fs.readdirSync(sessions).sort()
      .filter((name) => lstatKind(path.join(sessions, name)) === 'dir')
      .map((name) => ({ key: name, file: path.join(sessions, name, 'loop.log'), state: path.join(sessions, name, 'loop-state.json') }))
      .filter(({ file }) => lstatKind(file) === 'file');
  }
  const single = path.join(resolved, 'loop.log');
  if (lstatKind(single) === 'file') return [{ key: path.basename(resolved), file: single, state: path.join(resolved, 'loop-state.json') }];
  throw reportError('NO_LOOP_LOGS', `NO_LOOP_LOGS: ${resolved}에 loop.log가 없습니다.`);
}

// 링크를 따르지 않고 읽기 전용으로 연다. 연 파일이 일반 파일이고 lstat과 같은 inode여야 한다.
function readNoFollow(file, maxBytes) {
  const before = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw reportError('UNSAFE_PATH', `UNSAFE_PATH: ${file}`);
    if (stat.size > maxBytes) return null;
    const raw = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, raw, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return raw.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

/** 세션의 상대 런타임(`loop-state.json`의 opponentRuntime 한 필드만). 없거나 읽을 수 없으면 null. */
export function readOpponentRuntime(stateFile) {
  try {
    if (lstatKind(stateFile) !== 'file') return null;
    const bytes = readNoFollow(stateFile, 4 * 1024 * 1024);
    const value = bytes ? JSON.parse(bytes.toString('utf8'))?.opponentRuntime : null;
    return typeof value === 'string' && value.length <= 32 ? value : null;
  } catch {
    return null;
  }
}

// 허용한 필드만 남긴다. timing은 숫자·불리언만이다.
function project(raw) {
  const base = { event: raw.event, at: text(raw.at, 40) };
  switch (raw.event) {
    case 'runtime-models':
      return { ...base, player: { runtime: text(raw.player?.runtime), model: text(raw.player?.model, 128) } };
    case 'player-call':
    case 'player-attempt': {
      const timing = raw.timing && typeof raw.timing === 'object' && !Array.isArray(raw.timing)
        ? Object.fromEntries([...TIMING_KEYS, 'signalMs', 'closeMs'].map((key) => [key, finite(raw.timing[key])]).concat([['censored', raw.timing.censored === true]]))
        : null;
      return {
        ...base,
        // 결정 단위 대응에만 쓰는 내부 키다. 보고서에는 나가지 않는다.
        decisionKey: typeof raw.decisionId === 'string' ? JSON.stringify([raw.decisionId, Number.isSafeInteger(raw.generation) ? raw.generation : null]) : null,
        callNo: Number.isSafeInteger(raw.callNo) ? raw.callNo : null,
        purpose: raw.event === 'player-attempt' ? 'decision' : text(raw.purpose),
        runtime: text(raw.runtime), model: text(raw.model, 128),
        timeoutMs: finite(raw.timeoutMs), elapsedMs: finite(raw.elapsedMs),
        code: text(raw.code), category: text(raw.category), censored: raw.censored === true,
        batchSize: Number.isSafeInteger(raw.batch?.size) ? raw.batch.size : null,
        timing,
      };
    }
    case 'player-warmup-batch':
      return { ...base, purpose: text(raw.purpose), size: finite(raw.size), answered: finite(raw.answered),
        failed: finite(raw.failed), wallMs: finite(raw.wallMs) };
    default:
      return base;
  }
}

/** 한 기록 파일을 읽기 전용으로 읽어 허용한 이벤트만 돌려준다. */
export function readLoopRecords(file, limits = REPORT_LIMITS) {
  const skipped = { oversizeFile: 0, oversizeLines: 0, unparsableLines: 0 };
  const raw = readNoFollow(file, limits.fileBytes);
  if (raw === null) {
    skipped.oversizeFile = 1;
    return { records: [], skipped };
  }
  const records = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line) > limits.lineBytes) { skipped.oversizeLines += 1; continue; }
    let parsed;
    try { parsed = JSON.parse(line); } catch { skipped.unparsableLines += 1; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped.unparsableLines += 1; continue; }
    if (EVENTS.has(parsed.event)) records.push(project(parsed));
  }
  return { records, skipped };
}

/** nearest-rank 분위수. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function distribution(values) {
  const sorted = values.map((value) => Math.round(value)).sort((a, b) => a - b);
  return {
    n: sorted.length, min: sorted[0] ?? null, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? null,
  };
}

const kindOf = (purpose) => (purpose === 'decision' ? 'decision' : WARMUP_PURPOSES.includes(purpose) ? purpose : null);
const afterSince = (record, since) => since === null || (record.at !== null && Date.parse(record.at) >= since);

function emptyGroup(call, kind) {
  return {
    runtime: call.runtime, model: call.model, kind, batchSize: kind === 'decision' ? null : call.batchSize,
    calls: 0, answered: 0, timeout: 0, interrupted: 0, failed: {}, latencies: [], timings: {}, over: {},
    first: null, last: null,
  };
}

function addCall(group, call, outliers) {
  group.calls += 1;
  if (call.at && (group.first === null || call.at < group.first)) group.first = call.at;
  if (call.at && (group.last === null || call.at > group.last)) group.last = call.at;
  if (call.code === 'RESPONSE_RECEIVED') {
    group.answered += 1;
    if (call.elapsedMs !== null) group.latencies.push(call.elapsedMs);
    const limits = group.kind === 'decision'
      ? [['overSoft25s', DEFAULT_PLAYER_BUDGET.softMs], ['overHard300s', DEFAULT_PLAYER_BUDGET.hardMs]]
      : [['over60s', WARMUP_OVER_MS]];
    for (const [name, limit] of limits) {
      if (call.elapsedMs !== null && call.elapsedMs > limit) {
        group.over[name] = (group.over[name] ?? 0) + 1;
        outliers.push(call);
      }
    }
  } else if (call.category === 'timeout') {
    group.timeout += 1;
    outliers.push(call);
  } else if (call.category === 'interrupted') {
    group.interrupted += 1;
  } else {
    const category = call.category ?? 'unknown';
    group.failed[category] = (group.failed[category] ?? 0) + 1;
  }
  if (call.timing) {
    for (const key of TIMING_KEYS) {
      if (call.timing[key] !== null) (group.timings[key] ??= []).push(call.timing[key]);
    }
  }
}

/**
 * 한 세션의 플레이어 호출. warmup은 `player-call`이고, 결정은 호출 단위로 `player-call`을 우선하고 없는 호출만
 * `player-attempt`로 채운다. 결정 키가 없는 행은 그 세션에 결정 `player-call`이 없을 때만 각자 한 호출로 센다.
 */
function playerCallsOf(records) {
  const out = records.filter((record) => record.event === 'player-call' && record.purpose !== 'decision');
  const decisionCalls = records.filter((record) => record.event === 'player-call' && record.purpose === 'decision');
  const attempts = records.filter((record) => record.event === 'player-attempt');
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { calls: [], attempts: [] });
    return groups.get(key);
  };
  for (const call of decisionCalls) {
    if (call.decisionKey === null) out.push(call);
    else group(call.decisionKey).calls.push(call);
  }
  for (const attempt of attempts) {
    if (attempt.decisionKey === null) {
      if (decisionCalls.length === 0) out.push(attempt);
    } else group(attempt.decisionKey).attempts.push(attempt);
  }
  for (const { calls, attempts: tries } of groups.values()) {
    // 번호가 있는 행끼리 먼저 callNo로 대응한다(player-call 우선).
    const byNo = new Map();
    for (const attempt of tries) if (attempt.callNo !== null && !byNo.has(attempt.callNo)) byNo.set(attempt.callNo, attempt);
    for (const call of calls) if (call.callNo !== null) byNo.set(call.callNo, call);
    out.push(...byNo.values());
    // 남은 번호 없는 옛 행끼리만 순번으로 대응한다. 번호 있는 행과는 대응할 근거가 없어 따로 센다.
    const oldCalls = calls.filter((record) => record.callNo === null);
    const oldTries = tries.filter((record) => record.callNo === null);
    out.push(...oldCalls, ...oldTries.slice(oldCalls.length));
  }
  return out;
}

/**
 * 세션별 기록을 묶어 집계한다. `sessions` = [{ key, records, skipped }].
 * `since`(ISO)가 있으면 그 시각 이후 기록만 센다.
 */
export function aggregateLatency(sessions, { since = null } = {}) {
  const sinceMs = since === null ? null : Date.parse(since);
  if (since !== null && !Number.isFinite(sinceMs)) throw reportError('BAD_ARGS', 'BAD_ARGS: --since는 ISO 시각이어야 합니다.');
  const groups = new Map();
  const outliers = [];
  const proxies = [];
  const unfinishedStarts = [];
  const skipped = { oversizeFile: 0, oversizeLines: 0, unparsableLines: 0 };
  const runtimes = {};
  let llmSessions = 0;
  let withCalls = 0;
  for (const session of sessions) {
    for (const key of Object.keys(skipped)) skipped[key] += session.skipped?.[key] ?? 0;
    const records = session.records.filter((record) => afterSince(record, sinceMs));
    const calls = playerCallsOf(records);
    // LLM 세션은 플레이어 호출이 있거나, loop-state의 상대 런타임이 llm인 세션이다(호출 없이 시작에 실패한 옛 세션 포함).
    const llm = calls.length > 0 || session.opponentRuntime === 'llm';
    if (!llm) continue;
    llmSessions += 1;
    if (calls.length > 0) withCalls += 1;
    for (const runtime of new Set(calls.map((call) => call.runtime ?? 'unknown'))) runtimes[runtime] = (runtimes[runtime] ?? 0) + 1;
    for (const call of calls) {
      const kind = kindOf(call.purpose);
      if (kind === null) continue;
      const id = JSON.stringify([call.runtime, call.model, kind, kind === 'decision' ? null : call.batchSize]);
      if (!groups.has(id)) groups.set(id, emptyGroup(call, kind));
      addCall(groups.get(id), call, outliers);
    }
    if (!calls.some((call) => call.purpose === 'start-warmup')) {
      const spawn = records.find((record) => record.event === 'server-spawn' && record.at);
      const playing = spawn && records.find((record) => record.event === 'bootstrap-playing' && record.at && record.at >= spawn.at);
      const model = records.find((record) => record.event === 'runtime-models')?.player ?? null;
      const runtime = model?.runtime ?? calls[0]?.runtime ?? 'unknown';
      const modelId = model?.model ?? calls[0]?.model ?? 'unknown';
      if (spawn && !playing) unfinishedStarts.push({ runtime, model: modelId });
      else if (playing) {
        const ms = Date.parse(playing.at) - Date.parse(spawn.at);
        if (Number.isFinite(ms) && ms >= 0) proxies.push({ runtime, model: modelId, ms });
      }
    }
  }
  const proxyGroups = new Map();
  for (const proxy of proxies) {
    const id = JSON.stringify([proxy.runtime, proxy.model]);
    if (!proxyGroups.has(id)) proxyGroups.set(id, { runtime: proxy.runtime, model: proxy.model, values: [] });
    proxyGroups.get(id).values.push(proxy.ms);
  }
  const order = (a, b) => String(a.runtime).localeCompare(String(b.runtime)) || String(a.model).localeCompare(String(b.model))
    || String(a.kind ?? '').localeCompare(String(b.kind ?? '')) || (a.batchSize ?? 0) - (b.batchSize ?? 0);
  return {
    schema: REPORT_SCHEMA,
    since,
    sessions: { scanned: sessions.length, llm: llmSessions, withPlayerCalls: withCalls, byRuntime: runtimes },
    skipped,
    groups: [...groups.values()].map((group) => ({
      runtime: group.runtime, model: group.model, kind: group.kind, batchSize: group.batchSize,
      first: group.first, last: group.last,
      calls: group.calls,
      outcomes: { answered: group.answered, timeout: group.timeout, interrupted: group.interrupted, failed: group.failed },
      answeredMs: distribution(group.latencies),
      over: group.over,
      timing: Object.fromEntries(TIMING_KEYS.filter((key) => group.timings[key]?.length).map((key) => [key, distribution(group.timings[key])])),
    })).sort(order),
    legacyStartWarmupUpperBound: [...proxyGroups.values()].map((group) => ({
      runtime: group.runtime, model: group.model, sessions: group.values.length, ms: distribution(group.values),
      unfinishedStarts: unfinishedStarts.filter((row) => row.runtime === group.runtime && row.model === group.model).length,
    })).sort(order),
    unfinishedStarts: unfinishedStarts.length,
    outliers: outliers.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, REPORT_LIMITS.outliers).map((call) => ({
      at: call.at, kind: kindOf(call.purpose), runtime: call.runtime, model: call.model, elapsedMs: call.elapsedMs,
      code: call.code, timing: call.timing,
    })),
    outliersTotal: outliers.length,
    caveats: [
      '관측 기록의 요약이다. 분포 보장·안정성 증명이 아니다.',
      'timeout은 상한에서 잘린 검열값이라 응답 지연 분포에 넣지 않았다.',
      'legacyStartWarmupUpperBound는 relay 기동을 포함한 server-spawn→bootstrap-playing 간격이다. 호출 지연이 아니다.',
    ],
  };
}

export function buildLatencyReport(root, options = {}) {
  const sessions = findLoopLogs(root).map(({ key, file, state }) => ({ key, ...readLoopRecords(file), opponentRuntime: readOpponentRuntime(state) }));
  return aggregateLatency(sessions, options);
}

const fmt = (value) => (value === null || value === undefined ? '-' : `${(value / 1000).toFixed(1)}s`);

export function formatLatencyReport(report) {
  const lines = [
    `플레이어 호출 지연(읽기 전용 집계) — 기록 ${report.sessions.scanned}개 중 LLM 세션 ${report.sessions.llm}개(호출 있는 세션 ${report.sessions.withPlayerCalls}개)${report.since ? `, ${report.since} 이후` : ''}`,
  ];
  for (const group of report.groups) {
    const failed = Object.entries(group.outcomes.failed).map(([key, n]) => `${key} ${n}`).join(', ') || '0';
    const d = group.answeredMs;
    lines.push(`- ${group.runtime}/${group.model} ${group.kind}${group.batchSize ? ` ×${group.batchSize}` : ''}: 호출 ${group.calls}, 응답 ${group.outcomes.answered}, timeout ${group.outcomes.timeout}, 중단 ${group.outcomes.interrupted}, 실패 ${failed}`);
    lines.push(`  응답 경과 중앙값 ${fmt(d.median)} · p90 ${fmt(d.p90)} · p95 ${fmt(d.p95)} · 최대 ${fmt(d.max)}${Object.keys(group.over).length ? ` · 초과 ${JSON.stringify(group.over)}` : ''}`);
    for (const [key, value] of Object.entries(group.timing)) lines.push(`  ${key} 중앙값 ${fmt(value.median)} · 최대 ${fmt(value.max)} (n=${value.n})`);
  }
  for (const proxy of report.legacyStartWarmupUpperBound) {
    lines.push(`- ${proxy.runtime}/${proxy.model} 시작 warmup 상한 대리값(relay 기동 포함): 세션 ${proxy.sessions}, 중앙값 ${fmt(proxy.ms.median)} · 최대 ${fmt(proxy.ms.max)} · playing 전 끝난 시작 ${proxy.unfinishedStarts}`);
  }
  lines.push(`playing에 이르지 못한 LLM 시작(대리값에서 제외): ${report.unfinishedStarts}`);
  lines.push(`건너뛴 줄: 손상 ${report.skipped.unparsableLines}, 상한 초과 ${report.skipped.oversizeLines}, 상한 초과 파일 ${report.skipped.oversizeFile}`);
  lines.push(...report.caveats.map((caveat) => `주의: ${caveat}`));
  return lines.join('\n');
}

const USAGE = `사용법: node tools/player-latency-report.js <store 또는 game dir> [--since ISO] [--json]
  종료 코드: 0 = 집계 출력 · 2 = 인자 오류 · 1 = 읽기 오류`;

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let root = null;
  let since = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--since') {
      since = argv[i + 1] ?? null;
      i += 1;
      if (since === null || !Number.isFinite(Date.parse(since))) {
        stderr.write(`BAD_ARGS: --since에는 ISO 시각이 필요합니다.\n${USAGE}\n`);
        return 2;
      }
    } else if (!arg.startsWith('--') && root === null) root = arg;
    else {
      stderr.write(`BAD_ARGS: 알 수 없는 인자 ${String(arg).slice(0, 40)}\n${USAGE}\n`);
      return 2;
    }
  }
  if (root === null) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  let report;
  try {
    report = buildLatencyReport(root, { since });
  } catch (error) {
    stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
    return error.code === 'BAD_ARGS' ? 2 : 1;
  }
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatLatencyReport(report)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
