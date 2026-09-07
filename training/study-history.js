import { validateMixObservation, matchReferenceAction, referenceQuality } from '../shared/reference.js';
import { validateStudyRun } from '../shared/study-contract.js';
import { assertProfileEvent } from './profile-aggregator.js';
import { assertEvaluationId, coded } from './contracts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceKey(source) {
  return JSON.stringify([source.id, source.version, source.contentSha256]);
}

function pairKey(source, spotKey, handClass) {
  return JSON.stringify([source.id, source.version, source.contentSha256, spotKey, handClass]);
}

function questionSetKey(questions) {
  return JSON.stringify(questions.map((question) => [question.index, question.spotKey, question.handClass]));
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function learningEventKey(event, { includeTime = true } = {}) {
  return JSON.stringify({
    ...(includeTime ? { schemaVersion: event.schemaVersion ?? null } : {}),
    evaluationId: event.evaluationId, payloadSha256: event.payloadSha256,
    skillKey: event.skillKey, street: event.street ?? event.evaluationId.split(':')[1].split('-')[2],
    status: event.status, grade: event.grade ?? null, forced: event.forced,
    evLossBb: event.evLossBb ?? null, providerId: event.providerId, providerVersion: event.providerVersion,
    origin: event.origin ?? 'game',
    ...(includeTime ? { appliedAt: event.appliedAt ?? null } : {}),
    mixObservation: event.mixObservation === undefined ? null : validateMixObservation(event.mixObservation),
    studyRun: event.studyRun === undefined ? null : validateStudyRun(event.studyRun),
  });
}

// This same pure validation is used by authoritative profile replay and by
// history callers that supply arrays directly. A digest alone cannot certify
// different origin, choice, source, run, or chronology metadata.
export function validateLearningEvents(events) {
  if (!Array.isArray(events)) throw coded('PROFILE_EVENT_INVALID', 'profile events must be an array');
  const seen = new Map();
  const result = [];
  for (const event of events) {
    assertProfileEvent(event);
    try { assertEvaluationId(event.evaluationId); }
    catch { throw coded('PROFILE_EVENT_INVALID', 'event identity is not canonical'); }
    const [, decisionId, provider] = event.evaluationId.split(':');
    if (provider !== `${event.providerId}@${event.providerVersion}`
      || (event.street !== undefined && event.street !== decisionId.split('-')[2])
      || (event.appliedAt !== undefined && !validIso(event.appliedAt))
      || (event.grade != null && !['preferred', 'mixed', 'low-frequency', 'off-policy'].includes(event.grade))) {
      throw coded('PROFILE_EVENT_INVALID', 'event identity, grade or timestamp is invalid');
    }
    const key = learningEventKey(event);
    if (seen.has(event.evaluationId)) {
      if (seen.get(event.evaluationId) !== key) throw coded('PROFILE_EVENT_CONFLICT', 'conflicting learning evidence for one evaluation');
      continue;
    }
    seen.set(event.evaluationId, key);
    result.push(event);
  }
  return result;
}

function projectionOrigin(origin) {
  return ['practice', 'drill', 'retest'].includes(origin) ? 'practice' : 'game';
}

function summarizeRun(entries, now) {
  const first = entries[0];
  let run;
  let inconsistent = false;
  try {
    run = validateStudyRun(first.event.studyRun);
  } catch {
    return null;
  }
  const byIndex = new Map();
  let sourceIdentity = null;
  let verified = true;
  let legacy = false;
  for (const entry of entries) {
    let candidate;
    let observation;
    try {
      candidate = validateStudyRun(entry.event.studyRun);
      observation = validateMixObservation(entry.event.mixObservation);
    } catch {
      inconsistent = true;
      continue;
    }
    if (candidate.id !== run.id || candidate.mode !== run.mode || candidate.total !== run.total
      || candidate.startedAt !== run.startedAt
      || (candidate.assessmentId ?? null) !== (run.assessmentId ?? null)
      || projectionOrigin(entry.event.origin) !== 'practice'
      || entry.event.status !== 'supported' || entry.event.forced === true) {
      inconsistent = true;
    }
    if (observation.sourceIdentity.id !== entry.event.providerId
      || observation.sourceIdentity.version !== entry.event.providerVersion) inconsistent = true;
    if (sourceIdentity == null) sourceIdentity = observation.sourceIdentity;
    else if (sourceKey(sourceIdentity) !== sourceKey(observation.sourceIdentity)) inconsistent = true;
    if (referenceQuality(observation.sourceIdentity).quality !== 'heuristic-reference') verified = false;
    if (entry.event.schemaVersion !== 4) legacy = true;
    if (byIndex.has(candidate.index)) {
      inconsistent = true;
      continue;
    }
    byIndex.set(candidate.index, {
      index: candidate.index,
      questionId: entry.event.evaluationId,
      spotKey: observation.spotKey,
      handClass: observation.handClass,
      grade: entry.event.grade ?? null,
      allowed: (matchReferenceAction(observation.referenceActions, observation.chosenAction)?.frequency ?? 0) > 0,
      appliedAt: entry.event.appliedAt,
    });
  }
  const questions = [...byIndex.values()].sort((left, right) => left.index - right.index);
  const completeIndices = questions.length === run.total
    && questions.every((question, index) => question.index === index);
  const uniquePairs = new Set(questions.map((question) => `${question.spotKey}:${question.handClass}`));
  if (uniquePairs.size !== questions.length) inconsistent = true;
  const timestamps = questions.map((question) => question.appliedAt);
  const timestampsValid = timestamps.every(validIso);
  const future = Date.parse(run.startedAt) > Date.parse(now)
    || timestamps.some((value) => validIso(value) && Date.parse(value) > Date.parse(now));
  if (timestampsValid && timestamps.some((value) => Date.parse(value) < Date.parse(run.startedAt))) {
    inconsistent = true;
  }
  if (timestampsValid && timestamps.some((value, index) => index > 0 && Date.parse(value) < Date.parse(timestamps[index - 1]))) inconsistent = true;
  if (run.mode === 'retest' && !run.assessmentId) inconsistent = true;
  const complete = !inconsistent && !future && verified && !legacy && completeIndices && timestampsValid && sourceIdentity !== null;
  const allowed = questions.filter((question) => question.allowed).length;
  return {
    id: run.id,
    mode: run.mode,
    total: run.total,
    startedAt: run.startedAt,
    ...(run.assessmentId ? { assessmentId: run.assessmentId } : {}),
    complete,
    reason: complete ? null : (inconsistent ? 'INCONSISTENT_RUN' : (future ? 'FUTURE_EVIDENCE' : (!verified ? 'UNVERIFIED_SOURCE' : (legacy ? 'LEGACY_EVIDENCE' : 'INCOMPLETE_RUN')))),
    completedAt: complete
      ? new Date(Math.max(...timestamps.map((value) => Date.parse(value)))).toISOString()
      : null,
    sourceIdentity: sourceIdentity ? clone(sourceIdentity) : null,
    questions: questions.map(({ appliedAt, ...question }) => future ? { ...question, grade: null, allowed: null } : question),
    result: {
      allowed: complete ? allowed : null,
      total: questions.length,
      allowedActionRate: complete ? allowed / questions.length : null,
    },
  };
}

// Callers may provide a deterministic as-of time. Runtime callers supply their
// own server clock; no start/answer request field is used as this authority.
export function studyHistory(events = [], now = new Date().toISOString()) {
  if (!Array.isArray(events)) {
    const error = new Error('profile events must be an array');
    error.code = 'STUDY_HISTORY_INVALID';
    throw error;
  }
  if (!validIso(now)) throw coded('STUDY_HISTORY_INVALID', 'history needs a valid authoritative current time');
  const seen = new Map();
  let unknownPreTrackingExposure = false;
  const groups = new Map();
  let gameGoal = null;
  let practiceGoal = null;
  for (const event of validateLearningEvents(events)) {
    const future = (validIso(event.appliedAt) && Date.parse(event.appliedAt) > Date.parse(now))
      || (event.studyRun && Date.parse(event.studyRun.startedAt) > Date.parse(now));
    const relevantOrigin = ['game', 'practice', 'drill', 'retest'].includes(event.origin)
      || event.origin === undefined;
    if (event.status === 'supported' && event.forced !== true && relevantOrigin && !future) {
      if (event.mixObservation) {
        try {
          const observation = validateMixObservation(event.mixObservation);
          if (referenceQuality(observation.sourceIdentity).quality !== 'heuristic-reference') {
            unknownPreTrackingExposure = true;
          } else {
          const key = pairKey(observation.sourceIdentity, observation.spotKey, observation.handClass);
          if (!seen.has(key)) seen.set(key, {
            sourceIdentity: clone(observation.sourceIdentity),
            spotKey: observation.spotKey,
            handClass: observation.handClass,
          });
          if (event.grade === 'off-policy') {
            const candidate = {
              origin: projectionOrigin(event.origin),
              sourceIdentity: clone(observation.sourceIdentity),
              spotKey: observation.spotKey,
              handClass: observation.handClass,
              reason: 'reference-deviation',
            };
            if (candidate.origin === 'game' && gameGoal === null) gameGoal = candidate;
            if (candidate.origin === 'practice' && practiceGoal === null) practiceGoal = candidate;
          }
          }
        } catch {
          unknownPreTrackingExposure = true;
        }
      } else {
        unknownPreTrackingExposure = true;
      }
    }
    const id = event.studyRun?.id;
    if (typeof id === 'string' && id && projectionOrigin(event.origin) === 'practice') {
      const entries = groups.get(id) ?? [];
      entries.push({ event });
      groups.set(id, entries);
    }
  }
  const runs = [...groups.values()].map((entries) => summarizeRun(entries, now)).filter(Boolean);
  const assessments = runs.filter((run) => run.mode === 'assessment');
  const retests = runs.filter((run) => run.mode === 'retest');
  const assessmentById = new Map(assessments.map((run) => [run.id, run]));
  const latestByAssessment = new Map();
  for (const retest of [...retests].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    const baseline = assessmentById.get(retest.assessmentId);
    if (!baseline?.complete || !retest.sourceIdentity
      || sourceKey(baseline.sourceIdentity) !== sourceKey(retest.sourceIdentity)
      || questionSetKey(baseline.questions) !== questionSetKey(retest.questions)) {
      retest.complete = false;
      retest.reason = 'INCONSISTENT_RUN';
      retest.completedAt = null;
    }
    if (retest.complete) {
      const latest = latestByAssessment.get(retest.assessmentId);
      const boundary = Math.max(Date.parse(baseline.completedAt), latest ? Date.parse(latest.completedAt) : 0) + DAY_MS;
      if (Date.parse(retest.startedAt) < boundary) {
        retest.complete = false;
        retest.reason = 'RETEST_NOT_DUE';
        retest.completedAt = null;
      } else latestByAssessment.set(retest.assessmentId, retest);
    }
    if (!retest.complete) retest.result = { ...retest.result, allowed: null, allowedActionRate: null };
  }
  for (const assessment of assessments) {
    assessment.retests = retests
      .filter((run) => run.assessmentId === assessment.id)
      .sort((left, right) => String(left.completedAt ?? left.startedAt)
        .localeCompare(String(right.completedAt ?? right.startedAt)));
    assessment.latestCompletedRetest = [...assessment.retests].reverse().find((run) => run.complete) ?? null;
  }
  return {
    schemaVersion: 1,
    unknownPreTrackingExposure,
    seenPairs: [...seen.values()],
    assessments,
    retests,
    goal: gameGoal ?? practiceGoal ?? {
      origin: 'default',
      sourceIdentity: null,
      spotKey: '6max-100bb-btn-rfi-unopened',
      handClass: 'AJo',
      reason: 'default-supported-spot',
    },
  };
}

export function retestEligibility(assessment, now = new Date().toISOString()) {
  if (!assessment?.complete || !validIso(assessment.startedAt) || !validIso(assessment.completedAt) || !validIso(now)) {
    return { eligible: false, nextAvailableAt: null, reason: 'INCOMPLETE_ASSESSMENT' };
  }
  if (Date.parse(assessment.startedAt) > Date.parse(assessment.completedAt)
    || Date.parse(assessment.completedAt) > Date.parse(now)) {
    return { eligible: false, nextAvailableAt: null, reason: 'FUTURE_OR_INCONSISTENT_EVIDENCE' };
  }
  const latest = assessment.latestCompletedRetest;
  if (latest?.complete && (!validIso(latest.startedAt) || !validIso(latest.completedAt)
    || Date.parse(latest.startedAt) > Date.parse(latest.completedAt)
    || Date.parse(latest.completedAt) > Date.parse(now))) {
    return { eligible: false, nextAvailableAt: null, reason: 'FUTURE_OR_INCONSISTENT_EVIDENCE' };
  }
  const boundarySource = latest?.complete && validIso(latest.completedAt) ? latest.completedAt : assessment.completedAt;
  const nextAvailableAt = new Date(Date.parse(boundarySource) + DAY_MS).toISOString();
  return {
    eligible: Date.parse(now) >= Date.parse(nextAvailableAt),
    nextAvailableAt,
  };
}
