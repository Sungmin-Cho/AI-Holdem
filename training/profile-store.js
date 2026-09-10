import { NO_HINT_ASSISTANCE, projectAssistance, assistanceError } from '../shared/assistance.js';
import {dealSelectionFields} from '../shared/deal-selection.js';
import { referenceAssessmentEligibility } from '../shared/reference-coverage.js';
import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { assertEvaluationId } from './contracts.js';
import { classifyOpportunity } from './opportunities.js';
import { validateMixObservation } from '../shared/reference.js';
import { validateStudyRun } from '../shared/study-contract.js';
import { learningEventKey, validateLearningEvents } from './study-history.js';

function requireIo(io, names) {
  for (const name of names) {
    if (typeof io?.[name] !== 'function') {
      const error = new Error(`training store io.${name}가 필요합니다.`);
      error.code = 'IO_NOT_INJECTED';
      throw error;
    }
  }
  return io;
}

import {
  applyEvent,
  assertProfileEvent,
  emptyProfile,
  PROFILE_SCHEMA_VERSION,
  projectActive,
  rebuildFromEvents,
} from './profile-aggregator.js';

const PROFILE_LOCK = 'profile.lock.d';

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function eventFromEvaluation(evaluation, appliedAt, classified = classifyOpportunity(evaluation)) {
  if (['practice','import'].includes(evaluation.origin) && evaluation.assistance === undefined) throw assistanceError();
  const event = {
    schemaVersion: evaluation.dealSelectionContractVersion != null ? 7 : PROFILE_SCHEMA_VERSION,
    ...dealSelectionFields(evaluation),
    assistance: projectAssistance(evaluation.assistance ?? NO_HINT_ASSISTANCE),
    evaluationId: evaluation.evaluationId,
    payloadSha256: evaluation.payloadSha256,
    skillKey: classified.skillKey,
    street: classified.street,
    status: evaluation.status,
    grade: evaluation.grade ?? null,
    forced: Boolean(evaluation.forced),
    evLossBb: evaluation.evLossBb ?? null,
    providerId: classified.providerId,
    providerVersion: classified.providerVersion,
    appliedAt,
    ...(['game', 'practice', 'drill', 'retest'].includes(evaluation.origin)
      ? { origin: evaluation.origin }
      : { origin: 'game' }),
  };
  if (evaluation.source?.version === '2.0.0' && evaluation.source?.id === 'local-preflop-baseline') {
    event.sourceIdentity = { id:evaluation.source.id, version:evaluation.source.version, contentSha256:evaluation.source.contentSha256 };
    if (Object.hasOwn(evaluation, 'coverage')) event.coverage = structuredClone(evaluation.coverage);
  }
  if ((evaluation.source?.version !== '2.0.0' || referenceAssessmentEligibility(evaluation).metricEligible)
    && evaluation.status === 'supported'
    && evaluation.source?.contentSha256
    && Array.isArray(evaluation.recommended)
    && evaluation.recommended.length > 0
    && evaluation.chosen) {
    const observation = {
      spotKey: evaluation.spotKey,
      handClass: evaluation.handClass,
      referenceActions: evaluation.recommended,
      chosenAction: evaluation.chosen,
      sourceIdentity: {
        id: evaluation.source.id,
        version: evaluation.source.version,
        contentSha256: evaluation.source.contentSha256,
      },
      ...(evaluation.detailSha256 ? { detailSha256: evaluation.detailSha256 } : {}),
    };
    event.mixObservation = validateMixObservation(observation);
  }
  if (evaluation.studyRun !== undefined) event.studyRun = validateStudyRun(evaluation.studyRun);
  assertProfileEvent(event);
  return event;
}

/** Reproduce a verified journal row's original version without rewriting it. */
export function eventForPrior(evaluation, prior) {
  assertProfileEvent(prior);
  // Historical practice/import rows may be compared, but this exception never
  // issues a new journal row: apply resolves the existing id before projection.
  const historicalPractice = prior.schemaVersion !== 6 && !Object.hasOwn(prior,'assistance')
    && evaluation.assistance === undefined && ['practice','import'].includes(evaluation.origin);
  const event = eventFromEvaluation(historicalPractice ? {...evaluation,assistance:NO_HINT_ASSISTANCE} : evaluation, prior.appliedAt);
  if (prior.schemaVersion === 7) {
    if (event.schemaVersion !== 7 || JSON.stringify(dealSelectionFields(prior)) !== JSON.stringify(dealSelectionFields(event))) {
      throw coded('PROFILE_EVENT_CONFLICT','deal selection contract cannot change');
    }
    return event;
  }
  if (event.schemaVersion === 7) throw coded('PROFILE_EVENT_CONFLICT','deal selection contract cannot be downgraded');
  if (prior.schemaVersion === 6) return event;
  if (evaluation.assistance?.hintShown || (evaluation.assistance !== undefined
    && !['drill','retest'].includes(evaluation.origin))) {
    throw coded('PROFILE_EVENT_CONFLICT', 'contract-bearing game cannot downgrade to historical omission');
  }
  if (prior.schemaVersion === undefined) delete event.schemaVersion;
  else event.schemaVersion = prior.schemaVersion;
  if (!Object.hasOwn(prior,'assistance')) delete event.assistance;
  return event;
}

