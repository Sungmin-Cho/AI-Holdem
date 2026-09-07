import { configDigestOf } from './contracts.js';

const VERSION = '1.0.0';
export const VERSION_V2 = '2.1.0';
export const PREDECESSOR_VERSIONS_V2 = Object.freeze(['2.0.0']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function completePolicy(config) {
  return deepFreeze({ ...config, configDigest: configDigestOf(config) });
}

function policy(policyId, extras = {}) {
  const config = {
    policyId,
    policyVersion: VERSION,
    base: extras.base ?? 'baseline-v1',
    fallback: 'rule-based-v1',
    frequencies: extras.frequencies ?? {
      checkFreq: 0.75,
      foldVsBet: 0.55,
      callVsBet: 0.35,
      raiseVsBet: 0.10,
    },
    deviations: extras.deviations ?? [],
  };
  return completePolicy(config);
}

function policyV2(policyId, persona, traits) {
  const config = {
    policyId,
    policyVersion: VERSION_V2,
    base: 'strategy-v2',
    persona,
    traits,
  };
  return completePolicy(config);
}

export const POLICIES = Object.freeze({
  'baseline-v1': policy('baseline-v1', { base: null }),
  'tag-v1': policy('tag-v1', {
    frequencies: { checkFreq: 0.78, foldVsBet: 0.58, callVsBet: 0.30, raiseVsBet: 0.12 },
  }),
  'lag-v1': policy('lag-v1', {
    frequencies: { checkFreq: 0.55, foldVsBet: 0.28, callVsBet: 0.32, raiseVsBet: 0.40 },
  }),
  'nit-v1': policy('nit-v1', {
    frequencies: { checkFreq: 0.90, foldVsBet: 0.82, callVsBet: 0.14, raiseVsBet: 0.04 },
  }),
  'calling-station-v1': policy('calling-station-v1', {
    frequencies: { checkFreq: 0.70, foldVsBet: 0.18, callVsBet: 0.74, raiseVsBet: 0.08 },
    deviations: [
      {
        selector: { street: 'river', facingBet: true },
        operation: 'shift',
        from: 'fold',
        to: 'call',
        probability: 0.20,
      },
    ],
  }),
  'maniac-v1': policy('maniac-v1', {
    frequencies: { checkFreq: 0.28, foldVsBet: 0.12, callVsBet: 0.20, raiseVsBet: 0.68 },
  }),
  'baseline-v2': policyV2('baseline-v2', 'baseline', {
    tightness: 0.52, aggression: 0.52, calling: 0.42, bluff: 0.14,
  }),
  'tag-v2': policyV2('tag-v2', 'TAG', {
    tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12,
  }),
  'lag-v2': policyV2('lag-v2', 'LAG', {
    tightness: 0.38, aggression: 0.70, calling: 0.47, bluff: 0.20,
  }),
  'nit-v2': policyV2('nit-v2', 'Nit', {
    tightness: 0.78, aggression: 0.35, calling: 0.25, bluff: 0.05,
  }),
  'calling-station-v2': policyV2('calling-station-v2', 'CallingStation', {
    tightness: 0.45, aggression: 0.18, calling: 0.80, bluff: 0.04,
  }),
  'maniac-v2': policyV2('maniac-v2', 'Maniac', {
    tightness: 0.15, aggression: 0.90, calling: 0.55, bluff: 0.50,
  }),
  'trickster-v2': policyV2('trickster-v2', 'Trickster', {
    tightness: 0.48, aggression: 0.80, calling: 0.48, bluff: 0.32,
  }),
});

export const ARCHETYPE_POLICY_ID = Object.freeze({
  TAG: 'tag-v2',
  LAG: 'lag-v2',
  Nit: 'nit-v2',
  CallingStation: 'calling-station-v2',
  Maniac: 'maniac-v2',
  Trickster: 'trickster-v2',
});

export function policyById(policyId) {
  if (typeof policyId !== 'string' || !Object.hasOwn(POLICIES, policyId)) return null;
  return POLICIES[policyId];
}

export function isStrategyV2(config) {
  return config?.base === 'strategy-v2';
}

export function resolveStoredPolicy(stored) {
  const descriptors = stored && typeof stored === 'object'
    ? Object.fromEntries(['policyId', 'policyVersion', 'configDigest'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(stored, key)],
    ))
    : {};
  const complete = ['policyId', 'policyVersion', 'configDigest'].every(
    (key) => descriptors[key] && Object.hasOwn(descriptors[key], 'value'),
  );
  const policyId = complete ? descriptors.policyId.value : null;
  const config = typeof policyId === 'string' && Object.hasOwn(POLICIES, policyId)
    ? POLICIES[policyId]
    : null;
  if (!config) {
    const error = new Error('stored policy identity does not match the catalog');
    error.code = 'POLICY_CONFIG_MISMATCH';
    throw error;
  }
  if (
    descriptors.policyVersion.value === config.policyVersion
    && descriptors.configDigest.value === config.configDigest
  ) {
    return { config, rolledForwardFrom: null };
  }
  if (isStrategyV2(config)) {
    for (const prev of PREDECESSOR_VERSIONS_V2) {
      const digest = configDigestOf({ ...config, policyVersion: prev });
      if (
        descriptors.policyVersion.value === prev
        && descriptors.configDigest.value === digest
      ) {
        return { config, rolledForwardFrom: prev };
      }
    }
  }
  const error = new Error('stored policy identity does not match the catalog');
  error.code = 'POLICY_CONFIG_MISMATCH';
  throw error;
}

