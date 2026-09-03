import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import { assignmentFor, policyById } from '../training/policies/catalog.js';
import { validatePolicyOutput } from '../training/policies/contracts.js';
import { applyDeviations } from '../training/policies/deviation.js';
import { loadPreflopDataset } from './preflop-dataset.js';
import { baselineDistribution } from '../training/policies/baseline.js';

let pinnedBaseline = null;
function baselineDataset() {
  if (!pinnedBaseline) pinnedBaseline = loadPreflopDataset();
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
    if (player.policy) {
      const catalog = policyById(player.policy.policyId);
      if (
        !catalog
        || catalog.policyVersion !== player.policy.policyVersion
        || catalog.configDigest !== player.policy.configDigest
      ) {
        const error = new Error('players.json policy가 catalog와 일치하지 않습니다.');
        error.code = 'POLICY_CONFIG_MISMATCH';
        throw error;
      }
      continue;
    }
    player.policy = assignmentFor(player.archetype);
  }
  writeJsonAtomic(file, players);
  return players;
}
