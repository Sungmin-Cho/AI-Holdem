import { detectLeaks } from './leak-detector.js';
import { confidenceOf, masteryOf } from './mastery.js';

export const DEFAULT_ACTIVE_SEGMENT_ID = 'local-preflop-baseline@1.0.0';
export const PROFILE_SCHEMA_VERSION = 3;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emptyOverall() {
  return {
    evaluatedDecisions: 0,
    supportedDecisions: 0,
    unsupportedDecisions: 0,
    forfeits: 0,
    preferred: 0,
    offPolicy: 0,
    evLossBb: null,
    evLossBbPer100: null,
  };
}

export function emptyProfile() {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    updatedAt: null,
    processed: {},
    overall: emptyOverall(),
    skills: {},
    leaks: [],
    coverageGaps: [],
    segments: {},
    activeSegmentId: DEFAULT_ACTIVE_SEGMENT_ID,
    hasGameEvents: false,
  };
}

function bumpEv(current, add) {
  if (add == null) return current;
  return (current ?? 0) + add;
}

function per100(loss, supported) {
  if (loss == null || !supported) return null;
  return (loss / supported) * 100;
}

function skillRow() {
  return {
    opportunities: 0,
    supported: 0,
    preferred: 0,
    offPolicy: 0,
    preferredActionRate: 0,
    evLossBb: null,
    evLossBbPer100: null,
    mastery: 0,
    confidence: 0,
  };
}

function finishSkill(skill) {
  skill.preferredActionRate = skill.supported ? skill.preferred / skill.supported : 0;
  skill.confidence = confidenceOf(skill.opportunities);
  skill.mastery = masteryOf({
    preferredActionRate: skill.preferredActionRate,
    opportunities: skill.opportunities,
  });
  skill.evLossBbPer100 = per100(skill.evLossBb, skill.supported);
  return skill;
}

function finishOverall(overall) {
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
    overall.evLossBb = bumpEv(overall.evLossBb, event.evLossBb);
  } else {
    overall.unsupportedDecisions += 1;
  }
}

function isSafeMapKey(key) {
  return typeof key === 'string'
    && key.length > 0
    && key !== '__proto__'
    && key !== 'constructor'
    && key !== 'prototype';
}

export function assertProfileEvent(event) {
  if (typeof event?.evaluationId !== 'string' || event.evaluationId.length === 0) {
    throw coded('PROFILE_EVENT_INVALID', 'evaluationId가 없습니다.');
  }
  if (typeof event?.payloadSha256 !== 'string' || event.payloadSha256.length === 0) {
    throw coded('PROFILE_EVENT_INVALID', 'payloadSha256이 없습니다.');
  }
  if (!isSafeMapKey(event.skillKey)) {
    throw coded('PROFILE_EVENT_INVALID', 'skillKey가 없습니다.');
  }
  if (!isSafeMapKey(event.providerId) || typeof event.providerVersion !== 'string'
    || event.providerVersion.length === 0) {
    throw coded('PROFILE_EVENT_INVALID', 'provider가 없습니다.');
  }
}

function applyToSkill(skills, event) {
  if (event.forced) return;
  const row = skills[event.skillKey] ?? skillRow();
  row.opportunities += 1;
  if (event.status === 'supported') {
    row.supported += 1;
    if (event.grade === 'preferred') row.preferred += 1;
    if (event.grade === 'off-policy') row.offPolicy += 1;
    row.evLossBb = bumpEv(row.evLossBb, event.evLossBb);
  }
  skills[event.skillKey] = finishSkill(row);
}

function segmentKey(event) {
  return `${event.providerId}@${event.providerVersion}`;
}

function clone(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function emptySegment() {
  return { overall: emptyOverall(), skills: {} };
}

function normalizeSegment(prev) {
  if (!prev) return emptySegment();
  if (prev.overall && prev.skills && typeof prev.skills === 'object' && !Array.isArray(prev.skills)) {
    return { overall: prev.overall, skills: prev.skills };
  }
  const overall = emptyOverall();
  for (const key of Object.keys(overall)) {
    if (prev[key] !== undefined) overall[key] = prev[key];
  }
  return { overall, skills: {} };
}

function isDrill(event) {
  return event.origin === 'drill';
}

function hasGameEventsOf(profile) {
  if (Object.prototype.hasOwnProperty.call(profile, 'hasGameEvents')) {
    return Boolean(profile.hasGameEvents);
  }
  return Object.keys(profile.processed ?? {}).length > 0;
}

export function projectActive(profile) {
  const key = profile.activeSegmentId ?? DEFAULT_ACTIVE_SEGMENT_ID;
  const seg = profile.segments?.[key];
  if (!seg) {
    profile.overall = emptyOverall();
    profile.skills = {};
    profile.leaks = [];
    profile.coverageGaps = [];
    return profile;
  }
  const normalized = normalizeSegment(seg);
  profile.overall = finishOverall({ ...normalized.overall });
  profile.skills = { ...normalized.skills };
  const detected = detectLeaks(profile.skills);
  profile.leaks = detected.leaks;
  profile.coverageGaps = detected.coverageGaps;
  return profile;
}

export function applyEvent(profile, event) {
  assertProfileEvent(event);
  const next = clone(profile);
  next.schemaVersion = PROFILE_SCHEMA_VERSION;
  next.segments = next.segments ?? {};
  next.hasGameEvents = hasGameEventsOf(next);
  next.activeSegmentId = next.activeSegmentId ?? DEFAULT_ACTIVE_SEGMENT_ID;
  const seen = next.processed[event.evaluationId];
  if (seen === event.payloadSha256) return projectActive(next);
  if (seen && seen !== event.payloadSha256) {
    throw coded('PROFILE_EVENT_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
  }
  next.processed[event.evaluationId] = event.payloadSha256;
  const key = segmentKey(event);
  const seg = normalizeSegment(next.segments[key]);
  applyToOverall(seg.overall, event);
  applyToSkill(seg.skills, event);
  seg.overall = finishOverall(seg.overall);
  next.segments[key] = seg;
  if (!isDrill(event)) {
    next.hasGameEvents = true;
    next.activeSegmentId = key;
  } else if (!next.hasGameEvents) {
    next.activeSegmentId = key;
  }
  next.updatedAt = event.appliedAt ?? next.updatedAt;
  return projectActive(next);
}

export function rebuildFromEvents(events) {
  let profile = emptyProfile();
  for (const event of events) profile = applyEvent(profile, event);
  return profile;
}
