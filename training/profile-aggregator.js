import { assistanceAllowsIndependent, projectAssistance } from '../shared/assistance.js';
import {dealSelectionFields,dealSelectionDisposition} from '../shared/deal-selection.js';
import { referenceAssessmentEligibility, projectReferenceCoverage } from '../shared/reference-coverage.js';
import { detectLeaks } from './leak-detector.js';
import { confidenceOf, masteryOf } from './mastery.js';
import { actionKey, matchReferenceAction, isAllowedGrade, referenceQuality, validateMixObservation } from '../shared/reference.js';
import { validateStudyRun } from '../shared/study-contract.js';

export const DEFAULT_ACTIVE_SEGMENT_ID = 'local-preflop-baseline@2.0.0';
export const PROFILE_SCHEMA_VERSION = 6;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emptyOverall() {
  return {
    evaluatedDecisions: 0, supportedDecisions: 0, unsupportedDecisions: 0,
    forfeits: 0, preferred: 0, offPolicy: 0, allowed: 0,
    allowedActionRate: 0, modalActionRate: 0, sampleWeight: 0,
    evLossBb: null, evLossBbPer100: null,
  };
}

function emptyCalibration() {
  return {
    distributionAgreement: null, eligibleObservations: 0, totalObservations: 0,
    reason: 'legacy-evidence-unavailable',
  };
}

function emptyProjection() {
  return {
    overall: emptyOverall(), skills: {}, leaks: [], candidates: [], coverageGaps: [],
    coverage: { evaluatedDecisions: 0, supportedDecisions: 0, unsupportedDecisions: 0, supportedRate: 0, unverifiedDecisions: 0, referenceAvailableDecisions: 0, exactComparableDecisions: 0, projectedReferenceDecisions: 0, comparisonUnavailableDecisions: 0, forcedDecisions: 0, assistedDecisions: 0 },
    calibration: emptyCalibration(), mixGroups: {}, studyRuns: {}, unverifiedEvidence: [],
  };
}

