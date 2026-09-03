import { createHash } from 'node:crypto';
import { ERRORS, coded, frequenciesSumToOne } from '../contracts.js';

// Module-private, so nothing outside this file can forge it — `Symbol.for`
// would be globally registered and therefore forgeable. R5: a dataset that did
// not come through the pinned parser cannot be turned into a strategy.
const PIN = Symbol('preflop-dataset-pin');

const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function hashDataset(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Pure: the caller reads the bytes. Reading files is a tools/CLI
 * responsibility (R12), so this layer only parses, pins and validates.
 */
export function parsePreflopJson(raw, { expectedSha256 } = {}) {
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw coded(ERRORS.DATASET_INVALID, 'expectedSha256 required');
  }
  if (typeof raw !== 'string') {
    throw coded(ERRORS.DATASET_INVALID, 'dataset raw는 문자열이어야 합니다.');
  }
  const contentSha256 = hashDataset(raw);
  if (expectedSha256.toLowerCase() !== contentSha256) {
    throw coded(ERRORS.DATASET_INVALID, 'dataset digest mismatch');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw coded(ERRORS.DATASET_INVALID, 'dataset JSON이 아닙니다.');
  }
  validateDataset(data);
  Object.defineProperty(data, PIN, { value: contentSha256, enumerable: false });
  return { data, contentSha256, raw };
}

export function validateDataset(data) {
  if (!data || data.schemaVersion !== 1) throw coded(ERRORS.DATASET_INVALID, 'schemaVersion');
  if (!PROVIDER_ID_RE.test(data.id ?? '')) throw coded(ERRORS.DATASET_INVALID, 'id');
  if (!SEMVER_RE.test(data.version ?? '')) throw coded(ERRORS.DATASET_INVALID, 'version');
  if (typeof data.license !== 'string' || data.license.length < 1) {
    throw coded(ERRORS.DATASET_INVALID, 'license');
  }
  if (!data.spots || typeof data.spots !== 'object') throw coded(ERRORS.DATASET_INVALID, 'spots');
  for (const [spotKey, hands] of Object.entries(data.spots)) {
    if (typeof spotKey !== 'string' || !hands || typeof hands !== 'object') {
      throw coded(ERRORS.DATASET_INVALID, `spot ${spotKey}`);
    }
    for (const [handClass, actions] of Object.entries(hands)) {
      if (!Array.isArray(actions) || actions.length === 0) {
        throw coded(ERRORS.DATASET_INVALID, `${spotKey} ${handClass}`);
      }
      for (const action of actions) {
        if (typeof action.action !== 'string') throw coded(ERRORS.DATASET_INVALID, 'action');
        if (typeof action.frequency !== 'number' || action.frequency < 0 || action.frequency > 1) {
          throw coded(ERRORS.DATASET_INVALID, 'frequency');
        }
        if (action.evBb != null) throw coded(ERRORS.DATASET_INVALID, 'MVP EV must be absent or null');
      }
      if (!frequenciesSumToOne(actions)) {
        throw coded(ERRORS.DATASET_INVALID, `frequency sum ${spotKey} ${handClass}`);
      }
    }
  }
}

export function lookup({ data, contentSha256 }, { spotKey, handClass }) {
  if (data?.[PIN] == null || data[PIN] !== contentSha256) {
    throw coded(ERRORS.DATASET_INVALID, 'dataset가 pin 검증을 거치지 않았습니다.');
  }
  const source = {
    id: data.id,
    version: data.version,
    license: data.license,
    contentSha256,
  };
  const hands = data.spots[spotKey];
  if (!hands || !hands[handClass]) {
    return { status: 'unsupported', reason: 'spot or hand missing', source };
  }
  return {
    status: 'supported',
    actions: hands[handClass].map((action) => ({
      action: action.action,
      ...(action.sizeBb != null ? { sizeBb: action.sizeBb } : {}),
      frequency: action.frequency,
      evBb: null,
    })),
    source,
  };
}
