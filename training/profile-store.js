import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { classifyOpportunity } from './opportunities.js';
import {
  applyEvent,
  emptyProfile,
  PROFILE_SCHEMA_VERSION,
  projectActive,
  rebuildFromEvents,
} from './profile-aggregator.js';
import {
  appendJsonl,
  ensureDir,
  readJsonl,
  readJsonSecure,
  writeJsonSecure,
  writeTextSecure,
} from '../tools/training-store.js';

const PROFILE_LOCK = 'profile.lock.d';

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function eventFromEvaluation(evaluation, appliedAt) {
  const classified = classifyOpportunity(evaluation);
  return {
    evaluationId: evaluation.evaluationId,
    payloadSha256: evaluation.payloadSha256,
    skillKey: classified.skillKey,
    status: evaluation.status,
    grade: evaluation.grade ?? null,
    forced: Boolean(evaluation.forced),
    evLossBb: evaluation.evLossBb ?? null,
    providerId: classified.providerId,
    providerVersion: classified.providerVersion,
    appliedAt,
    ...(evaluation.origin === 'drill' ? { origin: 'drill' } : {}),
  };
}

export function createProfileStore(storeDir, { now = () => new Date().toISOString() } = {}) {
  const root = path.join(storeDir, '.training');
  const profilePath = path.join(root, 'profile.json');
  const eventsPath = path.join(root, 'profile-events.jsonl');

  async function withLock(fn) {
    ensureDir(root);
    return withNamedLock(root, PROFILE_LOCK, fn);
  }

  function migrateSchema1(profile) {
    const events = readJsonl(eventsPath);
    const processedIds = Object.keys(profile.processed ?? {});
    if (processedIds.length > 0 && events.length === 0) {
      throw coded('UNSUPPORTED_PROFILE', 'schema 1 events cannot support schema 2');
    }
    const rebuilt = rebuildFromEvents(events);
    for (const id of processedIds) {
      if (!Object.prototype.hasOwnProperty.call(rebuilt.processed, id)
        || rebuilt.processed[id] !== profile.processed[id]) {
        throw coded('UNSUPPORTED_PROFILE', 'schema 1 events cannot support schema 2');
      }
    }
    writeJsonSecure(profilePath, rebuilt);
    return rebuilt;
  }

  function loadProfile() {
    try {
      const profile = readJsonSecure(profilePath);
      if (profile.schemaVersion === PROFILE_SCHEMA_VERSION) {
        return projectActive(profile);
      }
      if (profile.schemaVersion === 1) {
        return migrateSchema1(profile);
      }
      throw coded('UNSUPPORTED_PROFILE', `schema ${profile.schemaVersion}`);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyProfile();
      throw error;
    }
  }

  async function apply(evaluation) {
    return withLock(() => {
      const appliedAt = now();
      const event = eventFromEvaluation(evaluation, appliedAt);
      if (typeof event.payloadSha256 !== 'string' || event.payloadSha256.length === 0) {
        throw coded('PROFILE_EVENT_INVALID', 'payloadSha256이 없습니다.');
      }
      let profile = loadProfile();
      const seen = profile.processed[event.evaluationId];
      const duplicate = Boolean(seen && seen === event.payloadSha256);
      profile = applyEvent(profile, event);
      if (!duplicate && !readJsonl(eventsPath).some((row) => row.evaluationId === event.evaluationId
        && row.payloadSha256 === event.payloadSha256)) {
        appendJsonl(eventsPath, event);
      }
      writeJsonSecure(profilePath, profile);
      return { applied: !duplicate, profile };
    });
  }

  async function migrateDigests({ oldToNew = {}, byEvaluationId = {} } = {}) {
    return withLock(() => {
      try {
        const current = readJsonSecure(profilePath);
        if (current.schemaVersion === 1) migrateSchema1(current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const events = readJsonl(eventsPath).map((event) => {
        const mapped = byEvaluationId[event.evaluationId]?.new
          ?? oldToNew[event.payloadSha256]
          ?? event.payloadSha256;
        return { ...event, payloadSha256: mapped };
      });
      writeTextSecure(eventsPath, events.length ? `${events.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
      const profile = rebuildFromEvents(events);
      writeJsonSecure(profilePath, profile);
      return profile;
    });
  }

  async function rebuild() {
    return withLock(() => {
      const events = readJsonl(eventsPath);
      const profile = rebuildFromEvents(events);
      writeJsonSecure(profilePath, profile);
      return profile;
    });
  }

  async function show() {
    return withLock(() => loadProfile());
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

  return { apply, rebuild, show, reset, migrateDigests, profilePath, eventsPath, root };
}
