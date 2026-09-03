#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from './training-stores.js';
import { createTrainingControl } from './training-control.js';
import { defaultEvaluate, toRunnerHandle } from './training-pipeline.js';
import { openContained, readJsonSecure, writeContained, writeJsonSecure } from './training-store.js';

export const PRACTICE_FOCUS_MAX_BYTES = 4096;
export const PRACTICE_FOCUS_SEGMENTS = ['.training', 'practice-focus.json'];
const PRACTICE_FOCUS_DEST = ['.practice-focus.json'];
const PRACTICE_FOCUS_KEYS = new Set(['schemaVersion', 'leaks', 'focus']);
const PRACTICE_FOCUS_LEAK_KEYS = new Set(['id', 'recommendedDrill', 'severity', 'confidence']);

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(code, message) {
  fs.writeSync(1, `${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail('USAGE', `${arg}의 값이 필요합니다.`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return { flags, positional };
}

function listTrainingSessions(storeDir) {
  const sessions = path.join(storeDir, '.session-store', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs.readdirSync(sessions, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && !ent.name.startsWith('.'))
    .map((ent) => path.join(sessions, ent.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'training', '.training-authority.json')));
}

function terminalForMigration(sessionDir) {
  try {
    const state = readJsonSecure(path.join(sessionDir, 'loop-state.json'));
    return state?.phase === 'done' || state?.phase === 'review_published';
  } catch {
    return false;
  }
}

function migrationNeeded(sessionDir) {
  const auth = readJsonSecure(path.join(sessionDir, 'training', '.training-authority.json'));
  if (auth?.schemaVersion === 1) return 'required';
  let marker = null;
  try {
    marker = readJsonSecure(path.join(sessionDir, 'training', '.migration-v2.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (marker?.status === 'in-progress') return 'required';
  if (['session-done', 'complete'].includes(marker?.status)
    && fs.existsSync(path.join(sessionDir, '.publish-attempt.json'))) return 'residual';
  return null;
}

async function settleRunner(out) {
  const handle = toRunnerHandle(out);
  return handle.promise;
}

async function retryPendingMap(sessionDir, { evaluate, solve, storeDir }) {
  const notices = [];
  let retried = 0;
  const tc = createTrainingControl({ storeDir });
  const auth = tc.loadAuthority(sessionDir);
  if (!auth) return { notices, retried };
  const pending = { ...(auth.pending ?? {}) };
  const evaluateByHand = new Map();
  for (const [decisionId, entry] of Object.entries(pending)) {
    if (entry?.adapterId) {
      try {
        const evaluated = solve
          ? await settleRunner(solve({
            sessionDir,
            decisionId,
            handNo: entry.handNo,
            adapterId: entry.adapterId,
            pending: entry,
          }))
          : { ok: false, code: 'SOLVE_PENDING_UNMAPPED' };
        if (!evaluated?.ok) {
          await tc.recordPending(sessionDir, decisionId, {
            handNo: entry.handNo,
            reason: evaluated?.code ?? 'SOLVE_FAILED',
            adapterId: entry.adapterId,
            gameEpoch: auth.gameEpoch,
            owner: auth.ownerSessionId,
          });
          notices.push(`solver pending ${decisionId}: ${evaluated?.code ?? 'SOLVE_FAILED'}`);
          continue;
        }
        const incoming = (evaluated.evaluations ?? []).filter((row) => row.decisionId === decisionId);
        if (incoming.length === 0) {
          notices.push(`solver pending ${decisionId}: NO_EVALUATION`);
          continue;
        }
        await tc.acceptEvaluations(sessionDir, {
          gameEpoch: auth.gameEpoch,
          owner: auth.ownerSessionId,
          handNo: entry.handNo,
          evaluations: incoming,
        });
        retried += 1;
      } catch (error) {
        notices.push(`solver pending ${decisionId}: ${error.code ?? 'ERROR'}`);
        try {
          await tc.recordPending(sessionDir, decisionId, {
            handNo: entry.handNo,
            reason: error.code ?? 'SOLVE_FAILED',
            adapterId: entry.adapterId,
            gameEpoch: auth.gameEpoch,
            owner: auth.ownerSessionId,
          });
        } catch { /* keep original pending */ }
      }
      continue;
    }
    const handNo = entry?.handNo;
    if (!evaluateByHand.has(handNo)) evaluateByHand.set(handNo, []);
    evaluateByHand.get(handNo).push(decisionId);
  }

  for (const [handNo, decisionIds] of evaluateByHand) {
    try {
      const evaluated = await settleRunner(evaluate(sessionDir, handNo));
      if (!evaluated?.ok) {
        for (const decisionId of decisionIds) {
          await tc.recordPending(sessionDir, decisionId, {
            handNo,
            reason: evaluated?.code ?? 'EVALUATE_FAILED',
            gameEpoch: auth.gameEpoch,
            owner: auth.ownerSessionId,
          });
        }
        notices.push(`evaluate pending hand ${handNo}: ${evaluated?.code ?? 'EVALUATE_FAILED'}`);
        continue;
      }
      const incoming = (evaluated.evaluations ?? [])
        .filter((row) => decisionIds.includes(row.decisionId));
      if (incoming.length === 0) {
        notices.push(`evaluate pending hand ${handNo}: NO_EVALUATION`);
        continue;
      }
      await tc.acceptEvaluations(sessionDir, {
        gameEpoch: auth.gameEpoch,
        owner: auth.ownerSessionId,
        handNo,
        evaluations: incoming,
      });
      retried += incoming.length;
    } catch (error) {
      notices.push(`evaluate pending hand ${handNo}: ${error.code ?? 'ERROR'}`);
    }
  }
  return { notices, retried };
}

function profileHasFocus(profile) {
  return (profile?.overall?.evaluatedDecisions ?? 0) > 0 || (profile?.leaks ?? []).length > 0;
}

export async function sweepStore(storeDir, { evaluate, solve, onNotice } = {}) {
  const notices = [];
  let applied = 0;
  let profiled = 0;
  let banked = 0;
  let pendingRetried = 0;
  const tc = createTrainingControl({ storeDir });
  const runEvaluate = evaluate ?? defaultEvaluate;
  for (const sessionDir of listTrainingSessions(storeDir)) {
    try {
      let migration = null;
      const migrationKind = migrationNeeded(sessionDir);
      if (migrationKind) {
        const terminal = terminalForMigration(sessionDir);
        if (!terminal && migrationKind === 'required') {
          throw coded('SESSION_NOT_TERMINAL', '비terminal 세션의 authority는 sweep이 마이그레이션하지 않습니다.');
        }
        if (terminal) migration = await tc.migrateAuthority(sessionDir);
        else notices.push('profile sweep notice: nonterminal residual publish attempt는 resume이 처리합니다.');
      }
      for (const notice of migration?.notices ?? []) {
        notices.push(notice);
        onNotice?.(notice);
      }
      const pendingOut = await retryPendingMap(sessionDir, {
        evaluate: runEvaluate,
        solve,
        storeDir,
      });
      for (const notice of pendingOut.notices) {
        notices.push(notice);
        onNotice?.(notice);
      }
      pendingRetried += pendingOut.retried;
      await completeSessionStoreMigration(storeDir, sessionDir);
      const consume = await tc.consumeTrainingItems(sessionDir, { storeDir });
      applied += consume.applied ?? 0;
      profiled += consume.profiled ?? 0;
      banked += consume.banked ?? 0;
    } catch (error) {
      const notice = `profile sweep 실패: ${error.code ?? 'ERROR'}`;
      notices.push(notice);
      onNotice?.(notice);
    }
  }
  let profile = null;
  try {
    profile = await createProfileStore(storeDir).show();
    if (profileHasFocus(profile)) writePracticeFocus(storeDir, profile);
  } catch (error) {
    const notice = `profile sweep 실패: ${error.code ?? 'ERROR'}`;
    notices.push(notice);
    onNotice?.(notice);
  }
  return {
    applied, profiled, banked, pendingRetried, notices, profile,
  };
}

export async function applyEvaluation(storeDir, evaluation) {
  const store = createProfileStore(storeDir);
  return store.apply(evaluation);
}

function resignMistakes(storeDir, { oldToNew = {}, byEvaluationId = {} }) {
  const file = path.join(storeDir, '.training', 'mistakes.json');
  try {
    const data = readJsonSecure(file);
    for (const item of data.items ?? []) {
      const evaluation = item.evaluation;
      if (!evaluation) continue;
      const mapped = byEvaluationId[item.mistakeId]?.new
        ?? oldToNew[evaluation.payloadSha256]
        ?? evaluation.payloadSha256;
      evaluation.payloadSha256 = mapped;
    }
    writeJsonSecure(file, data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function migrateStoreV2(storeDir, digestMapFile) {
  const map = JSON.parse(fs.readFileSync(digestMapFile, 'utf8'));
  const oldToNew = map.oldToNew ?? {};
  const byEvaluationId = map.byEvaluationId ?? {};
  const store = createProfileStore(storeDir);
  const profile = await store.migrateDigests({ oldToNew, byEvaluationId });
  resignMistakes(storeDir, { oldToNew, byEvaluationId });
  return profile;
}

export async function completeSessionStoreMigration(storeDir, sessionDir) {
  const markerFile = path.join(sessionDir, 'training', '.migration-v2.json');
  if (!fs.existsSync(markerFile)) return { completed: false };
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    return { completed: false };
  }
  if (marker.status === 'complete') return { completed: false };
  if (marker.status !== 'session-done') return { completed: false };
  const mapFile = path.join(sessionDir, 'training', '.digest-map-v2.json');
  if (!fs.existsSync(mapFile)) return { completed: false };
  await migrateStoreV2(storeDir, mapFile);
  fs.writeFileSync(markerFile, JSON.stringify({
    ...marker,
    status: 'complete',
    completedAt: new Date().toISOString(),
  }));
  return { completed: true };
}

export async function completeSessionStoreMigrations(storeDir) {
  const sessionsRoot = path.join(storeDir, '.session-store', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return { completed: 0, notices: [] };
  let completed = 0;
  const notices = [];
  for (const name of fs.readdirSync(sessionsRoot)) {
    try {
      const result = await completeSessionStoreMigration(storeDir, path.join(sessionsRoot, name));
      if (result.completed) completed += 1;
    } catch (error) {
      notices.push(`store migration 실패 (${name}): ${error.code ?? 'ERROR'}`);
    }
  }
  return { completed, notices };
}

export function writePracticeFocus(storeDir, profile) {
  const leaks = (profile.leaks ?? []).slice(0, 3).map((leak) => ({
    id: leak.id,
    recommendedDrill: leak.recommendedDrill,
    severity: leak.severity,
    confidence: leak.confidence,
  }));
  const file = path.join(storeDir, '.training', 'practice-focus.json');
  writeJsonSecure(file, { schemaVersion: 1, leaks, focus: leaks[0]?.recommendedDrill ?? null });
  return file;
}

function assertPracticeFocusLeak(leak) {
  if (leak === null || typeof leak !== 'object' || Array.isArray(leak)) {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus leak 항목이 올바르지 않습니다.');
  }
  for (const key of Object.keys(leak)) {
    if (!PRACTICE_FOCUS_LEAK_KEYS.has(key)) {
      throw coded('BAD_PRACTICE_FOCUS', `practice-focus leak 여분 키: ${key}`);
    }
  }
  if (typeof leak.id !== 'string' || typeof leak.recommendedDrill !== 'string') {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus leak 문자열이 올바르지 않습니다.');
  }
  if (!Number.isFinite(leak.severity) || !Number.isFinite(leak.confidence)) {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus leak 숫자가 올바르지 않습니다.');
  }
}

function assertPracticeFocusSchema(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus JSON 스키마가 올바르지 않습니다.');
  }
  for (const key of Object.keys(value)) {
    if (!PRACTICE_FOCUS_KEYS.has(key)) {
      throw coded('BAD_PRACTICE_FOCUS', `practice-focus 여분 키: ${key}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'focus')) {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus.focus가 필요합니다.');
  }
  if (value.focus !== null && typeof value.focus !== 'string') {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus.focus 타입이 올바르지 않습니다.');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'schemaVersion') && value.schemaVersion !== 1) {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus.schemaVersion이 올바르지 않습니다.');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'leaks')) {
    if (!Array.isArray(value.leaks) || value.leaks.length > 3) {
      throw coded('BAD_PRACTICE_FOCUS', 'practice-focus.leaks가 올바르지 않습니다.');
    }
    for (const leak of value.leaks) assertPracticeFocusLeak(leak);
  }
}

