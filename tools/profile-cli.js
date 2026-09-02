#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from '../training/profile-store.js';
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

function sessionRoots(storeDir) {
  const sessions = path.join(storeDir, '.session-store', 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs.readdirSync(sessions)
    .map((name) => path.join(sessions, name, 'training', 'evaluations.jsonl'))
    .filter((file) => fs.existsSync(file));
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

export async function completeSessionStoreMigrations(storeDir) {
  const sessionsRoot = path.join(storeDir, '.session-store', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return { completed: 0 };
  let completed = 0;
  for (const name of fs.readdirSync(sessionsRoot)) {
    const sessionDir = path.join(sessionsRoot, name);
    const markerFile = path.join(sessionDir, 'training', '.migration-v2.json');
    if (!fs.existsSync(markerFile)) continue;
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    } catch {
      continue;
    }
    if (marker.status === 'complete') continue;
    if (marker.status !== 'session-done') continue;
    const mapFile = path.join(sessionDir, 'training', '.digest-map-v2.json');
    if (!fs.existsSync(mapFile)) continue;
    await migrateStoreV2(storeDir, mapFile);
    fs.writeFileSync(markerFile, JSON.stringify({
      ...marker,
      status: 'complete',
      completedAt: new Date().toISOString(),
    }));
    completed += 1;
  }
  return { completed };
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
    let applied = 0;
    for (const file of sessionRoots(storeDir)) {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let evaluation;
        try { evaluation = JSON.parse(line); } catch { continue; }
        if (!evaluation?.evaluationId) continue;
        const before = (await store.show()).overall.evaluatedDecisions;
        await store.apply(evaluation);
        const after = (await store.show()).overall.evaluatedDecisions;
        if (after > before) applied += 1;
      }
    }
    const profile = await store.show();
    writePracticeFocus(storeDir, profile);
    fs.writeSync(1, `${JSON.stringify({ ok: true, applied, profile })}\n`);
    return;
  }
  fail('USAGE', 'apply|show|rebuild|reset|sweep|migrate-v2만 지원합니다.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'ERROR', error.message));
}
