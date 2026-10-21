#!/usr/bin/env node
// 학습 효과 평가(#298)의 등록·철회·진행·보고 CLI. 프로토콜과 판정은 `training/learning-effect.js`가 정한다.
//
//   enroll   --store <절대 경로> --consent [--baseline-runs K] [--intervention-days D] [--post-days W]
//   withdraw --store <절대 경로> [--id <등록 id>]
//   status   --store <절대 경로> [--json]
//   report   --store <절대 경로> [--json] [--id <등록 id>]
//
// 지키는 규칙:
//   - 등록은 참여자의 명시적 동의(`--consent`)가 있어야 한다. 일정(기준 K회 → 개입 D일 → 사후 W일)은 등록 때 봉인되고,
//     사후 구간은 참여자가 고르지 않고 봉인 시각에 열린다. 등록 기록은 덧붙이기 전용이다(철회 시각 한 번 말고는 고치지 않는다).
//   - 등록·철회는 drill 락 안에서 원자 교체로 쓴다. 등록은 노출·실행 원장이 없으면 만든다.
//   - status·report는 읽기 전용이다: 락·디렉터리 생성·권한 변경·임시 파일이 없다. 다섯 입력(이벤트·두 원장·등록·세션)을
//     읽기 전후로 (크기, mtime, inode)를 비교하고, 바뀌었으면 최대 3회 다시 읽는다. 그래도 바뀌면 SNAPSHOT_UNSTABLE이다.
//   - 보고서는 현재 보존된 자료로 다시 계산한 값이다. 최종 결과를 남기려면 `report --json` 출력을 저장한다(입력 digest 포함).
//   - 기존 학습 기록을 재생·재채점하지 않는다. 결과는 휴리스틱 기준표 일치도의 개인 연관 관측이다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withDrillLock } from './drill-cli.js';
import { LEDGERS, appendLedgerRows, parseLedger } from './learning-ledgers.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { openContained, writeContained } from './training-store.js';
import { strataForSpot } from '../training/drill-strata.js';
import { lookup } from '../training/providers/preflop-json.js';
import { CANONICAL_REFERENCE_SOURCE, referenceSchemaOf } from '../shared/reference.js';
import {
  LEARNING_EFFECT_PROTOCOL_V1, PROTOCOL_SHA256, evaluateLearningEffect, sealPlan,
} from '../training/learning-effect.js';

export const ENROLLMENT_FILE = 'learning-evaluation.json';
const EVENTS_FILE = 'profile-events.jsonl';
const SESSION_FILE = 'drill-session.json';
const LIMITS = Object.freeze({ events: 64 * 1024 * 1024, small: 2 * 1024 * 1024, snapshotAttempts: 3 });
export const CONSENT_TEXT = [
  '학습 효과 평가에 참여합니다.',
  '- 등록 시각부터 봉인된 일정(기준 → 개입 → 사후) 동안의 학습 기록·차트 열람·측정 실행 시작을 평가에 씁니다.',
  '- 기록은 이 store(로컬)에만 있고 밖으로 보내지 않습니다.',
  '- 결과는 휴리스틱 기준표 일치도의 개인 관측입니다. 코칭의 인과 효과·실제 실력·수익의 증거가 아닙니다.',
  '- 언제든 `withdraw`로 철회할 수 있습니다. 철회하면 보고서는 지표를 내지 않습니다.',
].join('\n');

function evalError(code, message) {
  return Object.assign(new Error(message), { code });
}

