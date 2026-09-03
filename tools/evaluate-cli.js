#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateDecision } from '../training/decision-evaluator.js';
import { lookup } from '../training/providers/preflop-json.js';
import { loadPreflopDataset } from './preflop-dataset.js';
import { handClassOf } from '../training/cards.js';
import { normalizePreflopSpot } from '../training/preflop-spot.js';

const DATASET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../training/data/preflop-baseline-v1.json',
);

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
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail('USAGE', `${arg}의 값이 필요합니다.`);
    flags[name] = value;
    i += 1;
  }
  return { flags, positional };
}

function gameEpochOf(sessionToken) {
  return createHash('sha256').update(String(sessionToken)).digest('hex');
}

// providerId 문법과 같은 어휘만 허용한다 — evaluationId가 adapterId를 provider로
// 쓰기 때문에 여기서 걸러야 accept 단계에서 EVALUATION_ID_INVALID가 나지 않는다.
const ADAPTER_ID = /^[a-z0-9-]{1,64}$/;

function loadHand(gameDir, n) {
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'), 'utf8'));
  const padded = String(n).padStart(4, '0');
  const file = path.join(gameDir, 'hands', `hand-${padded}.json`);
  const record = state.lastHand?.handNo === n
    ? state.lastHand
    : JSON.parse(fs.readFileSync(file, 'utf8'));
  return { state, record };
}

function main() {
  try {
    runEvaluate();
  } catch (error) {
    fail(error.code ?? 'EVALUATION_FAILED', error.message);
  }
}

function runEvaluate() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd !== 'evaluate') fail('USAGE', 'evaluate만 지원합니다.');
  const gameDir = flags['game-dir'];
  const handNo = Number(flags.hand);
  if (!gameDir || !Number.isInteger(handNo) || handNo < 1) {
    fail('USAGE', '--game-dir와 --hand N이 필요합니다.');
  }
  const solverAdapterId = flags.solver ?? null;
  if (solverAdapterId != null && !ADAPTER_ID.test(solverAdapterId)) {
    fail('USAGE', '--solver는 [a-z0-9-] 64자 이내 adapterId입니다.');
  }
  let loaded;
  try {
    loaded = loadHand(gameDir, handNo);
  } catch (error) {
    fail('HAND_NOT_FOUND', error.message);
  }
  const datasetPath = flags.dataset ?? DATASET;
  let data;
  let contentSha256;
  try {
    ({ data, contentSha256 } = loadPreflopDataset(datasetPath));
  } catch (error) {
    fail('DATASET_INVALID', error.message);
  }
  const source = {
    id: data.id,
    version: data.version,
    license: data.license,
    contentSha256,
  };
  if (!loaded.state?.sessionToken) fail('EVALUATION_ID_INVALID', 'gameEpoch가 없습니다.');
  const gameEpoch = gameEpochOf(loaded.state.sessionToken);
  const decisions = (loaded.record.decisions ?? []).filter((snap) => snap.actorId === 'user');
  const evaluations = [];
  const pendingSolve = [];
  for (const snapshot of decisions) {
    // --solver를 켜면 postflop 결정은 unsupported item으로 accept하지 않고 solve로
    // 미룬다. 먼저 unsupported item이 생기면 solve 결과 accept가 같은
    // decisionId에 다른 digest를 붙여 EVALUATION_CONFLICT가 된다.
    if (solverAdapterId && snapshot.street !== 'preflop') {
      pendingSolve.push(snapshot.decisionId);
      continue;
    }
    const handClass = handClassOf(snapshot.holeCards);
    const spot = normalizePreflopSpot(snapshot);
    const strategy = spot.ok
      ? lookup({ data, contentSha256 }, { spotKey: spot.spotKey, handClass })
      : { status: 'unsupported', reason: spot.reason, source };
    evaluations.push(evaluateDecision(snapshot, strategy, { gameEpoch }));
  }
  const out = { ok: true, handNo, evaluations };
  if (solverAdapterId) out.pendingSolve = pendingSolve;
  fs.writeSync(1, `${JSON.stringify(out)}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}

export { main };
