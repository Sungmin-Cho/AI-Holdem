import {parsePreflopKey,preflopKeys} from '../shared/preflop-key.js';
import {V2_REFERENCE_SOURCE,sameReferenceSource} from '../shared/reference.js';
import { createHash } from 'node:crypto';
import { isPreflopSpotKey } from './opportunities.js';
import { assertEvaluationId } from './contracts.js';

const SUPPORTED_SPOTS = [
  '6max-100bb-utg-rfi-unopened',
  '6max-100bb-hj-rfi-unopened',
  '6max-100bb-co-rfi-unopened',
  '6max-100bb-btn-rfi-unopened',
  '6max-100bb-sb-rfi-unopened',
  '6max-100bb-bb-vs-single-raise',
  '6max-100bb-sb-vs-single-raise',
  '6max-100bb-btn-vs-single-raise',
];
const SUPPORTED_SPOT_SET = new Set([...SUPPORTED_SPOTS,...preflopKeys()]);
const spotsForSource = source => sameReferenceSource(source,V2_REFERENCE_SOURCE) ? preflopKeys() : SUPPORTED_SPOTS;
const RANKS = 'AKQJT98765432'.split('');
const HAND_CLASSES = [
  ...RANKS.map((rank) => `${rank}${rank}`),
  ...RANKS.flatMap((high, highIndex) => RANKS.slice(highIndex + 1)
    .flatMap((low) => [`${high}${low}s`, `${high}${low}o`])),
];
const HAND_SET = new Set(HAND_CLASSES);
const MODES = new Set(['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest']);
const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;
const PROVIDER_VERSION_RE = /^\d+\.\d+\.\d+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rng(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
  let a = Number.parseInt(hex, 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const copy = [...items];
  const rand = rng(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sourceIdentity(source) {
  if (!PROVIDER_ID_RE.test(source?.id ?? '') || !PROVIDER_VERSION_RE.test(source?.version ?? '')
    || (source?.contentSha256 !== undefined && !HEX64_RE.test(source.contentSha256))) {
    throw coded('PROVIDER_VERSION_REQUIRED', 'drill queue needs a validated dataset source');
  }
  return {
    id: source.id,
    version: source.version,
    ...(source.contentSha256 !== undefined ? { contentSha256: source.contentSha256 } : {}),
  };
}

function exactSource(left, right) {
  return left?.id === right?.id && left?.version === right?.version
    && (left?.contentSha256 ?? null) === (right?.contentSha256 ?? null);
}

function validateSelection(spotKey, handClass, source) {
  if (spotKey !== undefined && (!isPreflopSpotKey(spotKey) || !(source ? spotsForSource(source).includes(spotKey) : SUPPORTED_SPOT_SET.has(spotKey)))) {
    throw coded('UNSUPPORTED_SPOT', 'selected spot is unavailable in the reference dataset');
  }
  if (handClass !== undefined && !HAND_SET.has(handClass)) {
    throw coded('UNSUPPORTED_HAND', 'selected hand is unavailable in the reference dataset');
  }
}

function questionFrom({ mode, spotKey, handClass, skillKey, nonce, source, candidateMistakeId }) {
  validateSelection(spotKey, handClass, source);
  const parsed = parsePreflopKey(spotKey);
  const pos = parsed.position;
  return {
    questionId: `drill:${source.version}:${spotKey}:${handClass}:${nonce}`,
    mode,
    skillKey,
    ...(candidateMistakeId ? { candidateMistakeId } : {}),
    sourceIdentity: { ...source },
    prompt: {
      position: pos,
      handClass,
      stackBb: 100,
      ...(parsed.version === 2 ? {seated:parsed.seated,openerPosition:parsed.openerPosition,referenceKind:'native-practice'} : {}),
      spotKey,
      actionHistory: parsed.context === 'vs-single-raise' ? ['raise'] : [],
      legalActions: parsed.context === 'vs-single-raise'
        ? ['fold', 'call', 'raise:8.5']
        : ['fold', 'raise:2.5'],
    },
    answerPolicy: {
      providerId: source.id,
      providerVersion: source.version,
      ...(source.contentSha256 ? { contentSha256: source.contentSha256 } : {}),
    },
  };
}

const RFI_SEATS = ['utg', 'hj', 'co', 'btn', 'sb'];
const DEFENSE_SEATS = ['bb', 'sb', 'btn'];
const SEAT_ALIASES = new Map([['mp', 'hj'], ['lj', 'hj'], ['bu', 'btn'], ['button', 'btn']]);
const HAND_ROTATION = ['AJo', 'KQs', 'A5s', '77', 'QTs', 'T9s', 'KJo', '22'];

function seatIn(key, seats) {
  for (const seat of seats) {
    if (new RegExp(`(^|[^a-z])${seat}([^a-z]|$)`).test(key)) return seat;
  }
  for (const [alias, seat] of SEAT_ALIASES) {
    if (seats.includes(seat) && new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(key)) return seat;
  }
  return null;
}

export function spotForSkillKey(skillKey) {
  const v2 = String(skillKey ?? '').replace(/^preflop\.v2\./,'');
  if (parsePreflopKey(v2)?.version === 2) return v2;
  const key = String(skillKey ?? '').toLowerCase();
  if (/defense|defence|vs-?raise|vs-/.test(key)) {
    const parts = key.split(/defense|defence|vs-?raise|vs-/);
    const defender = seatIn(parts[0] ?? '', DEFENSE_SEATS)
      ?? seatIn(parts.slice(1).join(' '), DEFENSE_SEATS)
      ?? 'bb';
    return `6max-100bb-${defender}-vs-single-raise`;
  }
  const rfiSeat = seatIn(key, RFI_SEATS);
  return rfiSeat ? `6max-100bb-${rfiSeat}-rfi-unopened` : null;
}

export function handClassForSkillKey(skillKey) {
  const key = String(skillKey ?? '');
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum = (sum * 31 + key.charCodeAt(i)) >>> 0;
  return HAND_ROTATION[sum % HAND_ROTATION.length];
}

function pool({ spots = SUPPORTED_SPOTS, hands = HAND_CLASSES, seed, seen = new Set() }) {
  const pairs = [];
  for (const spot of spots) {
    for (const hand of hands) {
      if (!seen.has(`${spot}:${hand}`)) pairs.push({ spot, handClass: hand });
    }
  }
  return shuffle(pairs, seed);
}

function itemInput(item, selectedSource) {
  const spot = item?.spotKey ?? String(item?.spotSignature ?? '').split(':')[0];
  const handClass = item?.handClass ?? String(item?.spotSignature ?? '').split(':')[1];
  const legacy = item?.schemaVersion === 1 ? item.evaluation : null;
  if (item?.schemaVersion === 1) {
    try { assertEvaluationId(item.mistakeId); } catch { return null; }
    if (!legacy || legacy.evaluationId !== item.mistakeId
      || legacy.spotKey !== spot || legacy.handClass !== handClass
      || item.spotSignature !== `${spot}:${handClass}`
      || !HEX64_RE.test(legacy.payloadSha256 ?? '')
      || (item.payloadSha256 !== undefined && item.payloadSha256 !== legacy.payloadSha256)
      || legacy.status !== 'supported' || legacy.forced !== false || legacy.grade !== 'off-policy'
      || (item.sourceIdentity !== undefined && !exactSource(item.sourceIdentity, legacy.source))) return null;
  }
  // Schema1 already persisted full evaluation evidence in some stores. Use
  // that explicit source only after binding the duplicated fields; never fill
  // in an absent content hash from the selected dataset.
  const itemSource = item?.sourceIdentity ?? legacy?.source;
  if (!SUPPORTED_SPOT_SET.has(spot) || !HAND_SET.has(handClass) || !exactSource(itemSource, selectedSource)) return null;
  return { item, spot, handClass, source: itemSource };
}

function questionsFromPairs(pairs, { mode, source, skillKey, limit }) {
  return pairs.slice(0, limit).map(({ spot, handClass }, index) => questionFrom({
    mode, source, spotKey: spot, handClass, skillKey, nonce: index + 1,
  }));
}

export function generateQueue({
  mode = 'free',
  profile,
  mistakes = [],
  seed = '0',
  now = new Date().toISOString(),
  spotKey,
  handClass,
  history,
  questionSet,
  limit = 10,
  source,
} = {}) {
  if (!MODES.has(mode)) throw coded('INVALID_DRILL_MODE', `unsupported drill mode: ${mode}`);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw coded('INVALID_DRILL_LIMIT', 'invalid drill limit');
  const selectedSource = sourceIdentity(source);
  validateSelection(spotKey, handClass, selectedSource);

  if (mode === 'daily' || mode === 'mistake-review') {
    const candidates = mistakes
      .filter((item) => mode !== 'daily' || !item.nextReviewAt || item.nextReviewAt <= now)
      .map((item) => itemInput(item, selectedSource))
      .filter(Boolean);
    const seen = new Set();
    return candidates.filter(({ spot, handClass: hand }) => {
      const key = `${spot}:${hand}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit).map(({ item, spot, handClass: hand, source: itemSource }, index) => questionFrom({
      mode, source: itemSource, spotKey: spot, handClass: hand,
      skillKey: item.skillKey, candidateMistakeId: item.mistakeId, nonce: index + 1,
    }));
  }

  if (mode === 'retest') {
    if (!Array.isArray(questionSet)) throw coded('INCOMPLETE_ASSESSMENT', 'retest needs the original question set');
    const pairs = questionSet.map((question) => ({ spot: question.spotKey, handClass: question.handClass }));
    for (const pair of pairs) validateSelection(pair.spot, pair.handClass, selectedSource);
    return questionsFromPairs(pairs, { mode, source: selectedSource, skillKey: 'preflop.retest', limit });
  }

  if (mode === 'assessment') {
    const seen = new Set((history?.seenPairs ?? [])
      .filter((row) => exactSource(row.sourceIdentity, selectedSource))
      .map((row) => `${row.spotKey}:${row.handClass}`));
    const pairs = pool({ spots:spotsForSource(selectedSource), seed, seen });
    return questionsFromPairs(pairs, { mode, source: selectedSource, skillKey: 'preflop.assessment', limit });
  }

  if (mode === 'leak') {
    const leaks = profile?.game?.leaks ?? profile?.leaks ?? profile?.practice?.leaks ?? [];
    const leakKey = leaks[0]?.recommendedDrill ?? leaks[0]?.id;
    const spots = [...new Set(leaks.map((leak) => spotForSkillKey(leak.recommendedDrill ?? leak.id))
      .filter((spot) => spotsForSource(selectedSource).includes(spot)))];
    if (!spots.length) return [];
    const primary = { spot: spots[0], handClass: handClassForSkillKey(leakKey) };
    const pairs = [primary, ...pool({ spots, seed: `${seed}:${leakKey}` })
      .filter((pair) => pair.spot !== primary.spot || pair.handClass !== primary.handClass)];
    return questionsFromPairs(pairs, {
      mode, source: selectedSource,
      skillKey: leakKey ?? 'preflop.leak', limit,
    });
  }

  const spots = spotKey ? [spotKey] : spotsForSource(selectedSource);
  const hands = handClass ? [handClass] : HAND_CLASSES;
  const pairs = pool({ spots, hands, seed });
  return questionsFromPairs(pairs, { mode, source: selectedSource, skillKey: 'preflop.free', limit });
}