const trainingRootOf = (storeDir) => path.join(storeDir, '.training');
const sameSource = (a, b) => a?.id === b?.id && a?.version === b?.version && (a?.contentSha256 ?? null) === (b?.contentSha256 ?? null);
const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readFile(root, name, maxBytes) {
  try {
    return openContained(root, [name], { maxBytes });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validEnrollment(row) {
  return Boolean(row && typeof row === 'object' && UUID_RE.test(row.id ?? '') && typeof row.protocolId === 'string'
    && /^[0-9a-f]{64}$/.test(row.protocolSha256 ?? '') && row.source && typeof row.source === 'object'
    && validIso(row.consentedAt) && row.plan && typeof row.plan === 'object' && /^[0-9a-f]{64}$/.test(row.planSha256 ?? '')
    && validIso(row.postOpensAt) && validIso(row.postClosesAt) && (row.withdrawnAt === null || validIso(row.withdrawnAt)));
}

/** 등록 기록(읽기 전용). 없으면 빈 목록, 형식이 틀리면 ENROLLMENT_INVALID. */
export function readEnrollments(trainingRoot) {
  return parseEnrollments(readFile(trainingRoot, ENROLLMENT_FILE, LIMITS.small));
}

function parseEnrollments(bytes) {
  if (bytes === null) return { schemaVersion: 1, enrollments: [] };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw evalError('ENROLLMENT_INVALID', '등록 기록을 읽을 수 없습니다.'); }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.enrollments) || !parsed.enrollments.every(validEnrollment)) {
    throw evalError('ENROLLMENT_INVALID', '등록 기록 형식이 올바르지 않습니다.');
  }
  return parsed;
}

const isOpen = (row, now) => !row.withdrawnAt && Date.parse(now) < Date.parse(row.postClosesAt);

// 노출 원장의 씨앗: 최근 열람 파일이 없으면 빈 씨앗(정상), 읽을 수 없거나 형식이 틀리면 실패(그 7일을 주장하지 않는다).
function seedRowsFor(trainingRoot) {
  return () => {
    let rows;
    try {
      const bytes = readFile(trainingRoot, 'grid-exposures.json', 1024 * 1024);
      rows = bytes ? JSON.parse(bytes.toString('utf8')) : [];
    } catch {
      return { ok: false, rows: [] };
    }
    if (!Array.isArray(rows)) return { ok: false, rows: [] };
    return { ok: true, rows: rows.filter((row) => row && validIso(row.at) && typeof row.spotKey === 'string' && row.sourceIdentity)
      .map((row) => ({ at: row.at, sourceIdentity: row.sourceIdentity, spotKey: row.spotKey })) };
  };
}

export async function enroll(storeDir, { consent = false, plan = {}, now = () => new Date().toISOString() } = {}) {
  if (consent !== true) throw evalError('CONSENT_REQUIRED', '등록에는 --consent가 필요합니다.');
  const source = { ...CANONICAL_REFERENCE_SOURCE };
  if (referenceSchemaOf(source) !== LEARNING_EFFECT_PROTOCOL_V1.scope.referenceSchema) {
    throw evalError('UNSUPPORTED_SOURCE', '프로토콜 v1은 기준표 v3만 평가합니다.');
  }
  loadReferenceDataset(source);
  const root = trainingRootOf(storeDir);
  return withDrillLock(storeDir, async () => {
    const at = now();
    const current = readEnrollments(root);
    if (current.enrollments.some((row) => isOpen(row, at))) throw evalError('ENROLLMENT_OPEN', '진행 중인 등록이 있습니다. 끝나거나 철회한 뒤 등록하세요.');
    const sealed = sealPlan(plan, at);
    appendLedgerRows(root, 'exposure', [], { at, seedRows: seedRowsFor(root) });
    appendLedgerRows(root, 'run', [], { at });
    const enrollment = {
      id: randomUUID(), protocolId: LEARNING_EFFECT_PROTOCOL_V1.id, protocolSha256: PROTOCOL_SHA256, source,
      consentedAt: at, plan: sealed.plan, planSha256: sealed.planSha256, postOpensAt: sealed.postOpensAt,
      postClosesAt: sealed.postClosesAt, withdrawnAt: null,
    };
    writeContained(root, [ENROLLMENT_FILE], `${JSON.stringify({ schemaVersion: 1, enrollments: [...current.enrollments, enrollment] })}\n`, { mode: 'replace' });
    return enrollment;
  });
}

