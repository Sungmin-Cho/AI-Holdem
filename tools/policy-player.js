import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import { assignmentFor, isStrategyV2, policyById, resolveStoredPolicy, VERSION_V2 } from '../training/policies/catalog.js';
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
import { distributionV2 } from '../training/policies/strategy-v2.js';

function resolvePolicyInput(policy) {
  if (typeof policy === 'string') {
    const config = policyById(policy);
    if (config) return config;
    const error = new Error('unknown policy');
    error.code = 'UNKNOWN_POLICY';
    throw error;
  }
  return resolveStoredPolicy(policy).config;
}

export function distributionFor(snapshot, legal, policy) {
  const config = resolvePolicyInput(policy);
  if (isStrategyV2(config)) return distributionV2(snapshot, legal, config);
  const bb = snapshot?.blinds?.[1];
  const base = config.base === 'baseline-v1' || config.policyId === 'baseline-v1' || config.base == null
    ? baselineDistribution(snapshot, legal, { dataset: baselineDataset(), config: config.frequencies })
    : ruleBasedDistribution(legal, config.frequencies, { bb });
  const shifted = applyDeviations(base, config.deviations, snapshot, legal, { bb });
  return shifted.length ? shifted : base;
}

export function decide({ snapshot, legal, policy, policySeed, gameEpoch }) {
  const config = resolvePolicyInput(policy);
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

export function stampPlayerPolicies(gameDir, { onNotice } = {}) {
  const file = path.join(gameDir, 'players.json');
  const players = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(players)) {
    const error = new Error('players.json이 배열이 아닙니다.');
    error.code = 'BAD_PLAYERS';
    throw error;
  }
  let changed = false;
  const rolled = [];
  let rolledFrom = null;
  for (const player of players) {
    if (player.playerId === 'user') continue;
    if (player.policy) {
      const { config, rolledForwardFrom } = resolveStoredPolicy(player.policy);
      if (rolledForwardFrom) {
        player.policy = {
          ...player.policy,
          policyId: config.policyId,
          policyVersion: config.policyVersion,
          configDigest: config.configDigest,
        };
        changed = true;
        rolled.push(player.playerId);
        rolledFrom = rolledForwardFrom;
      }
      continue;
    }
    player.policy = assignmentFor(player.archetype);
    changed = true;
  }
  if (rolled.length) onNotice?.(`policy roll-forward ${rolledFrom}→${VERSION_V2}: ${rolled.join(',')}`);
  if (changed) writeJsonAtomic(file, players);
  return players;
}
