import { detectLeaks } from './leak-detector.js';
import { confidenceOf, masteryOf } from './mastery.js';

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
    schemaVersion: 1,
    updatedAt: null,
    processed: {},
    overall: emptyOverall(),
    skills: {},
    leaks: [],
    segments: {},
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
  return `${event.providerId ?? 'unknown'}@${event.providerVersion ?? '0.0.0'}`;
}

function clone(profile) {
  return JSON.parse(JSON.stringify(profile));
}

export function applyEvent(profile, event) {
  const next = clone(profile);
  const seen = next.processed[event.evaluationId];
  if (seen === event.payloadSha256) return next;
  if (seen && seen !== event.payloadSha256) {
    throw coded('PROFILE_EVENT_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
  }
  next.processed[event.evaluationId] = event.payloadSha256;
  applyToOverall(next.overall, event);
  applyToSkill(next.skills, event);
  const seg = next.segments[segmentKey(event)] ?? emptyOverall();
  applyToOverall(seg, event);
  next.segments[segmentKey(event)] = finishOverall(seg);
  next.overall = finishOverall(next.overall);
  next.leaks = detectLeaks(next.skills);
  next.updatedAt = event.appliedAt ?? next.updatedAt;
  return next;
}

export function rebuildFromEvents(events) {
  let profile = emptyProfile();
  for (const event of events) profile = applyEvent(profile, event);
  return profile;
}
