import { createMistakeBank, createProfileStore } from './training-stores.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { rebuildFromEvents } from '../training/profile-aggregator.js';
import { studyHistory, retestEligibility } from '../training/study-history.js';
import { CANONICAL_REFERENCE_SOURCE, KNOWN_REFERENCE_SOURCES, referenceQuality } from '../shared/reference.js';

const sameSource = (a, b) => a?.id === b?.id && a?.version === b?.version && a?.contentSha256 === b?.contentSha256;
const safeSource = (value) => value && typeof value.id === 'string' && value.id.length <= 128
  && typeof value.version === 'string' && value.version.length <= 64 && /^[0-9a-f]{64}$/.test(value.contentSha256)
  ? { id: value.id, version: value.version, contentSha256: value.contentSha256 } : null;
const originOf = (event) => ['practice', 'drill', 'retest'].includes(event.origin) ? 'practice' : 'game';
const future = (event, now) => Date.parse(event.appliedAt) > now || Date.parse(event.studyRun?.startedAt) > now;

function runSummary(run, now, baseline) {
  return {
    id: run.id, mode: run.mode, total: run.total, startedAt: run.startedAt,
    ...(run.assessmentId ? { assessmentId: run.assessmentId } : {}),
    complete: run.complete, reason: run.reason, completedAt: run.completedAt,
    sourceIdentity: safeSource(run.sourceIdentity),
    result: { allowed: run.result.allowed, total: run.result.total, allowedActionRate: run.result.allowedActionRate },
    retest: retestEligibility(baseline ?? run, now),
  };
}
function projection(value, origin, events, source) {
  const overall = value.overall, coverage = value.coverage;
  const candidates = [];
  const pairs = new Set();
  // Aggregate skills cannot invent a hand class. Select actual validated observed
  // pairs only; the aggregate supplies the strength of that reference candidate.
  for (const candidate of value.candidates) {
    for (const event of events) {
      const observed = event.mixObservation;
      if (event.skillKey !== candidate.id || originOf(event) !== origin || event.grade !== 'off-policy'
        || event.forced || !sameSource(observed?.sourceIdentity, source)) continue;
      const key = `${observed.spotKey}:${observed.handClass}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      candidates.push({ origin, spotKey: observed.spotKey, handClass: observed.handClass,
        sourceIdentity: safeSource(observed.sourceIdentity), reason: 'reference-deviation',
        opportunities: candidate.opportunities, evidence: candidate.evidence,
        allowedActionRate: candidate.allowedActionRate, sampleWeight: candidate.confidence });
      if (candidates.length >= 10) break;
    }
    if (candidates.length >= 10) break;
  }
  return { origin,
    overall: { evaluatedDecisions: overall.evaluatedDecisions, supportedDecisions: overall.supportedDecisions,
      unsupportedDecisions: overall.unsupportedDecisions, forfeits: overall.forfeits, allowed: overall.allowed,
      offPolicy: overall.offPolicy, allowedActionRate: overall.supportedDecisions ? overall.allowedActionRate : null,
      modalActionRate: overall.supportedDecisions ? overall.modalActionRate : null, sampleWeight: overall.sampleWeight },
    coverage: { ...coverage, evaluatedDecisions: coverage.evaluatedDecisions, supportedDecisions: coverage.supportedDecisions,
      unsupportedDecisions: coverage.unsupportedDecisions, unverifiedDecisions: coverage.unverifiedDecisions,
      supportedRate: coverage.evaluatedDecisions ? coverage.supportedRate : null },
    calibration: { distributionAgreement: value.calibration.distributionAgreement,
      eligibleObservations: value.calibration.eligibleObservations, totalObservations: value.calibration.totalObservations,
      reason: value.calibration.reason }, candidates,
  };
}

/** Public projection from validated store APIs; no active aliases or raw journal. */
export async function readStudySummary(storeDir) {
  const profileStore = createProfileStore(storeDir);
  const events = await profileStore.readEventSnapshot();
  if (events.length > 100_000) {
    const error = new Error('STUDY_HISTORY_TOO_LARGE'); error.code = 'STUDY_HISTORY_TOO_LARGE'; throw error;
  }
  const now = new Date().toISOString();
  const activeId = rebuildFromEvents(events.filter(event=>!future(event,Date.parse(now)))).activeSegmentId;
  const selected = KNOWN_REFERENCE_SOURCES.find(s=>`${s.id}@${s.version}`===activeId) ?? CANONICAL_REFERENCE_SOURCE;
  const { data, contentSha256 } = loadReferenceDataset(selected);
  const source = safeSource({ id: data.id, version: data.version, contentSha256 });
  for (const event of events) {
    const pair = event.mixObservation;
    if (sameSource(pair?.sourceIdentity, source)
      && (!Object.hasOwn(data.spots, pair.spotKey) || !Object.hasOwn(data.spots[pair.spotKey], pair.handClass))) {
      const error = new Error('PROFILE_EVENT_INVALID'); error.code = 'PROFILE_EVENT_INVALID'; throw error;
    }
  }
  // Preserve the profile store's preflop-only scope, including historical rows
  // whose optional street field was absent. Validation above pins the ID format.
  const learningEvents = events.filter((event) => event.evaluationId.split(':')[1].split('-')[2] === 'preflop');
  const metricsEvents = learningEvents.filter((event) => !future(event, Date.parse(now)));
  await profileStore.show(); // Keep schema/conflict failures visible after validating projection inputs.
  const profile = rebuildFromEvents(metricsEvents);
  const history = studyHistory(learningEvents, now);
  const bank = await createMistakeBank(storeDir).list();
  const availableBank = bank.filter((item) => sameSource(item.sourceIdentity, source)
    && referenceQuality(item.sourceIdentity).quality === 'heuristic-reference');
  const goal = history.goal;
  return { schemaVersion: 1, source,
    game: projection(profile.game, 'game', metricsEvents, source),
    practice: projection(profile.practice, 'practice', metricsEvents, source),
    bank: { totalCount: availableBank.length,
      dueCount: availableBank.filter((item) => Date.parse(item.nextReviewAt) <= Date.parse(now)).length },
    goal: { origin: goal.origin, sourceIdentity: safeSource(goal.sourceIdentity), spotKey: goal.spotKey,
      handClass: goal.handClass, reason: goal.reason },
    assessments: history.assessments.slice(-100).map((run) => runSummary(run, now)),
    retests: history.retests.slice(-100).map((run) => runSummary(run, now,
      history.assessments.find((baseline) => baseline.id === run.assessmentId))),
  };
}
