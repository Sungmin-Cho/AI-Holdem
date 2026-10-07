import { createHash } from 'node:crypto';
import { ERRORS, coded, frequenciesSumToOne } from '../contracts.js';
import { allHandClasses } from '../cards.js';
import { preflopKeys, parsePreflopKey, preflopKeysV3, parsePreflopKeyV3, PUSHFOLD_STACKS_BB } from '../../shared/preflop-key.js';

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
  if (!data || ![1, 2, 3].includes(data.schemaVersion)) throw coded(ERRORS.DATASET_INVALID, 'schemaVersion');
  if (data.schemaVersion === 3) return validateV3(data);
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

const V3_TREE = { openBb: 2.5, threeBetBb: 8.5, fourBetBb: 20 };
const CHART_ACTIONS = ['raise', 'call', 'fold'];
const CHART_ID_RE = /^c\d{4}$/;
const UNIT_RE = /^[0-9a-z]{507}$/;

function decodeUnits(text) {
  const out = new Array(169);
  for (let i = 0; i < 169; i += 1) out[i] = Number.parseInt(text.slice(i * 3, i * 3 + 3), 36);
  return out;
}

// Schema 3 stores de-duplicated charts as base36 unit strings; spots name a chart.
function validateV3(data) {
  const fail = (field) => { throw coded(ERRORS.DATASET_INVALID, `v3 ${field}`); };
  const top = ['schemaVersion','id','version','license','recipeVersion','methodology','handOrder','units','tree','charts','spots'];
  if (Object.keys(data).length !== top.length || top.some(k => !Object.hasOwn(data, k))) fail('fields');
  if (data.id !== 'local-preflop-baseline' || data.version !== '3.0.0' || data.recipeVersion !== 'original-v3.0.0'
    || data.license !== 'Apache-2.0' || typeof data.methodology !== 'string' || !data.methodology) fail('identity');
  if (JSON.stringify(data.handOrder) !== JSON.stringify(allHandClasses())) fail('handOrder');
  if (data.units !== 10000) fail('units');
  if (JSON.stringify(data.tree) !== JSON.stringify({ ...V3_TREE, pushFoldStacksBb: [...PUSHFOLD_STACKS_BB] })) fail('tree');
  if (!data.charts || typeof data.charts !== 'object' || !data.spots || typeof data.spots !== 'object') fail('tables');
  const used = new Set();
  const keys = preflopKeysV3();
  if (Object.keys(data.spots).length !== keys.length || keys.some(k => !Object.hasOwn(data.spots, k))) fail('keys');
  for (const key of keys) {
    const id = data.spots[key];
    if (typeof id !== 'string' || !CHART_ID_RE.test(id) || !Object.hasOwn(data.charts, id)) fail(`spot ${key}`);
    used.add(id);
    const { context } = parsePreflopKeyV3(key);
    const chart = data.charts[id];
    const raiseAllowed = context !== 'vs-shove';
    const callAllowed = !['rfi-unopened', 'push'].includes(context);
    if (Object.hasOwn(chart, 'raise') && !raiseAllowed) fail(`raise in ${key}`);
    if (Object.hasOwn(chart, 'call') && !callAllowed) fail(`call in ${key}`);
  }
  for (const [id, chart] of Object.entries(data.charts)) {
    if (!CHART_ID_RE.test(id) || !used.has(id) || !chart || typeof chart !== 'object') fail(`chart ${id}`);
    const actions = Object.keys(chart);
    if (!actions.length || actions.some(a => !CHART_ACTIONS.includes(a)) || !Object.hasOwn(chart, 'fold')) fail(`chart ${id} actions`);
    const columns = actions.map(a => {
      if (typeof chart[a] !== 'string' || !UNIT_RE.test(chart[a])) fail(`chart ${id} ${a}`);
      return decodeUnits(chart[a]);
    });
    for (let i = 0; i < 169; i += 1) {
      let sum = 0;
      for (const column of columns) {
        if (!Number.isInteger(column[i]) || column[i] < 0 || column[i] > 10000) fail(`chart ${id} units`);
        sum += column[i];
      }
      if (sum !== 10000) fail(`chart ${id} sum`);
    }
    for (const a of ['raise', 'call']) if (Object.hasOwn(chart, a) && decodeUnits(chart[a]).every(u => u === 0)) fail(`chart ${id} empty ${a}`);
  }
}

function lookupV3(data, source, spotKey, handClass) {
  const parsed = parsePreflopKeyV3(spotKey);
  const index = data.handOrder.indexOf(handClass);
  const chart = parsed && Object.hasOwn(data.spots, spotKey) ? data.charts[data.spots[spotKey]] : null;
  if (!chart || index < 0) return { status: 'unsupported', reason: 'spot or hand missing', source };
  const raiseRow = parsed.context === 'push' ? { allIn: true }
    : { sizeBb: parsed.context === 'rfi-unopened' ? V3_TREE.openBb : parsed.context === 'vs-3bet' ? V3_TREE.fourBetBb : V3_TREE.threeBetBb };
  const actions = [];
  for (const action of CHART_ACTIONS) {
    if (!Object.hasOwn(chart, action)) continue;
    const units = Number.parseInt(chart[action].slice(index * 3, index * 3 + 3), 36);
    if (units > 0) actions.push({ action, ...(action === 'raise' ? raiseRow : {}), frequency: units / 10000, evBb: null });
  }
  return { status: 'supported', actions, source };
}

// True when a pinned dataset has a row for this spot and hand class.
export function hasSpotHand(dataset, spotKey, handClass) {
  const { data } = dataset;
  if (data?.schemaVersion === 3) return Object.hasOwn(data.spots, spotKey) && data.handOrder.includes(handClass);
  return Boolean(data?.spots && Object.hasOwn(data.spots, spotKey) && Object.hasOwn(data.spots[spotKey], handClass));
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
  if (data.schemaVersion === 3) return lookupV3(data, source, spotKey, handClass);
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
