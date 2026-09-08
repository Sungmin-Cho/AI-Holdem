import {referenceAssessmentEligibility,projectReferenceCoverage} from '../shared/reference-coverage.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentSession } from '../engine/session-catalog.js';
import { FORBIDDEN_PATH_LITERALS, FORBIDDEN_PATH_RE, gameEpochOf } from '../publish-contract.js';
import { materializeLearningEvaluation } from '../tools/training-control.js';
import { openContained } from '../tools/training-store.js';
import { EXPORT_MAX_BYTES } from './contracts.js';
import { referenceQuality } from '../shared/reference.js';

const FORBIDDEN = [
  'archetype', 'personality', 'bluffFreq', 'policySeed', 'sessionToken',
  'policyId', 'configDigest', 'sampledProbability', ...FORBIDDEN_PATH_LITERALS,
];

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readContainedJson(root, segments) {
  try {
    const buf = openContained(root, segments, { maxBytes: EXPORT_MAX_BYTES });
    return JSON.parse(buf.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function listHands(gameDir) {
  const root = path.resolve(gameDir);
  const handsDir = path.join(root, 'hands');
  let files = [];
  try {
    const st = fs.lstatSync(handsDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw coded('UNSAFE_PATH', 'hands 디렉터리가 안전하지 않습니다.');
    }
    files = fs.readdirSync(handsDir).filter((name) => /^hand-\d+\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const records = files.map((name) => {
    const parsed = readContainedJson(root, ['hands', name]);
    if (parsed == null) throw coded('UNSAFE_PATH', `${name}을 읽을 수 없습니다.`);
    return parsed;
  });
  const state = readContainedJson(root, ['state.json']);
  if (state?.lastHand?.handNo && !records.some((row) => row.handNo === state.lastHand.handNo)) {
    records.push(state.lastHand);
  }
  return { state, records: records.sort((a, b) => a.handNo - b.handNo) };
}

export function resolveExportDir({ gameDir, storeDir }) {
  if (storeDir) {
    const current = resolveCurrentSession(storeDir);
    if (!current) {
      const err = new Error('current session이 없습니다.');
      err.code = 'NO_GAME';
      throw err;
    }
    return current.sessionDir;
  }
  if (!gameDir) {
    const err = new Error('--game-dir 또는 --store-dir가 필요합니다.');
    err.code = 'USAGE';
    throw err;
  }
  return path.resolve(gameDir);
}

function publicHoles(record) {
  const revealed = new Set();
  for (const reveal of record.showdown?.reveals ?? []) {
    for (const card of reveal.cards ?? []) revealed.add(card);
  }
  const holes = {};
  if (record.holes?.user) holes.user = record.holes.user;
  for (const [playerId, cards] of Object.entries(record.holes ?? {})) {
    if (playerId === 'user') continue;
    if (cards.every((card) => revealed.has(card))) holes[playerId] = cards;
  }
  return holes;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

// Only this contained reader can create a transport receipt. JSON rows and copied source
// tuples cannot acquire one, and mutating a returned object invalidates its receipt.
const verifiedEvaluations = new WeakMap();
const HEX64 = /^[0-9a-f]{64}$/;
const EXPORT_ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise']);

export function loadReferenceEvaluations(gameDir) {
  const { state, records } = listHands(gameDir);
  const unavailable = () => Object.fromEntries(records.map((record) => [record.handNo, [{
    handNo: record.handNo, status: 'unavailable', referenceReason: 'LEARNING_AUTHORITY_UNAVAILABLE',
  }]]));
  // Hand archives carry no epoch. A sealed learning payload can be transported
  // only when this directory also supplies a valid, consistent session identity.
  let epoch = null;
  if (isPlainObject(state)) {
    if (typeof state.sessionToken === 'string' && state.sessionToken.length > 0) {
      epoch = gameEpochOf(state.sessionToken);
      if (state.gameEpoch !== undefined && state.gameEpoch !== epoch) epoch = null;
    } else if (state.sessionToken === undefined && HEX64.test(state.gameEpoch ?? '')) epoch = state.gameEpoch;
  }
  if (!HEX64.test(epoch ?? '')) return unavailable();
  let raw;
  try {
    raw = openContained(gameDir, ['training', '.training-authority.json'], { maxBytes: EXPORT_MAX_BYTES });
  } catch (error) {
    if (error.code === 'ENOENT') return unavailable();
    throw error;
  }
  let auth;
  try { auth = JSON.parse(raw.toString('utf8')); } catch {
    throw coded('LEARNING_AUTHORITY_INVALID', 'learning authority is not JSON');
  }
  if (auth?.schemaVersion === 1) return unavailable();
  if (!isPlainObject(auth) || auth.schemaVersion !== 2 || !isPlainObject(auth.items)
    || !HEX64.test(auth.gameEpoch ?? '')) {
    throw coded('LEARNING_AUTHORITY_INVALID', 'learning authority is invalid');
  }
  if (epoch !== auth.gameEpoch) {
    throw coded('LEARNING_DETAIL_IDENTITY_MISMATCH', 'learning authority belongs to another game');
  }
  const marker = readContainedJson(gameDir, ['training', '.migration-v2.json']);
  if (marker && marker.status !== 'complete') {
    throw coded('TRAINING_MIGRATION_INCOMPLETE', 'learning authority migration is incomplete');
  }
  const byHand = {};
  for (const [id, item] of Object.entries(auth.items)) {
    if (!isPlainObject(item) || item.evaluationId !== id
      || !['evaluated', 'published'].includes(item.status)
      || !Number.isSafeInteger(item.handNo) || item.handNo <= 0
      || item.summary?.handNo !== item.handNo
      || !id.startsWith(`${auth.gameEpoch}:d-${item.handNo}-`)) {
      throw coded('LEARNING_DETAIL_IDENTITY_MISMATCH', 'learning item identity is invalid');
    }
    // Verify every declared proof before constructing an export, even for a missing archive.
    const detail = materializeLearningEvaluation(gameDir, item);
    if (detail.handNo !== undefined && detail.handNo !== item.handNo) {
      throw coded('LEARNING_DETAIL_IDENTITY_MISMATCH', 'learning detail hand does not match authority');
    }
    const evaluation = { ...detail, handNo: item.handNo };
    // Explanations are independent annotation seals; an embedded legacy detail string
    // is not a verified annotation and is deliberately not transported by this loader.
    delete evaluation.explanation;
    delete evaluation.explanationStatus;
    verifiedEvaluations.set(evaluation, { bytes: JSON.stringify(evaluation), payloadSha256: item.payloadSha256 });
    (byHand[item.handNo] ??= []).push(evaluation);
  }
  return byHand;
}

function exportAction(action, { reference = false } = {}) {
  if (!isPlainObject(action) || !EXPORT_ACTIONS.has(action.action)) return undefined;
  return {
    action: action.action,
    ...(typeof action.sizeBb === 'number' && Number.isFinite(action.sizeBb) && action.sizeBb >= 0
      ? { sizeBb: action.sizeBb } : {}),
    ...(reference && typeof action.frequency === 'number' && Number.isFinite(action.frequency)
      && action.frequency >= 0 && action.frequency <= 1 ? { frequency: action.frequency } : {}),
  };
}

export function projectReferenceEvaluation(evaluation) {
  if (!isPlainObject(evaluation)) return null;
  const receipt = verifiedEvaluations.get(evaluation);
  const verified = receipt && receipt.bytes === JSON.stringify(evaluation) && HEX64.test(receipt.payloadSha256);
  const sourceQuality = referenceQuality(evaluation.source);
  const quality = verified || sourceQuality.quality === 'synthetic' ? sourceQuality
    : { quality: 'unverified', reason: 'LEARNING_AUTHORITY_UNAVAILABLE' };
  const eligibility = referenceAssessmentEligibility(evaluation);
  const eligible = verified && quality.quality === 'heuristic-reference' && eligibility.referenceAvailable;
  const metricEligible = eligible && eligibility.metricEligible;
  const projected = {
    schemaVersion: 2,
    status: ['supported', 'unsupported', 'unavailable'].includes(evaluation.status) ? evaluation.status : 'unavailable',
    referenceQuality: quality.quality,
    ...(quality.reason ? { referenceReason: quality.reason } : {}),
  };
  if (verified) projected.sourcePayloadSha256 = receipt.payloadSha256;
  for (const key of ['evaluationId', 'decisionId', 'spotKey', 'handClass', 'street', 'code']) {
    if (typeof evaluation[key] === 'string' && evaluation[key].length <= 256
      && /^[a-zA-Z0-9:@._-]+$/.test(evaluation[key])) projected[key] = evaluation[key];
  }
  if (Number.isSafeInteger(evaluation.handNo) && evaluation.handNo > 0) projected.handNo = evaluation.handNo;
  if (typeof evaluation.forced === 'boolean') projected.forced = evaluation.forced;
  const chosen = exportAction(evaluation.chosen, { reference: metricEligible });
  if (chosen) projected.chosen = chosen;
  if (isPlainObject(evaluation.source)
    && typeof evaluation.source.id === 'string' && /^[a-z0-9-]{1,64}$/.test(evaluation.source.id)
    && typeof evaluation.source.version === 'string' && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(evaluation.source.version)) {
    const source = evaluation.source;
    projected.source = {
      id: source.id, version: source.version,
      ...(HEX64.test(source.contentSha256 ?? '') ? { contentSha256: source.contentSha256 } : {}),
    };
  }
  if (eligible) {
    if (evaluation.source?.version === '2.0.0' && Object.hasOwn(evaluation,'coverage')) projected.coverage = projectReferenceCoverage(evaluation.coverage);
    if (metricEligible && ['preferred', 'mixed', 'low-frequency', 'off-policy'].includes(evaluation.grade)) projected.grade = evaluation.grade;
    if (Array.isArray(evaluation.recommended)) {
      projected.recommended = evaluation.recommended.slice(0, 10).map((action) => exportAction(action, { reference: true })).filter(Boolean);
    }
  }
  return projected;
}

export function normalizeHand(record, { evaluations = [] } = {}) {
  return {
    handNo: record.handNo,
    button: record.button,
    blinds: record.blinds,
    seats: Object.entries(record.startStacks ?? {}).map(([playerId, stack]) => ({ playerId, stack })),
    heroCards: record.holes?.user ?? [],
    board: record.board ?? [],
    actions: Array.isArray(record.actions)
      ? record.actions.map((action) => ({
        playerId: action.playerId,
        action: action.action,
        amount: action.amount,
        street: action.street,
        ...(typeof action.currentBet === 'number' ? { currentBet: action.currentBet } : {}),
      }))
      : record.actions,
    showdown: {
      reveals: record.showdown?.reveals ?? [],
      mucks: record.showdown?.mucks ?? [],
    },
    pots: record.pots ?? [],
    decisions: record.decisions ?? [],
    evaluations: Array.isArray(evaluations)
      ? evaluations.map(projectReferenceEvaluation).filter(Boolean)
      : [],
    holes: publicHoles(record),
    startStacks: record.startStacks ?? {},
    endStacks: record.endStacks ?? {},
    posts: Array.isArray(record.posts) ? structuredClone(record.posts) : record.posts,
    uncalledReturns: isPlainObject(record.uncalledReturns)
      ? { ...record.uncalledReturns }
      : record.uncalledReturns,
    allIn: [...(record.allIn ?? [])],
    folded: [...(record.folded ?? [])],
  };
}

export function assertNoSecrets(payload) {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN) {
    if (json.includes(key)) {
      throw coded('FORBIDDEN_EXPORT', `forbidden field ${key}`);
    }
  }
  if (FORBIDDEN_PATH_RE.test(json)) {
    throw coded('FORBIDDEN_EXPORT', 'forbidden absolute path');
  }
}
