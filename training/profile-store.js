import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { classifyOpportunity } from './opportunities.js';
import { applyEvent, emptyProfile, rebuildFromEvents } from './profile-aggregator.js';
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

  function loadProfile() {
    try {
      const profile = readJsonSecure(profilePath);
      if (profile.schemaVersion !== 1) {
        throw coded('UNSUPPORTED_PROFILE', `schema ${profile.schemaVersion}`);
      }
      return profile;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyProfile();
      throw error;
    }
  }

  async function apply(evaluation) {
    return withLock(() => {
      const appliedAt = now();
      const event = eventFromEvaluation(evaluation, appliedAt);
      let profile = loadProfile();
      profile = applyEvent(profile, event);
      if (!readJsonl(eventsPath).some((row) => row.evaluationId === event.evaluationId
        && row.payloadSha256 === event.payloadSha256)) {
        appendJsonl(eventsPath, event);
      }
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

  return { apply, rebuild, show, reset, profilePath, eventsPath, root };
}
