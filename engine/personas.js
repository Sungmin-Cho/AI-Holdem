import { randomInt } from 'node:crypto';
import { PERSONA_NAMES } from '../shared/reserved-names.js';

export const ARCHETYPES = ['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster'];

const NAMES = PERSONA_NAMES;

const PROFILES = {
  TAG: {
    speech: '좋은 패만으로 차분하게 압박할게요.',
    personality: '신중하고 공격적인 정석파',
  },
  LAG: {
    speech: '기회가 보이면 과감하게 들어가죠.',
    personality: '활발하고 공격적인 모험가',
  },
  Nit: {
    speech: '확실하지 않으면 기다리는 편이에요.',
    personality: '극도로 신중한 안전주의자',
  },
  CallingStation: {
    speech: '일단 끝까지 확인해 볼게요.',
    personality: '잘 포기하지 않는 낙천가',
  },
  Maniac: {
    speech: '이번 판은 제가 크게 흔들어 볼게요.',
    personality: '속도와 변동성을 즐기는 광인',
  },
  Trickster: {
    speech: '겉으로 보이는 게 전부는 아니랍니다.',
    personality: '상대를 읽고 함정을 파는 책략가',
  },
};

function shuffledNames(count, excludeNames = []) {
  const excluded = new Set(
    (Array.isArray(excludeNames) ? excludeNames : [])
      .map((name) => String(name).trim().toLowerCase())
      .filter(Boolean),
  );
  const names = NAMES.filter((name) => !excluded.has(name.toLowerCase()));
  for (let i = names.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, count);
}

function shuffledArchetypes(count) {
  const archetypes = [];
  while (archetypes.length < count) {
    const bag = [...ARCHETYPES];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    archetypes.push(...bag);
  }
  return archetypes.slice(0, count);
}

export function generatePersonas(n, { excludeNames } = {}) {
  const excluded = new Set(
    (Array.isArray(excludeNames) ? excludeNames : [])
      .map((name) => String(name).trim().toLowerCase())
      .filter(Boolean),
  );
  const poolSize = NAMES.filter((name) => !excluded.has(name.toLowerCase())).length;
  if (!Number.isInteger(n) || n < 0 || n > poolSize) {
    throw new RangeError(`n must be an integer from 0 to ${poolSize}`);
  }

  const archetypes = shuffledArchetypes(n);
  return shuffledNames(n, excludeNames).map((name, index) => {
    const archetype = archetypes[index];
    const profile = PROFILES[archetype];
    return {
      playerId: `p${index + 1}`,
      seat: index + 1,
      name,
      agentHandle: `player-p${index + 1}`,
      speech: profile.speech,
      personality: profile.personality,
      archetype,
    };
  });
}
