#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { solvePostflop, DEFAULT_SOLVER_ADAPTER } from './solver-adapter.js';
import { evaluateSolvedDecision } from '../training/postflop/solved-decision.js';

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

function gameEpochOf(sessionToken) {
  return createHash('sha256').update(String(sessionToken)).digest('hex');
}

function loadHand(gameDir, handNo) {
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'), 'utf8'));
  if (state.lastHand?.handNo === handNo) return { state, record: state.lastHand };
  const file = path.join(gameDir, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
  return { state, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

// `--game-dir --hand N --decision <id>`는 한 postflop 결정을 풀어 evaluate CLI와
// 같은 모양의 evaluation 봉투를 돌려준다. 플래그가 없으면 예전처럼 raw solver
// 결과만 출력한다.
async function runDecision(flags) {
  const gameDir = path.resolve(flags['game-dir']);
  const handNo = Number(flags.hand);
  const decisionId = flags.decision;
  if (!Number.isInteger(handNo) || handNo < 1) fail('USAGE', '--hand N이 필요합니다.');
  let loaded;
  try {
    loaded = loadHand(gameDir, handNo);
  } catch (error) {
    fail('HAND_NOT_FOUND', error.message);
  }
  if (!loaded.state?.sessionToken) fail('EVALUATION_ID_INVALID', 'gameEpoch가 없습니다.');
  const snapshot = (loaded.record.decisions ?? [])
    .find((snap) => snap.actorId === 'user' && snap.decisionId === decisionId);
  if (!snapshot) fail('DECISION_NOT_FOUND', `${decisionId}를 찾지 못했습니다.`);

  const result = await solvePostflop(snapshot, {
    adapterId: flags.adapter ?? DEFAULT_SOLVER_ADAPTER,
    timeoutMs: flags.timeout ? Number(flags.timeout) : 2_000,
    gameDir,
  });
  const evaluation = evaluateSolvedDecision(snapshot, result, {
    gameEpoch: gameEpochOf(loaded.state.sessionToken),
  });
  fs.writeSync(1, `${JSON.stringify({ ok: true, handNo, evaluations: [evaluation] })}\n`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.decision) {
    if (!flags['game-dir']) fail('USAGE', '--decision에는 --game-dir가 필요합니다.');
    await runDecision(flags);
    return;
  }
  const snapshot = flags.snapshot
    ? JSON.parse(fs.readFileSync(flags.snapshot, 'utf8'))
    : { street: 'flop', board: ['Ah', 'Kd', '2c'] };
  const result = await solvePostflop(snapshot, {
    adapterId: flags.adapter ?? DEFAULT_SOLVER_ADAPTER,
    timeoutMs: flags.timeout ? Number(flags.timeout) : 2_000,
    gameDir: flags['game-dir'] ? path.resolve(flags['game-dir']) : null,
  });
  fs.writeSync(1, `${JSON.stringify({ ok: true, result })}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'SOLVER_FAILED', error.message));
}

export { main };
