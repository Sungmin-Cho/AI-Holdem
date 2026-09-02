import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../engine/state.js';
import { assignmentFor, policyById } from '../training/policies/catalog.js';
import { validatePolicyOutput } from '../training/policies/contracts.js';
import { applyDeviations } from '../training/policies/deviation.js';
import { loadPreflopJson } from '../training/providers/preflop-json.js';
import { baselineDistribution } from '../training/policies/baseline.js';

const BASELINE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../training/data/preflop-baseline-v1.json',
);

function loadPinnedBaseline() {
  const shaPath = BASELINE_JSON.replace(/\.json$/, '.sha256');
  const expectedSha256 = fs.readFileSync(shaPath, 'utf8').trim();
  return loadPreflopJson(BASELINE_JSON, { expectedSha256 });
}

let pinnedBaseline = null;
function baselineDataset() {
  if (!pinnedBaseline) pinnedBaseline = loadPinnedBaseline();
  return pinnedBaseline;
}
import { deriveUnit, sampleWeighted } from '../training/policies/rng.js';
import { ruleBasedDistribution } from '../training/policies/rule-based.js';

export function distributionFor(snapshot, legal, policy) {
  const config = typeof policy === 'string' ? policyById(policy) : policy;
  if (!config) {
    const error = new Error('unknown policy');
    error.code = 'UNKNOWN_POLICY';
    throw error;
  }
  const bb = snapshot?.blinds?.[1];
  const base = config.base === 'baseline-v1' || config.policyId === 'baseline-v1' || config.base == null
    ? baselineDistribution(snapshot, legal, { dataset: baselineDataset(), config: config.frequencies })
    : ruleBasedDistribution(legal, config.frequencies, { bb });
  const shifted = applyDeviations(base, config.deviations, snapshot, legal, { bb });
  return shifted.length ? shifted : base;
}

export function decide({ snapshot, legal, policy, policySeed, gameEpoch }) {
  const config = typeof policy === 'string' ? policyById(policy) : (policyById(policy?.policyId) ?? policy);
  const items = distributionFor(snapshot, legal, config);
  const unit = deriveUnit(policySeed, gameEpoch, snapshot.decisionId, config.policyId);
  const sampled = sampleWeighted(items, unit);
  return validatePolicyOutput({
    action: sampled.action,
    amount: sampled.amount,
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    sampledProbability: sampled.frequency,
    reasonCode: sampled.reasonCode ?? 'sampled',
  }, legal);
}

export function stampPlayerPolicies(gameDir) {
  const file = path.join(gameDir, 'players.json');
  const players = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(players)) {
    const error = new Error('players.json이 배열이 아닙니다.');
    error.code = 'BAD_PLAYERS';
    throw error;
  }
  for (const player of players) {
    if (player.playerId === 'user') continue;
    player.policy = assignmentFor(player.archetype);
  }
  writeJsonAtomic(file, players);
  return players;
}
