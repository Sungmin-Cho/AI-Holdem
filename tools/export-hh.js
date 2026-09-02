#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExportDir } from '../export/hand-normalizer.js';
import { buildCanonical, buildText } from '../export/manifest.js';
import { ensureDir, writeContained } from './training-store.js';

function fail(code, message) {
  fs.writeSync(1, `${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail('USAGE', `알 수 없는 인자: ${arg}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail('USAGE', `${arg}의 값이 필요합니다.`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return flags;
}

function resolveContainedOutput(outPath) {
  const resolved = path.resolve(outPath);
  const fileName = path.basename(resolved);
  if (!fileName || fileName === '.' || fileName === '..') {
    const err = new Error('출력 파일명이 올바르지 않습니다.');
    err.code = 'BAD_SEGMENT';
    throw err;
  }
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let index = 0;
  let seenRealDir = false;
  while (index < parts.length) {
    const next = path.join(current, parts[index]);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
    if (st.isSymbolicLink()) {
      if (seenRealDir) break;
      current = fs.realpathSync(next);
      index += 1;
      continue;
    }
    if (st.isDirectory()) {
      seenRealDir = true;
      current = next;
      index += 1;
      continue;
    }
    break;
  }
  const segments = parts.slice(index);
  if (segments.length === 0) {
    const err = new Error('출력 경로가 안전하지 않습니다.');
    err.code = 'UNSAFE_PATH';
    throw err;
  }
  let made = current;
  for (const segment of segments.slice(0, -1)) {
    made = path.join(made, segment);
    ensureDir(made);
  }
  return { root: current, segments };
}

function main() {
  try {
    const flags = parseArgs(process.argv.slice(2));
    const gameDir = resolveExportDir({ gameDir: flags['game-dir'], storeDir: flags['store-dir'] });
    const gameSt = fs.lstatSync(gameDir);
    if (gameSt.isSymbolicLink() || !gameSt.isDirectory()) {
      fail('UNSAFE_PATH', '입력 경로가 안전하지 않습니다.');
    }
    const format = flags.format ?? 'canonical-json';
    const exportedAt = flags['exported-at'] ?? new Date().toISOString();
    const canonical = buildCanonical(gameDir, { exportedAt });
    let body;
    let warnings = canonical.warnings;
    if (format === 'canonical-json') {
      body = `${JSON.stringify(canonical, null, 2)}\n`;
    } else if (format === 'pokerstars') {
      const rendered = buildText(canonical, { exportedAt });
      body = rendered.text.endsWith('\n') ? rendered.text : `${rendered.text}\n`;
      warnings = rendered.warnings;
    } else {
      fail('USAGE', 'format은 canonical-json 또는 pokerstars입니다.');
    }
    const out = flags.out ?? path.join(
      gameDir,
      'exports',
      format === 'pokerstars' ? 'session.txt' : 'session.json',
    );
    const { root, segments } = resolveContainedOutput(out);
    writeContained(root, segments, body, { mode: 'create' });
    const safe = path.join(root, ...segments);
    fs.writeSync(1, `${JSON.stringify({ ok: true, out: safe, hands: canonical.hands.length, warnings })}\n`);
  } catch (error) {
    fail(error.code ?? 'EXPORT_FAILED', error.message);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) main();
