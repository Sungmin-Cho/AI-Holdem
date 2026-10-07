import { independentAssessmentEligibility, projectAssistance } from '../shared/assistance.js';
import {dealSelectionFields} from '../shared/deal-selection.js';
import {referenceAssessmentEligibility} from '../shared/reference-coverage.js';
import { CANONICAL_REFERENCE_SOURCE, validateMixObservation, matchReferenceActionFor, referenceQuality, referenceSchemaOf } from '../shared/reference.js';
import { validateStudyRun } from '../shared/study-contract.js';
import { assertProfileEvent } from './profile-aggregator.js';
import { assertEvaluationId, coded } from './contracts.js';
import { goalSelection } from './goal.js';

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
    ...(Object.hasOwn(event,'assistance') ? {assistance:projectAssistance(event.assistance)} : {}),
    ...dealSelectionFields(event),
    ...(Object.hasOwn(event,'coverage') ? {coverage:event.coverage} : {}),
    ...(event.sourceIdentity ? {sourceIdentity:event.sourceIdentity} : {}),
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
    if (!independentAssessmentEligibility(entry.event).metricEligible) verified = false;
    if (![4,5,6].includes(entry.event.schemaVersion)) legacy = true;
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
      allowed: (matchReferenceActionFor(observation.sourceIdentity, observation.referenceActions, observation.chosenAction)?.frequency ?? 0) > 0,
      foldAllowed: observation.referenceActions.some((row) => row.action === 'fold' && row.frequency > 0),
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
  const foldAllowed = questions.filter((question) => question.foldAllowed).length;
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
    questions: questions.map(({ appliedAt, foldAllowed: _fold, ...question }) => future ? { ...question, grade: null, allowed: null } : question),
    result: {
      allowed: complete ? allowed : null,
      total: questions.length,
      allowedActionRate: complete ? allowed / questions.length : null,
      // What always folding would have scored on these questions (design D12).
      foldBaselineRate: complete && questions.length ? foldAllowed / questions.length : null,
    },
  };
}

// Trends (design D12). Only runs drawn the same way share a line: the
// assessments of one source (one sampler), and each assessment with its own
// retests (the same questions). Free, leak, daily, review and transfer runs
// depend on what was chosen and form no series. Per game session: the
// independently graded decisions and their allowed share, with the source.
export function trendsOf(runs, events, now) {
  const done = runs.filter((run) => run.complete && run.sourceIdentity);
  const byId = new Map(done.map((run) => [run.id, run]));
  const row = (run, series) => ({ id: run.id, mode: run.mode, series, startedAt: run.startedAt,
    total: run.total, allowedActionRate: run.result.allowedActionRate, foldBaselineRate: run.result.foldBaselineRate });
  const practice = [];
  for (const run of done) {
    if (run.mode === 'assessment') practice.push(row(run, `${sourceKey(run.sourceIdentity)}|assessment`));
    if (run.mode !== 'retest') continue;
    const baseline = byId.get(run.assessmentId);
    if (!baseline || baseline.mode !== 'assessment' || sourceKey(baseline.sourceIdentity) !== sourceKey(run.sourceIdentity)) continue;
    const series = `${sourceKey(run.sourceIdentity)}|retest|${baseline.id}`;
    if (!practice.some((entry) => entry.series === series)) practice.push(row(baseline, series));
    practice.push(row(run, series));
  }
  practice.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const sessions = new Map();
  for (const event of events) {
    if (projectionOrigin(event.origin) !== 'game' || !event.mixObservation || !validIso(event.appliedAt)
      || Date.parse(event.appliedAt) > Date.parse(now)) continue;
    let eligible = false;
    try { eligible = independentAssessmentEligibility(event).metricEligible; } catch { eligible = false; }
    if (!eligible) continue;
    const observation = event.mixObservation;
    const key = String(event.evaluationId).split(':')[0];
    const row = sessions.get(key) ?? { startedAt: event.appliedAt, source: `${observation.sourceIdentity.id}@${observation.sourceIdentity.version}`, graded: 0, allowed: 0 };
    row.graded += 1;
    if ((matchReferenceActionFor(observation.sourceIdentity, observation.referenceActions, observation.chosenAction)?.frequency ?? 0) > 0) row.allowed += 1;
    sessions.set(key, row);
  }
  const game = [...sessions.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((row, index) => ({ session: index + 1, startedAt: row.startedAt, source: row.source, graded: row.graded, allowedActionRate: row.allowed / row.graded }));
  return { practice, game };
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
  const validEvents = validateLearningEvents(events);
  for (const event of validEvents) {
    const future = (validIso(event.appliedAt) && Date.parse(event.appliedAt) > Date.parse(now))
      || (event.studyRun && Date.parse(event.studyRun.startedAt) > Date.parse(now));
    const relevantOrigin = ['game', 'practice', 'drill', 'retest'].includes(event.origin)
      || event.origin === undefined;
    if (event.status === 'supported' && !event.forced && relevantOrigin && !future
      && !referenceAssessmentEligibility(event).verified) unknownPreTrackingExposure = true;
    if (referenceAssessmentEligibility(event).metricEligible && relevantOrigin && !future) {
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
          if (independentAssessmentEligibility(event).metricEligible && event.grade === 'off-policy') {
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
  const selection = goalSelection(validEvents, { now });
  return {
    schemaVersion: 1,
    unknownPreTrackingExposure,
    seenPairs: [...seen.values()],
    assessments,
    retests,
    trends: trendsOf(runs, validEvents, now),
    // The shared goal (training/goal.js) at `now`. The oldest-deviation pick is a
    // fallback only without independent evidence; a resolved record keeps the default.
    goal: selection.goal ?? (selection.state === 'none' ? gameGoal ?? practiceGoal : null) ?? {
      origin: 'default',
      sourceIdentity: null,
      // The default practice spot follows the source new sessions use.
      spotKey: referenceSchemaOf(CANONICAL_REFERENCE_SOURCE) === 3 ? '6max-100bb-btn-rfi-v3' : '6max-100bb-btn-rfi-v2',
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
