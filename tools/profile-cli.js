#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from '../training/profile-store.js';
import { writeJsonSecure } from './training-store.js';

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

export function defaultPracticeFocusFile(storeDir) {
  const file = path.join(storeDir, '.training', 'practice-focus.json');
  return fs.existsSync(file) ? file : null;
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
    const profile = await store.apply(evaluation);
    writePracticeFocus(storeDir, profile);
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
  fail('USAGE', 'apply|show|rebuild|reset|sweep만 지원합니다.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'ERROR', error.message));
}