export function emptyProfile() {
  return projectActive({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    updatedAt: null,
    processed: {},
    game: emptyProjection(),
    practice: emptyProjection(),
    segments: {},
    activeSegmentId: DEFAULT_ACTIVE_SEGMENT_ID,
    hasGameEvents: false,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSafeMapKey(key) {
  return typeof key === 'string' && key.length > 0
    && !['__proto__', 'constructor', 'prototype'].includes(key);
}

export function assertProfileEvent(event) {
  if (!event || (event.schemaVersion !== undefined
      && (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1 || event.schemaVersion > 7))) {
    throw coded('PROFILE_EVENT_INVALID', 'profile event schema is invalid');
  }
  try {dealSelectionFields(event);} catch {throw coded('PROFILE_EVENT_INVALID','invalid deal selection provenance');}
  if (event.schemaVersion >= 6 || event.assistance !== undefined) {
    try { projectAssistance(event.assistance); } catch { throw coded('PROFILE_EVENT_INVALID', 'assistance is required and must be valid'); }
  }
  if (typeof event.evaluationId !== 'string' || event.evaluationId.length === 0) {
    throw coded('PROFILE_EVENT_INVALID', 'evaluationId가 없습니다.');
  }
  if (typeof event.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(event.payloadSha256)) {
    throw coded('PROFILE_EVENT_INVALID', 'payloadSha256이 없습니다.');
  }
  if (!isSafeMapKey(event.skillKey)) throw coded('PROFILE_EVENT_INVALID', 'skillKey가 없습니다.');
  if (!isSafeMapKey(event.providerId) || typeof event.providerVersion !== 'string' || !event.providerVersion) {
    throw coded('PROFILE_EVENT_INVALID', 'provider가 없습니다.');
  }
  if (event.origin !== undefined && !['game', 'practice', 'drill', 'retest'].includes(event.origin)) {
    throw coded('PROFILE_EVENT_INVALID', 'origin is invalid');
  }
  if (!['supported', 'unsupported'].includes(event.status)
    || typeof event.forced !== 'boolean'
    || (event.evLossBb !== null && event.evLossBb !== undefined
      && (typeof event.evLossBb !== 'number' || !Number.isFinite(event.evLossBb)))) {
    throw coded('PROFILE_EVENT_INVALID', 'profile event result fields are invalid');
  }
  if (event.mixObservation !== undefined) validateMixObservation(event.mixObservation);
  if (event.mixObservation !== undefined
    && (event.mixObservation.sourceIdentity.id !== event.providerId
      || event.mixObservation.sourceIdentity.version !== event.providerVersion)) {
    throw coded('PROFILE_EVENT_INVALID', 'mix source identity does not match the event provider');
  }
  if (event.coverage !== undefined) {
    try { projectReferenceCoverage(event.coverage); }
    catch { throw coded('PROFILE_EVENT_INVALID','profile reference coverage is invalid'); }
  }
  if (event.sourceIdentity && (event.sourceIdentity.id !== event.providerId || event.sourceIdentity.version !== event.providerVersion)) throw coded('PROFILE_EVENT_INVALID', 'source identity conflict');
  if (event.studyRun !== undefined) validateStudyRun(event.studyRun);
  return event;
}

function originOf(event) {
  return ['practice', 'drill', 'retest'].includes(event.origin) ? 'practice' : 'game';
}

function shouldAggregate(event) {
  return Boolean(assistanceAllowsIndependent(event) && event.mixObservation
    && (event.providerVersion === '1.0.0' ? referenceQuality(event.mixObservation.sourceIdentity).quality === 'heuristic-reference' : referenceAssessmentEligibility(event).metricEligible));
}

function bumpEv(current, add) {
  return add == null ? current : (current ?? 0) + add;
}

function per100(loss, supported) {
  return loss == null || !supported ? null : (loss / supported) * 100;
}

function skillRow() {
  return {
    opportunities: 0, supported: 0, preferred: 0, offPolicy: 0, allowed: 0,
    preferredActionRate: 0, allowedActionRate: 0, modalActionRate: 0, sampleWeight: 0,
    evLossBb: null, evLossBbPer100: null, mastery: 0, confidence: 0,
  };
}

function finishRates(row, supportedKey = 'supported') {
  const supported = row[supportedKey] ?? 0;
  row.allowedActionRate = supported ? (row.allowed ?? 0) / supported : 0;
  row.modalActionRate = supported ? (row.preferred ?? 0) / supported : 0;
  row.preferredActionRate = row.modalActionRate;
  row.sampleWeight = Math.min(1, supported / 20);
}

function finishSkill(skill) {
  finishRates(skill);
  skill.confidence = confidenceOf(skill.opportunities);
  skill.mastery = masteryOf({ preferredActionRate: skill.modalActionRate, opportunities: skill.opportunities });
  skill.evLossBbPer100 = per100(skill.evLossBb, skill.supported);
  return skill;
}

function finishOverall(overall) {
  finishRates(overall, 'supportedDecisions');
  overall.evLossBbPer100 = per100(overall.evLossBb, overall.supportedDecisions);
  return overall;
}

function applyToOverall(overall, event) {
  overall.evaluatedDecisions += 1;
  if (event.forced) {
    overall.forfeits += 1;
    return;
  }
  if (event.status === 'supported') {
    overall.supportedDecisions += 1;
    if (event.grade === 'preferred') overall.preferred += 1;
    if (event.grade === 'off-policy') overall.offPolicy += 1;
    if (allowedChoice(event)) overall.allowed += 1;
    overall.evLossBb = bumpEv(overall.evLossBb, event.evLossBb);
  } else {
    overall.unsupportedDecisions += 1;
  }
}

function allowedChoice(event) {
  if (!event.mixObservation) return isAllowedGrade(event.grade);
  if (referenceQuality(event.mixObservation.sourceIdentity).quality !== 'heuristic-reference') return false;
  return (matchReferenceAction(event.mixObservation.referenceActions, event.mixObservation.chosenAction)?.frequency ?? 0) > 0;
}

function applyToSkill(skills, event) {
  if (event.forced) return;
  const row = skills[event.skillKey] ?? skillRow();
  row.opportunities += 1;
  if (event.status === 'supported') {
    row.supported += 1;
    if (event.grade === 'preferred') row.preferred += 1;
    if (event.grade === 'off-policy') row.offPolicy += 1;
    if (allowedChoice(event)) row.allowed += 1;
    row.evLossBb = bumpEv(row.evLossBb, event.evLossBb);
  }
  skills[event.skillKey] = finishSkill(row);
}

function vectorKey(observation) {
  return observation.referenceActions.map((row) => `${actionKey(row)}=${row.frequency}`).sort().join(',');
}

function mixGroupKey(observation) {
  const source = observation.sourceIdentity;
  return JSON.stringify([
    source.id, source.version, source.contentSha256,
    observation.spotKey, observation.handClass, vectorKey(observation),
  ]);
}

function applyMixObservation(projection, raw) {
  const observation = validateMixObservation(raw);
  if (referenceQuality(observation.sourceIdentity).quality !== 'heuristic-reference') return;
  const key = mixGroupKey(observation);
  const group = projection.mixGroups[key] ?? {
    n: 0,
    expected: Object.fromEntries(observation.referenceActions.map((row) => [actionKey(row), row.frequency])),
    observed: {},
  };
  const matched = matchReferenceAction(observation.referenceActions, observation.chosenAction);
  const chosen = matched ? actionKey(matched) : `unmatched:${actionKey(observation.chosenAction)}`;
  group.n += 1;
  group.observed[chosen] = (group.observed[chosen] ?? 0) + 1;
  projection.mixGroups[key] = group;
}

function finishCalibration(projection) {
  let weighted = 0;
  let eligible = 0;
  let total = 0;
  for (const group of Object.values(projection.mixGroups ?? {})) {
    total += group.n;
    if (group.n < 20) continue;
    const keys = new Set([...Object.keys(group.expected), ...Object.keys(group.observed)]);
    let difference = 0;
    for (const key of keys) {
      difference += Math.abs((group.observed[key] ?? 0) / group.n - (group.expected[key] ?? 0));
    }
    const agreement = Math.round(Math.max(0, 1 - 0.5 * difference) * 1e12) / 1e12;
    weighted += agreement * group.n;
    eligible += group.n;
  }
  projection.calibration = {
    distributionAgreement: eligible ? weighted / eligible : null,
    eligibleObservations: eligible,
    totalObservations: total,
    reason: eligible ? null : (total ? 'insufficient-observations' : 'legacy-evidence-unavailable'),
  };
}

function finishProjection(projection) {
  projection.overall = finishOverall(projection.overall ?? emptyOverall());
  for (const [key, skill] of Object.entries(projection.skills ?? {})) projection.skills[key] = finishSkill(skill);
  const detected = detectLeaks(projection.skills);
  projection.leaks = detected.leaks;
  projection.candidates = detected.candidates;
  projection.coverageGaps = detected.coverageGaps;
  const coverage = projection.coverage;
  coverage.supportedRate = coverage.evaluatedDecisions
    ? coverage.supportedDecisions / coverage.evaluatedDecisions : 0;
  finishCalibration(projection);
  return projection;
}

// Coverage records the opportunity population, not score authority. Explicit
// unsupported status and absent source proof are independent, overlapping facts.
function applyCoverage(projection, event) {
  const coverage = projection.coverage;
  const eligibility = referenceAssessmentEligibility(event);
  coverage.evaluatedDecisions += 1;
  if(dealSelectionDisposition(event)==='biased') coverage.biasedDecisions=(coverage.biasedDecisions??0)+1;
  if (event.assistance?.hintShown) coverage.assistedDecisions = (coverage.assistedDecisions ?? 0) + 1;
  if (event.forced) coverage.forcedDecisions += 1;
  if (!event.forced && event.status === 'unsupported') coverage.unsupportedDecisions += 1;
  if (eligibility.referenceAvailable) coverage.referenceAvailableDecisions += 1;
  if (shouldAggregate(event) && !event.forced && event.status === 'supported') { coverage.supportedDecisions += 1; coverage.exactComparableDecisions += 1; }
  if (!eligibility.verified) coverage.unverifiedDecisions += 1;
  if (eligibility.referenceAvailable && (event.coverage?.referenceMatch === 'projected' || event.coverage?.choiceMatch === 'projected')) coverage.projectedReferenceDecisions += 1;
  if (eligibility.referenceAvailable && event.coverage?.choiceMatch === 'unavailable') coverage.comparisonUnavailableDecisions += 1;
}

function segmentKey(event) {
  return `${event.providerId}@${event.providerVersion}`;
}

function applyToSegment(next, event, origin, finalize = true) {
  const key = segmentKey(event);
  const segment = next.segments[key] ?? { game: emptyProjection(), practice: emptyProjection() };
  segment.game = segment.game ?? emptyProjection();
  segment.practice = segment.practice ?? emptyProjection();
  applyCoverage(segment[origin], event);
  if (shouldAggregate(event)) {
    applyToOverall(segment[origin].overall, event);
    applyToSkill(segment[origin].skills, event);
    if (event.mixObservation && event.status === 'supported' && !event.forced) {
      applyMixObservation(segment[origin], event.mixObservation);
    }
  }
  if (finalize) finishProjection(segment[origin]);
  const active = segment.game.overall.evaluatedDecisions ? segment.game : segment.practice;
  segment.overall = clone(active.overall);
  segment.skills = clone(active.skills);
  next.segments[key] = segment;
}

export function projectActive(profile) {
  profile.game = finishProjection(profile.game ?? emptyProjection());
  profile.practice = finishProjection(profile.practice ?? emptyProjection());
  const segment = profile.segments?.[profile.activeSegmentId];
  const active = segment
    ? (profile.hasGameEvents ? segment.game : segment.practice)
    : (profile.hasGameEvents ? profile.game : profile.practice);
  profile.overall = clone(active.overall);
  profile.skills = clone(active.skills);
  profile.leaks = clone(active.leaks);
  profile.candidates = clone(active.candidates);
  profile.coverageGaps = clone(active.coverageGaps);
  profile.coverage = clone((profile.game.coverage.evaluatedDecisions ? profile.game : profile.practice).coverage);
  profile.calibration = clone(active.calibration);
  if (segment) for (const origin of ['game','practice']) {
    for (const field of ['overall','skills','leaks','candidates','coverageGaps','calibration']) profile[origin][field] = clone(segment[origin][field]);
  }
  return profile;
}

function applyEventMutable(next, event, finalize = true) {
  assertProfileEvent(event);
  next.schemaVersion = PROFILE_SCHEMA_VERSION;
  next.processed = next.processed ?? {};
  next.game = next.game ?? emptyProjection();
  next.practice = next.practice ?? emptyProjection();
  next.segments = next.segments ?? {};
  const seen = next.processed[event.evaluationId];
  if (seen === event.payloadSha256) return finalize ? projectActive(next) : next;
  if (seen && seen !== event.payloadSha256) {
    throw coded('PROFILE_EVENT_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
  }
  next.processed[event.evaluationId] = event.payloadSha256;
  const origin = originOf(event);
  applyCoverage(next[origin], event);
  const eligibility = referenceAssessmentEligibility(event);
  if (eligibility.verified) applyToSegment(next, event, origin, finalize);
  if (shouldAggregate(event)) {


    if (event.studyRun && event.status === 'supported' && !event.forced) {
      next[origin].studyRuns[event.studyRun.id] = validateStudyRun(event.studyRun);
    }

  } else if (!eligibility.verified) {
    next[origin].unverifiedEvidence = next[origin].unverifiedEvidence ?? [];
    next[origin].unverifiedEvidence.push({
      evaluationId: event.evaluationId,
      payloadSha256: event.payloadSha256,
      providerId: event.providerId,
      providerVersion: event.providerVersion,
      reason: event.providerId === 'fake-solver' ? 'SYNTHETIC_SOURCE' : 'SOURCE_IDENTITY_UNVERIFIED',
    });
  }
  if (eligibility.referenceAvailable || (event.providerVersion === '1.0.0' && shouldAggregate(event))) {
    if (origin === 'game') {
      next.hasGameEvents = true;
      next.activeSegmentId = segmentKey(event);
    } else if (!next.hasGameEvents) next.activeSegmentId = segmentKey(event);
  }
  next.updatedAt = event.appliedAt ?? next.updatedAt;
  return finalize ? projectActive(next) : next;
}

export function applyEvent(profile, event) {
  return applyEventMutable(clone(profile), event, true);
}

export function rebuildFromEvents(events) {
  let profile = emptyProfile();
  for (const event of events) profile = applyEventMutable(profile, event, false);
  for (const segment of Object.values(profile.segments)) {
    segment.game = finishProjection(segment.game);
    segment.practice = finishProjection(segment.practice);
    const active = segment.game.overall.evaluatedDecisions ? segment.game : segment.practice;
    segment.overall = clone(active.overall);
    segment.skills = clone(active.skills);
  }
  return projectActive(profile);
}