export function resolveExactPolicy(stored) {
  const descriptors = stored && typeof stored === 'object'
    ? Object.fromEntries(['policyId', 'policyVersion', 'configDigest'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(stored, key)],
    ))
    : {};
  const complete = ['policyId', 'policyVersion', 'configDigest'].every(
    (key) => descriptors[key] && Object.hasOwn(descriptors[key], 'value'),
  );
  const policyId = complete ? descriptors.policyId.value : null;
  const config = typeof policyId === 'string' && Object.hasOwn(POLICIES, policyId)
    ? POLICIES[policyId]
    : null;
  if (
    !config
    || descriptors.policyVersion.value !== config.policyVersion
    || descriptors.configDigest.value !== config.configDigest
  ) {
    const error = new Error('stored policy identity does not match the catalog');
    error.code = 'POLICY_CONFIG_MISMATCH';
    throw error;
  }
  return config;
}

export function assignmentFor(archetype) {
  const policyId = typeof archetype === 'string' && Object.hasOwn(ARCHETYPE_POLICY_ID, archetype)
    ? ARCHETYPE_POLICY_ID[archetype]
    : 'baseline-v2';
  const config = POLICIES[policyId];
  return {
    policyId: config.policyId,
    policyVersion: config.policyVersion,
    configDigest: config.configDigest,
  };
}

export function sanitizePlayersForReview(players, { gameOver = false } = {}) {
  return (players ?? []).map((player) => {
    const out = {
      playerId: player.playerId,
      seat: player.seat,
      name: player.name,
      agentHandle: player.agentHandle,
      speech: player.speech,
      personality: player.personality,
      archetype: player.archetype,
    };
    if (gameOver && player.policy) {
      const config = resolveStoredPolicy(player.policy).config;
      out.policyId = config.policyId;
      out.policyVersion = config.policyVersion;
      if (isStrategyV2(config)) {
        out.policyModelKind = 'qualitative-config-v2';
        out.policyTraitsEvidence = 'configured-not-observed-action-frequencies';
        out.policyTraits = { ...config.traits };
      } else if (Array.isArray(config.deviations) && config.deviations.length) {
        out.deviation = config.deviations.map((row) => ({
          street: row.selector?.street ?? null,
          facingBet: row.selector?.facingBet ?? null,
          from: row.from,
          to: row.to,
        }));
      }
    }
    return out;
  });
}
