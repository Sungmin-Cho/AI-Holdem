import { configDigestOf } from './contracts.js';

const VERSION = '1.0.0';

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
  return { ...config, configDigest: configDigestOf(config) };
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
});

export const ARCHETYPE_POLICY_ID = Object.freeze({
  TAG: 'tag-v1',
  LAG: 'lag-v1',
  Nit: 'nit-v1',
  CallingStation: 'calling-station-v1',
  Maniac: 'maniac-v1',
  Trickster: 'baseline-v1',
});

export function policyById(policyId) {
  return POLICIES[policyId] ?? null;
}

export function assignmentFor(archetype) {
  const policyId = ARCHETYPE_POLICY_ID[archetype] ?? 'baseline-v1';
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
      out.policyId = player.policy.policyId;
      out.policyVersion = player.policy.policyVersion;
      if (Array.isArray(player.policy.deviations) && player.policy.deviations.length) {
        out.deviation = player.policy.deviations.map((row) => ({
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
