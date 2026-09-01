#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solvePostflop } from '../training/providers/solver-adapter.js';

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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const snapshot = flags.snapshot
    ? JSON.parse(fs.readFileSync(flags.snapshot, 'utf8'))
    : { street: 'flop', board: ['Ah', 'Kd', '2c'] };
  const result = await solvePostflop(snapshot, {
    timeoutMs: flags.timeout ? Number(flags.timeout) : 2_000,
    gameDir: flags['game-dir'] ? path.resolve(flags['game-dir']) : null,
  });
  fs.writeSync(1, `${JSON.stringify({ ok: true, result })}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'SOLVER_FAILED', error.message));
}
