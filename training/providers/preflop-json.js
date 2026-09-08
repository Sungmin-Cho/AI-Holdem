import { createHash } from 'node:crypto';
import { ERRORS, coded, frequenciesSumToOne } from '../contracts.js';
import { allHandClasses } from '../cards.js';
import { preflopKeys, parsePreflopKey } from '../../shared/preflop-key.js';

// Keyed by object identity, so the association cannot be reflected, copied or
// spoofed: `Object.getOwnPropertySymbols` finds nothing, and a Proxy cannot
// answer for a key it does not hold. R5: a dataset that did not come out of
// this parser cannot be turned into a strategy.
const PINNED = new WeakMap();

const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

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
  // Frozen so the validated shape cannot be edited after the pin is recorded.
  deepFreeze(data);
  PINNED.set(data, contentSha256);
  return { data, contentSha256, raw };
}

export function validateDataset(data) {
  if (!data || ![1, 2].includes(data.schemaVersion)) throw coded(ERRORS.DATASET_INVALID, 'schemaVersion');
  if (!PROVIDER_ID_RE.test(data.id ?? '')) throw coded(ERRORS.DATASET_INVALID, 'id');
  if (!SEMVER_RE.test(data.version ?? '')) throw coded(ERRORS.DATASET_INVALID, 'version');
  if (typeof data.license !== 'string' || data.license.length < 1) {
    throw coded(ERRORS.DATASET_INVALID, 'license');
  }
  if (!data.spots || typeof data.spots !== 'object') throw coded(ERRORS.DATASET_INVALID, 'spots');
  if (data.schemaVersion === 2) validateV2(data);
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
        if (!Number.isFinite(action.frequency) || action.frequency < 0 || action.frequency > 1) {
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

function validateV2(data) {
  const fail = (field) => { throw coded(ERRORS.DATASET_INVALID, `v2 ${field}`); };
  const keys = preflopKeys();
  const hands = allHandClasses();
  if (data.id !== 'local-preflop-baseline' || data.version !== '2.0.0'
      || data.recipeVersion !== 'original-v2.0.0') fail('identity');
  if (JSON.stringify(data.tree) !== JSON.stringify({rfiBb:2.5,threeBetBb:8.5})) fail('tree');
  if (JSON.stringify(data.capabilities) !== JSON.stringify({mode:'cash-training',seated:[6,8,9],stackBb:100,
    projectedStackBb:[80,120],projectedOpenBb:[2,3],projectedThreeBetBb:[6.5,10.5]})) fail('capabilities');
  if (Object.keys(data.spots).length !== keys.length || keys.some(k=>!Object.hasOwn(data.spots,k))) fail('keys');
  for (const key of keys) {
    const rows = data.spots[key];
    if (!rows || Object.keys(rows).length !== hands.length || hands.some(h=>!Object.hasOwn(rows,h))) fail('hands');
    const size = parsePreflopKey(key).context === 'rfi-unopened' ? 2.5 : 8.5;
    for (const hand of hands) {
      const actions = rows[hand];
      if (!Array.isArray(actions) || !actions.length || actions.length > 3) fail('actions');
      const seen = new Set(); let units = 0;
      for (const a of actions) {
        if (!a || !['raise','call','fold'].includes(a.action) || seen.has(a.action)) fail('action');
        seen.add(a.action);
        if (Object.keys(a).some(k=>!['action','sizeBb','frequency','evBb'].includes(k))) fail('action fields');
        if (a.action === 'raise' ? a.sizeBb !== size : Object.hasOwn(a,'sizeBb')) fail('size');
        if (size === 2.5 && a.action === 'call') fail('RFI call');
        if (!Number.isFinite(a.frequency) || a.frequency <= 0 || a.frequency > 1
            || Math.abs(a.frequency*10000-Math.round(a.frequency*10000)) > 1e-9) fail('frequency');
        if (a.evBb !== null) fail('EV');
        units += Math.round(a.frequency*10000);
      }
      if (units !== 10000) fail('frequency sum');
    }
  }
}

export function lookup({ data, contentSha256 }, { spotKey, handClass }) {
  if (data == null || PINNED.get(data) !== contentSha256) {
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