function readPracticeFocusContained(root, segments) {
  const bytes = openContained(root, segments, { maxBytes: PRACTICE_FOCUS_MAX_BYTES });
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw coded('BAD_PRACTICE_FOCUS', 'practice-focus JSON을 파싱할 수 없습니다.');
  }
  assertPracticeFocusSchema(value);
  return { value, bytes };
}

export function loadAutoPracticeFocus(storeDir) {
  try {
    const { value, bytes } = readPracticeFocusContained(storeDir, PRACTICE_FOCUS_SEGMENTS);
    return { status: 'ok', value, bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' };
    if (error.code === 'UNSAFE_PATH') {
      return {
        status: 'ignored',
        code: 'UNSAFE_PATH',
        notice: 'practice-focus 자동 선택을 건너뜁니다: UNSAFE_PATH',
      };
    }
    throw error;
  }
}

export function defaultPracticeFocusFile(storeDir) {
  const loaded = loadAutoPracticeFocus(storeDir);
  if (loaded.status === 'ok') return path.join(storeDir, ...PRACTICE_FOCUS_SEGMENTS);
  return null;
}

export function installPracticeFocus({ destRoot, storeDir, practiceFocusFile, onNotice } = {}) {
  let bytes;
  if (practiceFocusFile !== undefined) {
    const resolved = path.resolve(practiceFocusFile);
    ({ bytes } = readPracticeFocusContained(path.dirname(resolved), [path.basename(resolved)]));
  } else if (storeDir) {
    const loaded = loadAutoPracticeFocus(storeDir);
    if (loaded.status !== 'ok') {
      if (loaded.notice && typeof onNotice === 'function') onNotice(loaded.notice);
      return loaded;
    }
    bytes = loaded.bytes;
  } else {
    return { status: 'absent' };
  }
  writeContained(destRoot, PRACTICE_FOCUS_DEST, bytes, { mode: 'replace' });
  return { status: 'ok' };
}

export function readInstalledPracticeFocus(gameDir) {
  try {
    return openContained(gameDir, PRACTICE_FOCUS_DEST, { maxBytes: PRACTICE_FOCUS_MAX_BYTES }).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const storeDir = flags['store-dir'];
  if (!storeDir) fail('USAGE', '--store-dir가 필요합니다.');
  const store = createProfileStore(storeDir);
  if (cmd === 'apply') {
    const file = flags['evaluation-file'];
    if (!file) fail('USAGE', '--evaluation-file이 필요합니다.');
    const evaluation = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = await store.apply(evaluation);
    const profile = result.profile ?? result;
    writePracticeFocus(storeDir, profile);
    fs.writeSync(1, `${JSON.stringify({ ok: true, profile, applied: result.applied !== false })}\n`);
    return;
  }
  if (cmd === 'migrate-v2') {
    const mapFile = flags['digest-map'];
    if (!mapFile) fail('USAGE', '--digest-map가 필요합니다.');
    const profile = await migrateStoreV2(storeDir, mapFile);
    fs.writeSync(1, `${JSON.stringify({ ok: true, profile })}\n`);
    return;
  }
  if (cmd === 'show') {
    const profile = await store.show();
    fs.writeSync(1, `${JSON.stringify({ ok: true, profile })}\n`);
    return;
  }
  if (cmd === 'rebuild') {
    const profile = await store.rebuild();
    writePracticeFocus(storeDir, profile);
    fs.writeSync(1, `${JSON.stringify({ ok: true, profile })}\n`);
    return;
  }
  if (cmd === 'reset') {
    const profile = await store.reset();
    writePracticeFocus(storeDir, profile);
    fs.writeSync(1, `${JSON.stringify({ ok: true, profile })}\n`);
    return;
  }
  if (cmd === 'sweep') {
    const result = await sweepStore(storeDir);
    fs.writeSync(1, `${JSON.stringify({
      ok: true,
      applied: result.applied,
      profile: result.profile,
      notices: result.notices,
    })}\n`);
    return;
  }
  fail('USAGE', 'apply|show|rebuild|reset|sweep|migrate-v2만 지원합니다.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'ERROR', error.message));
}