/** 철회는 관측 기간이 끝난 뒤에도 된다. `id`가 없으면 철회하지 않은 마지막 등록이다. */
export async function withdraw(storeDir, { id = null, now = () => new Date().toISOString() } = {}) {
  const root = trainingRootOf(storeDir);
  return withDrillLock(storeDir, async () => {
    const at = now();
    const current = readEnrollments(root);
    const index = id ? current.enrollments.findIndex((row) => row.id === id && !row.withdrawnAt)
      : current.enrollments.findLastIndex((row) => !row.withdrawnAt);
    if (index < 0) throw evalError('NOT_ENROLLED', id ? '그 id의 철회하지 않은 등록이 없습니다.' : '철회할 등록이 없습니다.');
    const next = current.enrollments.map((row, i) => (i === index ? { ...row, withdrawnAt: at } : row));
    writeContained(root, [ENROLLMENT_FILE], `${JSON.stringify({ schemaVersion: 1, enrollments: next })}\n`, { mode: 'replace' });
    return next[index];
  });
}

// ── 읽기 전용 snapshot ───────────────────────────────────────────────────────

function statOf(file) {
  try {
    const stat = fs.lstatSync(file);
    return [stat.size, stat.mtimeMs, stat.ino, stat.isFile()].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function parseJsonl(bytes) {
  if (bytes === null) return [];
  const parts = bytes.toString('utf8').split('\n');
  // 마지막 줄은 개행으로 끝나지 않으면 쓰는 중이다 — 버린다(readJsonl과 같은 규칙).
  return parts.slice(0, -1).filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

const digest = (bytes) => (bytes === null ? null : createHash('sha256').update(bytes).digest('hex'));

/** 다섯 입력을 한 번에 읽는다. 읽는 동안 하나라도 바뀌면 다시 읽고, 3회 모두 바뀌면 SNAPSHOT_UNSTABLE. */
export function readSnapshot(storeDir, { afterRead = null } = {}) {
  const root = trainingRootOf(storeDir);
  const names = [EVENTS_FILE, LEDGERS.exposure.file, LEDGERS.run.file, ENROLLMENT_FILE, SESSION_FILE];
  for (let attempt = 1; attempt <= LIMITS.snapshotAttempts; attempt += 1) {
    const beforeStats = names.map((name) => statOf(path.join(root, name)));
    let bytes;
    try {
      bytes = Object.fromEntries(names.map((name) => [name, readFile(root, name, name === EVENTS_FILE ? LIMITS.events : LIMITS.small)]));
    } catch (error) {
      // 읽는 중 원자 교체가 일어나면 openContained가 UNSAFE_PATH로 거부한다 — 같은 재시도 규칙으로 다룬다.
      if (error.code === 'UNSAFE_PATH') continue;
      throw error;
    }
    // 테스트 이음새: 읽은 뒤·재확인 전에 동시 쓰기를 흉내 낸다.
    afterRead?.(attempt);
    const afterStats = names.map((name) => statOf(path.join(root, name)));
    if (beforeStats.some((stat, i) => stat !== afterStats[i])) continue;
    let session = null;
    try { session = bytes[SESSION_FILE] ? JSON.parse(bytes[SESSION_FILE].toString('utf8')) : null; } catch { session = null; }
    // 판독은 모두 위에서 읽은 같은 바이트로 한다(다시 디스크를 읽지 않는다).
    return {
      events: parseJsonl(bytes[EVENTS_FILE]),
      exposureLog: parseLedger('exposure', bytes[LEDGERS.exposure.file]),
      runLog: parseLedger('run', bytes[LEDGERS.run.file]),
      enrollments: parseEnrollments(bytes[ENROLLMENT_FILE]).enrollments,
      currentRunId: typeof session?.studyRun?.id === 'string' ? session.studyRun.id : null,
      inputs: Object.fromEntries(names.map((name) => [name, digest(bytes[name])])),
      attempts: attempt,
    };
  }
  throw evalError('SNAPSHOT_UNSTABLE', '읽는 동안 학습 기록이 계속 바뀌었습니다. 학습을 멈춘 뒤 다시 실행하세요.');
}

function datasetHelpers(source) {
  let dataset;
  try { dataset = loadReferenceDataset(source); } catch { return { chartOf: null, stratumOf: () => null }; }
  const spots = dataset.data?.spots ?? {};
  const strata = new Map();
  return {
    chartOf: (spotKey) => (typeof spots[spotKey] === 'string' ? spots[spotKey] : null),
    stratumOf: (spotKey, handClass) => {
      if (!strata.has(spotKey)) {
        strata.set(spotKey, strataForSpot((cls) => {
          const found = lookup(dataset, { spotKey, handClass: cls });
          const f = { fold: 1, call: 0, raise: 0 };
          if (found.status === 'supported') {
            f.fold = 0;
            for (const row of found.actions) f[row.action] = (f[row.action] ?? 0) + row.frequency;
          }
          return f;
        }));
      }
      return strata.get(spotKey).get(handClass)?.stratum ?? null;
    },
  };
}

/** 읽기 전용 보고서. `id`가 없으면 가장 최근 등록이다. */
export function buildReport(storeDir, { id = null, now = new Date().toISOString(), afterRead = null } = {}) {
  const snapshot = readSnapshot(storeDir, { afterRead });
  const enrollment = id ? snapshot.enrollments.find((row) => row.id === id) ?? null : snapshot.enrollments.at(-1) ?? null;
  if (id && !enrollment) throw evalError('NOT_ENROLLED', '그 id의 등록이 없습니다.');
  const helpers = enrollment ? datasetHelpers(enrollment.source) : { chartOf: null, stratumOf: () => null };
  return evaluateLearningEffect({
    events: snapshot.events, exposureLog: snapshot.exposureLog, runLog: snapshot.runLog, enrollment, now,
    chartOf: helpers.chartOf ?? undefined, stratumOf: helpers.stratumOf, currentRunId: snapshot.currentRunId, inputs: snapshot.inputs,
  });
}

// ── 출력·CLI ─────────────────────────────────────────────────────────────────

const pct = (value) => (value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`);

export function formatReport(report) {
  const lines = [`학습 효과 평가 — ${report.status}${report.reasons?.length ? ` (${report.reasons.join(', ')})` : ''}`];
  if (report.enrollment) {
    const e = report.enrollment;
    lines.push(`등록 ${e.id} · 동의 ${e.consentedAt} · 사후 ${e.postOpensAt} ~ ${e.postClosesAt} · 기준/사후 ${e.plan.baselineRuns}회`);
  }
  if (report.runs) {
    const r = report.runs;
    lines.push(`기준 실행: 시작 ${r.baseline.started}/${r.baseline.planned}, 미시작 ${r.baseline.notStarted}, 상태 ${JSON.stringify(r.baseline.byStatus)}, 확인 안 된 시작 ${r.baseline.unconfirmedStarts}`);
    lines.push(`사후 실행: 시작 ${r.post.started}/${r.post.planned}, 미시작 ${r.post.notStarted}, 상태 ${JSON.stringify(r.post.byStatus)}, 확인 안 된 시작 ${r.post.unconfirmedStarts}`);
    lines.push(`지연 재평가: ${JSON.stringify(r.retention.byStatus)} · 교체 ${r.replacements} · 관측 없는 게임 결정 ${r.untrackedDecisions}`);
  }
  if (report.m1) {
    const m = report.m1;
    lines.push(`M1(미응답·미열람 동치군 문항 일치도): ${m.verdict}${m.reason ? ` (${m.reason})` : ''} · 기준 ${m.nBase}문항 ${pct(m.rawRate.baseline)} → 사후 ${m.nPost}문항 ${pct(m.rawRate.post)} · 표준화 차이 ${pct(m.raw)} [${pct(m.ci?.[0])}, ${pct(m.ci?.[1])}]`);
  }
  if (report.m2) {
    const m = report.m2;
    lines.push(`M2(재연습 없는 지연 유지): ${m.verdict}${m.reason ? ` (${m.reason})` : ''} · 짝 ${m.n} ${JSON.stringify(m.table)} · 차이 ${pct(m.raw)} [${pct(m.ci?.[0])}, ${pct(m.ci?.[1])}]`);
  }
  if (report.pattern) lines.push(`패턴: ${report.pattern}`);
  lines.push(report.statement, report.scope);
  for (const caveat of report.caveats ?? []) lines.push(`주의: ${caveat}`);
  return lines.join('\n');
}

const USAGE = `사용법: node tools/learning-eval.js <enroll|withdraw|status|report> --store <절대 경로> [옵션]
  enroll   --consent [--baseline-runs K(2-5, 기본 3)] [--intervention-days D(1-28, 기본 7)] [--post-days W(3-14, 기본 7)]
  withdraw [--id <등록 id>]           (관측 기간이 끝난 뒤에도 철회할 수 있다)
  report   [--json] [--id <등록 id>]   (읽기 전용, 현재 자료로 다시 계산)
  status   [--json]                    (읽기 전용)
  종료 코드: 0 = 성공 · 2 = 인자 오류 · 1 = 실행 오류`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['enroll', 'withdraw', 'status', 'report'].includes(command)) throw evalError('BAD_ARGS', 'BAD_ARGS: 명령이 필요합니다.');
  const parsed = { command, store: null, consent: false, json: false, id: null, plan: {} };
  const numeric = { '--baseline-runs': 'baselineRuns', '--intervention-days': 'interventionDays', '--post-days': 'postDays' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--store') { parsed.store = rest[i + 1] ?? null; i += 1; }
    else if (arg === '--consent' && command === 'enroll') parsed.consent = true;
    else if (arg === '--json' && ['status', 'report'].includes(command)) parsed.json = true;
    else if (arg === '--id' && ['report', 'withdraw'].includes(command)) { parsed.id = rest[i + 1] ?? null; i += 1; }
    else if (Object.hasOwn(numeric, arg) && command === 'enroll') {
      const text = rest[i + 1];
      if (typeof text !== 'string' || !/^\d{1,3}$/.test(text)) throw evalError('BAD_ARGS', `BAD_ARGS: ${arg}에는 정수가 필요합니다.`);
      parsed.plan[numeric[arg]] = Number(text);
      i += 1;
    } else throw evalError('BAD_ARGS', `BAD_ARGS: 알 수 없는 인자 ${String(arg).slice(0, 40)}`);
  }
  if (typeof parsed.store !== 'string' || !path.isAbsolute(parsed.store)) throw evalError('BAD_ARGS', 'BAD_ARGS: --store에는 절대 경로가 필요합니다.');
  if (parsed.id !== null && !UUID_RE.test(parsed.id)) throw evalError('BAD_ARGS', 'BAD_ARGS: --id 형식이 올바르지 않습니다.');
  return parsed;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, now } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}\n`); return 2; }
  try {
    if (parsed.command === 'enroll') {
      const enrollment = await enroll(parsed.store, { consent: parsed.consent, plan: parsed.plan, ...(now ? { now } : {}) });
      stdout.write(`${CONSENT_TEXT}\n등록 ${enrollment.id}: 기준 assessment ${enrollment.plan.baselineRuns}회는 ${enrollment.postOpensAt} 전에, 사후 assessment ${enrollment.plan.baselineRuns}회와 기준마다 지연 재평가 1회는 ${enrollment.postOpensAt} ~ ${enrollment.postClosesAt}에 합니다. 최종 보고서는 ${enrollment.postClosesAt} 뒤에 나옵니다.\n`);
      return 0;
    }
    if (parsed.command === 'withdraw') {
      const row = await withdraw(parsed.store, { id: parsed.id, ...(now ? { now } : {}) });
      stdout.write(`등록 ${row.id}를 철회했습니다(${row.withdrawnAt}).\n`);
      return 0;
    }
    const report = buildReport(parsed.store, { id: parsed.id, ...(now ? { now: now() } : {}) });
    stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
    return error.code === 'BAD_PLAN' ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
