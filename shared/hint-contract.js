import { projectReferenceCoverage } from './reference-coverage.js';
import { KNOWN_REFERENCE_SOURCES, sameReferenceSource } from './reference.js';

export const HINT_MAX_BYTES = 16 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const ACTIONS = ['fold','check','call','raise'];
const COMMON = ['schemaVersion','gameEpoch','decisionId','handNo','stateVersion','status','source'];
const UNSUPPORTED_CODES = new Set(['HINT_SOURCE_UNSUPPORTED','HINT_STREET_UNSUPPORTED','UNSUPPORTED_SPOT',
  'MODE_UNSUPPORTED','SEAT_COUNT_UNSUPPORTED','POSITION_INVALID','STACK_OUT_OF_RANGE',
  'UNSUPPORTED_STACK_CONFIGURATION','LIMP_OR_CALLER','FOUR_BET_PLUS','FACING_SIZE_OUT_OF_RANGE',
  'DATASET_SPOT_MISSING','REFERENCE_ACTION_ILLEGAL']);
const UNAVAILABLE_CODES = new Set(['HINT_RELAY_UNAVAILABLE','HINT_SOURCE_UNAVAILABLE','HINT_QUERY_UNAVAILABLE',
  'HINT_SNAPSHOT_INVALID','HINT_STALE_DECISION','HINT_EXPOSURE_CONFLICT','HINT_PROOF_MISMATCH','HINT_PREPARE_TIMEOUT']);
const fail = () => { throw Object.assign(new Error('Invalid pre-action hint'), { code: 'HINT_PROOF_MISMATCH' }); };
export function projectHint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const supported = value.status === 'supported';
  const fields = [...COMMON, ...(supported ? ['coverage','actions','exposureId'] : ['code'])];
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value,key))
    || value.schemaVersion !== 1 || !HEX.test(value.gameEpoch)
    || !Number.isSafeInteger(value.handNo) || value.handNo < 1
    || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0
    || !new RegExp(`^d-${value.handNo}-(preflop|flop|turn|river)-[0-9]+$`).test(value.decisionId)
    || !['supported','unsupported','unavailable'].includes(value.status)) fail();
  if (value.source !== null && (!value.source || Object.keys(value.source).sort().join(',') !== 'contentSha256,id,version'
    || !KNOWN_REFERENCE_SOURCES.some(source => sameReferenceSource(source,value.source)))) fail();
  if (supported) {
    if (value.source?.version !== '2.0.0' || !HEX.test(value.exposureId)) fail();
    const coverage = projectReferenceCoverage(value.coverage);
    if (!coverage || coverage.referenceMatch === 'unsupported' || coverage.choiceMatch !== 'not-observed'
      || coverage.metricEligible || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > 4) fail();
    const seen = new Set(); let sum = 0;
    for (const row of value.actions) {
      const keys = row?.action === 'raise' ? ['action','frequency','raiseToChips'] : ['action','frequency'];
      if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row,key))
        || !ACTIONS.includes(row.action) || seen.has(row.action) || !Number.isFinite(row.frequency)
        || row.frequency <= 0 || row.frequency > 1 || Math.abs(row.frequency * 10000 - Math.round(row.frequency * 10000)) > 1e-8) fail();
      const legal = coverage.input.legal;
      if (row.action === 'raise' && (!legal.canRaise || row.raiseToChips !== coverage.reference.sizing?.raiseToChips)) fail();
      if (row.action === 'check' ? !legal.canCheck : row.action === 'call' ? legal.canCheck : row.action === 'fold' ? legal.canCheck : false) fail();
      seen.add(row.action); sum += row.frequency;
    }
    if (Math.abs(sum - 1) > 1e-9) fail();
  } else if (!(value.status === 'unsupported' ? UNSUPPORTED_CODES : UNAVAILABLE_CODES).has(value.code)) fail();
  if (new TextEncoder().encode(JSON.stringify(value)).length > HINT_MAX_BYTES) fail();
  return structuredClone(value);
}
