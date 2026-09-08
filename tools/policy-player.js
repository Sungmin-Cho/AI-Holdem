import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import {
  assignmentFor,
  DERIVED_POLICY_FAMILIES,
  isStrategyMirror,
  isStrategyV2,
  policyById,
  resolveStoredPolicy,
  SELF_ARCHETYPES,
  VERSION_V2,
} from '../training/policies/catalog.js';
import { validatePolicyOutput } from '../training/policies/contracts.js';
import { applyDeviations } from '../training/policies/deviation.js';
import { loadPreflopDataset } from './preflop-dataset.js';
import { baselineDistribution } from '../training/policies/baseline.js';
import { openContained, writeContained } from './training-store.js';

let pinnedBaseline = null;
function baselineDataset() {
  if (!pinnedBaseline) pinnedBaseline = loadPreflopDataset();
  return pinnedBaseline;
}
import { deriveUnit, sampleWeighted } from '../training/policies/rng.js';
import { ruleBasedDistribution } from '../training/policies/rule-based.js';
import { distributionMirror } from '../training/policies/strategy-mirror.js';
import { distributionV2 } from '../training/policies/strategy-v2.js';

export const DERIVED_CONFIGS_FILE = '.policy-configs.json';
const DERIVED_CONFIGS_MAX_BYTES = 1024 * 1024;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function readDerivedPolicyConfigs(gameDir) {
  let buf;
  try {
    buf = openContained(gameDir, [DERIVED_CONFIGS_FILE], { maxBytes: DERIVED_CONFIGS_MAX_BYTES });
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    coded('POLICY_CONFIGS_CORRUPT', 'derived policy configs are not valid JSON');
  }
  if (
    parsed?.schemaVersion !== 1
    || parsed.configs == null
    || typeof parsed.configs !== 'object'
    || Array.isArray(parsed.configs)
  ) {
    coded('POLICY_CONFIGS_CORRUPT', 'derived policy configs schema is invalid');
  }
  return parsed.configs;
}

export function writeDerivedPolicyConfigs(gameDir, configs) {
  writeContained(
    gameDir,
    [DERIVED_CONFIGS_FILE],
    Buffer.from(JSON.stringify({ schemaVersion: 1, configs })),
    { mode: 'create' },
  );
}

function resolvePolicyInput(policy, { derived } = {}) {
  if (typeof policy === 'string') {
    const config = policyById(policy);
    if (config) return config;
    coded('UNKNOWN_POLICY', 'unknown policy');
  }
  return resolveStoredPolicy(policy, { derived }).config;
}

export function distributionFor(snapshot, legal, policy, { derived } = {}) {
  const config = resolvePolicyInput(policy, { derived });
  if (isStrategyMirror(config)) return distributionMirror(snapshot, legal, config);
  if (isStrategyV2(config)) return distributionV2(snapshot, legal, config);
  const bb = snapshot?.blinds?.[1];
  const base = config.base === 'baseline-v1' || config.policyId === 'baseline-v1' || config.base == null
    ? baselineDistribution(snapshot, legal, { dataset: baselineDataset(), config: config.frequencies })
    : ruleBasedDistribution(legal, config.frequencies, { bb });
  const shifted = applyDeviations(base, config.deviations, snapshot, legal, { bb });
  return shifted.length ? shifted : base;
}

export function decide({ snapshot, legal, policy, policySeed, gameEpoch, derived }) {
  const config = resolvePolicyInput(policy, { derived });
  const items = distributionFor(snapshot, legal, config, { derived });
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
    coded('BAD_PLAYERS', 'players.json이 배열이 아닙니다.');
  }
  const derived = readDerivedPolicyConfigs(gameDir);
  let changed = false;
  const rolled = [];
  let rolledFrom = null;
  const derivedRolled = [];
  let derivedRolledFrom = null;
  for (const player of players) {
    if (player.playerId === 'user') continue;
    if (player.policy) {
      const { config, rolledForwardFrom } = resolveStoredPolicy(player.policy, { derived });
      if (rolledForwardFrom) {
        if (Object.hasOwn(DERIVED_POLICY_FAMILIES, config.policyId)) {
          derivedRolled.push(player.playerId);
          derivedRolledFrom = rolledForwardFrom;
        } else {
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
      }
      continue;
    }
    if (SELF_ARCHETYPES.includes(player.archetype)) {
      coded('SELF_OPPONENT_INCOMPLETE', 'self-opponent seat is missing a derived policy');
    }
    player.policy = assignmentFor(player.archetype);
    changed = true;
  }
  if (rolled.length) onNotice?.(`policy roll-forward ${rolledFrom}→${VERSION_V2}: ${rolled.join(',')}`);
  if (derivedRolled.length) {
    onNotice?.(`self-opponent strategy roll-forward ${derivedRolledFrom}→${VERSION_V2}: ${derivedRolled.join(',')}`);
  }
  if (changed) writeJsonAtomic(file, players);
  return players;
}