function streetFromEvaluationId(evaluationId) {
  try {
    assertEvaluationId(evaluationId);
  } catch {
    throw coded('PROFILE_EVENT_INVALID', 'evaluationId가 계약 문법을 벗어났습니다.');
  }
  const decisionId = evaluationId.split(':')[1];
  return decisionId.split('-')[2];
}

function rebuildLearnableFromEvents(events) {
  const learnable = [];
  const processed = {};
  let updatedAt = null;
  for (const event of validateLearningEvents(events)) {
    const street = streetFromEvaluationId(event?.evaluationId);
    assertProfileEvent(event);
    const seen = processed[event.evaluationId];
    if (seen && seen !== event.payloadSha256) {
      throw coded('PROFILE_EVENT_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
    }
    if (!seen) processed[event.evaluationId] = event.payloadSha256;
    if (street === 'preflop') learnable.push(event);
    updatedAt = event.appliedAt ?? updatedAt;
  }
  const profile = rebuildFromEvents(learnable);
  profile.processed = processed;
  profile.updatedAt = updatedAt;
  return projectActive(profile);
}

function assertProcessedBacked(profile, rebuilt) {
  for (const [id, digest] of Object.entries(profile?.processed ?? {})) {
    if (rebuilt.processed[id] !== digest) {
      throw coded('UNSUPPORTED_PROFILE', `processed evidence is not backed by the journal: ${id}`);
    }
  }
}

function assertDigestMigrationBacked(profile, rebuilt, { oldToNew = {}, byEvaluationId = {} }) {
  for (const [id, digest] of Object.entries(profile?.processed ?? {})) {
    const journalDigest = rebuilt.processed[id];
    if (journalDigest === digest) continue;
    const mapping = byEvaluationId[id];
    if (!mapping || mapping.old !== digest || mapping.new !== journalDigest
      || oldToNew[digest] !== journalDigest) {
      throw coded('UNSUPPORTED_PROFILE', `processed evidence is not authorized by digest map: ${id}`);
    }
  }
}

// R12: fs helper는 주입받는다. 기본값 없음.
export function createProfileStore(storeDir, { now = () => new Date().toISOString(), io } = {}) {
  const {
    appendJsonl, ensureDir, readJsonl, readJsonSecure, writeJsonSecure, writeTextSecure,
  } = requireIo(
    io,
    ['appendJsonl', 'ensureDir', 'readJsonl', 'readJsonSecure', 'writeJsonSecure', 'writeTextSecure'],
  );
  const root = path.join(storeDir, '.training');
  const profilePath = path.join(root, 'profile.json');
  const eventsPath = path.join(root, 'profile-events.jsonl');

  async function withLock(fn) {
    ensureDir(root);
    return withNamedLock(root, PROFILE_LOCK, fn);
  }

  function migrateLegacyProfile(profile, { persist = true } = {}) {
    const events = readJsonl(eventsPath);
    const processedIds = Object.keys(profile.processed ?? {});
    if (events.length === 0 && (processedIds.length > 0 || (profile.game?.overall?.evaluatedDecisions ?? 0) > 0 || (profile.practice?.overall?.evaluatedDecisions ?? 0) > 0 || Object.keys(profile.segments ?? {}).length > 0)) {
      throw coded('UNSUPPORTED_PROFILE', `schema ${profile.schemaVersion} events cannot support schema ${PROFILE_SCHEMA_VERSION}`);
    }
    const rebuilt = rebuildLearnableFromEvents(events);
    assertProcessedBacked(profile, rebuilt);
    if (persist) writeJsonSecure(profilePath, rebuilt);
    return rebuilt;
  }

  function loadProfile({ persistLegacy = true } = {}) {
    try {
      const profile = readJsonSecure(profilePath);
      if (profile.schemaVersion === PROFILE_SCHEMA_VERSION) {
        const events = readJsonl(eventsPath);
        if (events.length === 0 && Object.keys(profile.processed ?? {}).length === 0) {
          const hasDerivedEvidence = (profile.game?.overall?.evaluatedDecisions ?? 0) !== 0
            || (profile.practice?.overall?.evaluatedDecisions ?? 0) !== 0
            || Object.keys(profile.segments ?? {}).length !== 0;
          if (hasDerivedEvidence) {
            throw coded('UNSUPPORTED_PROFILE', `schema ${PROFILE_SCHEMA_VERSION} derived evidence has no journal`);
          }
          return projectActive(profile);
        }
        const rebuilt = rebuildLearnableFromEvents(events);
        assertProcessedBacked(profile, rebuilt);
        if (Object.keys(rebuilt.processed).length > Object.keys(profile.processed ?? {}).length
          && persistLegacy) writeJsonSecure(profilePath, rebuilt);
        return rebuilt;
      }
      if ([1, 2, 3, 4, 5].includes(profile.schemaVersion)) {
        return migrateLegacyProfile(profile, { persist: persistLegacy });
      }
      throw coded('UNSUPPORTED_PROFILE', `schema ${profile.schemaVersion}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const events = readJsonl(eventsPath);
        if (events.length === 0) return emptyProfile();
        const rebuilt = rebuildLearnableFromEvents(events);
        if (persistLegacy) writeJsonSecure(profilePath, rebuilt);
        return rebuilt;
      }
      throw error;
    }
  }

  async function apply(evaluation) {
    return withLock(() => {
      const classified = classifyOpportunity(evaluation);
      if (!classified.learnable) {
        const profile = loadProfile({ persistLegacy: false });
        return { applied: false, reason: 'NOT_LEARNABLE', profile };
      }
      const appliedAt = now();
      const prior = validateLearningEvents(readJsonl(eventsPath)).find((row) => row.evaluationId === evaluation.evaluationId);
      const event = prior ? eventForPrior(evaluation,prior) : eventFromEvaluation(evaluation, appliedAt, classified);
      if (typeof event.payloadSha256 !== 'string' || event.payloadSha256.length === 0) {
        throw coded('PROFILE_EVENT_INVALID', 'payloadSha256이 없습니다.');
      }
      if (prior && learningEventKey(prior, { includeTime: false }) !== learningEventKey(event, { includeTime: false })) {
        throw coded('PROFILE_EVENT_CONFLICT', 'same evaluationId has different learning metadata');
      }
      let profile = loadProfile();
      const seen = profile.processed[event.evaluationId];
      const duplicate = Boolean(seen && seen === event.payloadSha256);
      if (duplicate) return { applied: false, profile };
      profile = applyEvent(profile, event);
      if (!readJsonl(eventsPath).some((row) => row.evaluationId === event.evaluationId
        && row.payloadSha256 === event.payloadSha256)) {
        appendJsonl(eventsPath, event);
      }
      writeJsonSecure(profilePath, profile);
      return { applied: true, profile };
    });
  }

  async function migrateDigests({ oldToNew = {}, byEvaluationId = {} } = {}) {
    return withLock(() => {
      let current = null;
      try {
        current = readJsonSecure(profilePath);
        if (![1, 2, 3, 4, 5, PROFILE_SCHEMA_VERSION].includes(current.schemaVersion)) {
          throw coded('UNSUPPORTED_PROFILE', `schema ${current.schemaVersion}`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const originalEvents = readJsonl(eventsPath);
      const originalProfile = rebuildLearnableFromEvents(originalEvents);
      if (current) assertDigestMigrationBacked(current, originalProfile, { oldToNew, byEvaluationId });
      const events = originalEvents.map((event) => {
        const mapped = byEvaluationId[event.evaluationId]?.new
          ?? oldToNew[event.payloadSha256]
          ?? event.payloadSha256;
        return { ...event, payloadSha256: mapped };
      });
      const profile = rebuildLearnableFromEvents(events);
      writeTextSecure(eventsPath, events.length ? `${events.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
      writeJsonSecure(profilePath, profile);
      return profile;
    });
  }

  async function rebuild() {
    return withLock(() => {
      const events = readJsonl(eventsPath);
      const profile = rebuildLearnableFromEvents(events);
      try {
        const current = readJsonSecure(profilePath);
        if (![1, 2, 3, 4, 5, PROFILE_SCHEMA_VERSION].includes(current.schemaVersion)) {
          throw coded('UNSUPPORTED_PROFILE', `schema ${current.schemaVersion}`);
        }
        assertProcessedBacked(current, profile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      writeJsonSecure(profilePath, profile);
      return profile;
    });
  }

  async function show() {
    return withLock(() => loadProfile());
  }

  async function readEventSnapshot() {
    return withLock(() => JSON.parse(JSON.stringify(validateLearningEvents(readJsonl(eventsPath)))));
  }

  async function reset() {
    return withLock(() => {
      const profile = emptyProfile();
      profile.updatedAt = now();
      writeJsonSecure(profilePath, profile);
      writeTextSecure(eventsPath, '');
      return profile;
    });
  }

  return { apply, rebuild, show, readEventSnapshot, reset, migrateDigests, profilePath, eventsPath, root };
}
