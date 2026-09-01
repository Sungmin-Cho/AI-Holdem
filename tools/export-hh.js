#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExportDir } from '../export/hand-normalizer.js';
import { buildCanonical, buildText } from '../export/manifest.js';

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

function assertSafeOut(outPath) {
  const resolved = path.resolve(outPath);
  let st;
  try { st = fs.lstatSync(resolved); } catch (error) {
    if (error.code === 'ENOENT') return resolved;
    throw error;
  }
  if (st.isSymbolicLink()) fail('UNSAFE_PATH', 'symlink 출력 경로는 거부합니다.');
  if (st.isFile()) fail('EXISTS', '이미 있는 파일을 덮어쓰지 않습니다.');
  return resolved;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const gameDir = resolveExportDir({ gameDir: flags['game-dir'], storeDir: flags['store-dir'] });
  const format = flags.format ?? 'canonical-json';
  const exportedAt = flags['exported-at'] ?? new Date().toISOString();
  const canonical = buildCanonical(gameDir, { exportedAt });
  let body;
  if (format === 'canonical-json') body = `${JSON.stringify(canonical, null, 2)}\n`;
  else if (format === 'pokerstars') body = `${buildText(canonical, { exportedAt }).text}\n`;
  else fail('USAGE', 'format은 canonical-json 또는 pokerstars입니다.');
  const out = flags.out ?? path.join(gameDir, 'exports', format === 'pokerstars' ? 'session.txt' : 'session.json');
  const safe = assertSafeOut(out);
  fs.mkdirSync(path.dirname(safe), { recursive: true });
  fs.writeFileSync(safe, body, { flag: 'wx' });
  fs.writeSync(1, `${JSON.stringify({ ok: true, out: safe, hands: canonical.hands.length, warnings: canonical.warnings })}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) main();
